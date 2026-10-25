/**
 * 信息链 · 记录器（把段状态机的动作落到库里）
 *
 * 这一层是「动作 → 表」的唯一通道：段机（`segmenter.ts`）不碰数据库，
 * 记录器不判断采集策略，双方只通过 `ChainAction` 通信。
 *
 * 采图由调用方注入（`takeShot`）：测试里给假的，真实实现接采集管线。
 * 采图返回 `null` 表示这张没拍到——不写行、计入 `droppedShots`，绝不编造元数据。
 */
import type { ChainEventKind, ChainContentSource, ChainShotSource } from './schema'
import type { ChainAction } from './segmenter'
import {
  closeSegment,
  contentHash,
  insertContent,
  insertEvent,
  insertShot,
  openSegment,
  type ChainDb
} from './store'

/** 事件类型 → 截图来源 */
export function shotSourceOf(kind: ChainEventKind): ChainShotSource {
  if (kind === 'enter') return 'enter'
  if (kind === 'typing') return 'typing'
  return 'event'
}

export interface ShotRequest {
  segmentId: number
  eventId: number
  at: number
  kind: ChainEventKind
  source: ChainShotSource
  x: number | null
  y: number | null
  delta: number | null
}

export interface ContentPayload {
  source: ChainContentSource
  text: string
}

export interface ShotResult {
  shot: {
    path: string | null
    width: number | null
    height: number | null
    bytes: number | null
  }
  /** 采图顺带读到的内容（UIA 优先、OCR 兜底由调用方决定） */
  content?: ContentPayload | null
}

export interface ChainRecorderOptions {
  db: ChainDb
  /** 时钟（落 `created_at` 用） */
  now: () => number
  /** 采图；不给就只记事件、不落截图 */
  takeShot?: (request: ShotRequest) => ShotResult | null
  /** 同一段内与上一条指纹相同的内容是否丢弃（默认丢，省字节） */
  dedupeContent?: boolean
}

export interface RecorderOutcome {
  opened: number
  closed: number
  events: number
  shots: number
  contents: number
  /** 采图回调返回 null（没拍到 / 没接采图）的张数 */
  droppedShots: number
  /** 段收口前没有开着的段等异常情况，正常应为 0 */
  orphans: number
}

function emptyOutcome(): RecorderOutcome {
  return { opened: 0, closed: 0, events: 0, shots: 0, contents: 0, droppedShots: 0, orphans: 0 }
}

export class ChainRecorder {
  private readonly db: ChainDb
  private readonly now: () => number
  private readonly takeShot?: (request: ShotRequest) => ShotResult | null
  private readonly dedupeContent: boolean
  /** 当前开着的段 id（段机保证同一时刻最多一段） */
  private openSegmentId: number | null = null

  constructor(options: ChainRecorderOptions) {
    this.db = options.db
    this.now = options.now
    this.takeShot = options.takeShot
    this.dedupeContent = options.dedupeContent ?? true
  }

  get currentSegmentId(): number | null {
    return this.openSegmentId
  }

  apply(actions: readonly ChainAction[]): RecorderOutcome {
    const outcome = emptyOutcome()
    for (const action of actions) {
      switch (action.type) {
        case 'segment-opened': {
          this.openSegmentId = openSegment(this.db, action.segment, this.now())
          outcome.opened += 1
          break
        }
        case 'event': {
          if (this.openSegmentId === null) {
            outcome.orphans += 1
            break
          }
          const eventId = insertEvent(this.db, {
            segmentId: this.openSegmentId,
            ts: action.at,
            kind: action.kind,
            x: action.x,
            y: action.y,
            delta: action.delta
          })
          outcome.events += 1
          if (!action.capture) break
          const written = this.capture({
            segmentId: this.openSegmentId,
            eventId,
            at: action.at,
            kind: action.kind,
            source: shotSourceOf(action.kind),
            x: action.x,
            y: action.y,
            delta: action.delta
          })
          if (written === 'shot') outcome.shots += 1
          else if (written === 'dropped') outcome.droppedShots += 1
          break
        }
        case 'segment-closed': {
          if (this.openSegmentId === null) {
            outcome.orphans += 1
            break
          }
          closeSegment(this.db, this.openSegmentId, action.segment)
          this.openSegmentId = null
          outcome.closed += 1
          break
        }
        case 'idle-start':
        case 'idle-end':
          // 空闲只是时间轴上的标记，不落表（契约 D39）
          break
      }
    }
    return outcome
  }

  /** 外部（比如打字过程中定时刷新）补写一条内容；没有开着的段就丢弃 */
  recordContent(payload: ContentPayload, capturedAt: number): boolean {
    if (this.openSegmentId === null) return false
    const written = this.writeContent(this.openSegmentId, capturedAt, payload)
    return written
  }

  private capture(request: ShotRequest): 'shot' | 'dropped' | 'none' {
    if (!this.takeShot) return 'none'
    const result = this.takeShot(request)
    if (!result) return 'dropped'
    insertShot(this.db, {
      segmentId: request.segmentId,
      eventId: request.eventId,
      ts: request.at,
      path: result.shot.path,
      width: result.shot.width,
      height: result.shot.height,
      bytes: result.shot.bytes,
      source: request.source
    })
    if (result.content) this.writeContent(request.segmentId, request.at, result.content)
    return 'shot'
  }

  private writeContent(segmentId: number, capturedAt: number, payload: ContentPayload): boolean {
    if (payload.text.trim() === '') return false
    if (!this.dedupeContent) {
      insertContent(this.db, { segmentId, capturedAt, source: payload.source, text: payload.text })
      return true
    }
    const last = this.db
      .prepare('SELECT hash FROM chain_content WHERE segment_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1')
      .get(segmentId) as { hash: string } | undefined
    const hash = contentHash(payload.text)
    if (last && last.hash === hash) return false
    insertContent(this.db, { segmentId, capturedAt, source: payload.source, text: payload.text, hash })
    return true
  }
}
