/**
 * 信息链 · 记录器（把段状态机的动作落到库里）
 *
 * 这一层是「动作 → 表」的唯一通道：段机（`segmenter.ts`）不碰数据库，
 * 记录器不判断采集策略，双方只通过 `ChainAction` 通信。
 *
 * 采图由调用方注入（`takeShot`）：测试里给假的，真实实现接采集管线。
 * 采图返回 `null` 表示这张没拍到——不写行、计入 `droppedShots`，绝不编造元数据。
 *
 * **采图可以是异步的**（v0.5：真实截图要等屏幕流抓一帧，几十到几百毫秒）：
 * 返回 Promise 时先记账（`queuedShots`），按提交顺序串行落库，落定结果进
 * `shotStats`；退出前必须 `drain()`，否则在途那张会丢。异步那张即使晚到，
 * `ts` 用的仍是触发事件的时刻（证据时刻不因抓图慢而漂）。
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
  /** 采图；不给就只记事件、不落截图。可以返回 Promise（真实抓帧就是异步的） */
  takeShot?: ShotTaker
  /** 同一段内与上一条指纹相同的内容是否丢弃（默认丢，省字节） */
  dedupeContent?: boolean
}

export type ShotTaker = (request: ShotRequest) => ShotResult | null | Promise<ShotResult | null>

/** 异步采图的落定账：在途 / 已落行 / 没拍到 / 写库失败 */
export interface ShotStats {
  pending: number
  inserted: number
  dropped: number
  failed: number
}

export interface RecorderOutcome {
  opened: number
  closed: number
  events: number
  shots: number
  contents: number
  /** 采图回调返回 null（没拍到 / 没接采图）的张数 */
  droppedShots: number
  /** 异步采图排进队列、还没落定的张数（结果看 `shotStats`） */
  queuedShots: number
  /** 段收口前没有开着的段等异常情况，正常应为 0 */
  orphans: number
}

function emptyOutcome(): RecorderOutcome {
  return {
    opened: 0,
    closed: 0,
    events: 0,
    shots: 0,
    contents: 0,
    droppedShots: 0,
    queuedShots: 0,
    orphans: 0
  }
}

function isThenable(value: unknown): value is Promise<ShotResult | null> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

export class ChainRecorder {
  private readonly db: ChainDb
  private readonly now: () => number
  private readonly takeShot?: ShotTaker
  private readonly dedupeContent: boolean
  /** 当前开着的段 id（段机保证同一时刻最多一段） */
  private openSegmentId: number | null = null
  /** 异步采图串行队列：保证落库顺序 = 事件顺序 */
  private shotChain: Promise<void> = Promise.resolve()
  private pendingShots = 0
  private readonly settled: Omit<ShotStats, 'pending'> = { inserted: 0, dropped: 0, failed: 0 }

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
          else if (written === 'queued') outcome.queuedShots += 1
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

  /**
   * 按段 id 补写一条内容（v0.6：内容读取比抓帧慢，读回来时段可能已经收口）。
   * 写回**触发那一刻的那一段**，不写进当前开着的段——内容属于它被读的那扇窗的时刻，
   * 不属于「后来切过去的那扇窗」。时刻早于段开始 / 晚于段结束会抛错（由调用方计入失败）。
   */
  recordContentFor(segmentId: number, capturedAt: number, payload: ContentPayload): boolean {
    return this.writeContent(segmentId, capturedAt, payload)
  }

  /** 异步采图的落定账（在途 / 已落行 / 没拍到 / 写库失败） */
  get shotStats(): ShotStats {
    return { pending: this.pendingShots, ...this.settled }
  }

  /**
   * 等所有在途采图落定。退出 / 暂停采集前必须调用，否则最后那张会随进程一起丢。
   * 队列在等待期间可能又长出新任务，所以等到「队列引用不再变化」为止。
   */
  async drain(): Promise<void> {
    let chain = this.shotChain
    for (;;) {
      await chain
      if (chain === this.shotChain) return
      chain = this.shotChain
    }
  }

  private capture(request: ShotRequest): 'shot' | 'dropped' | 'none' | 'queued' {
    if (!this.takeShot) return 'none'
    let result: ShotResult | null | Promise<ShotResult | null>
    try {
      result = this.takeShot(request)
    } catch {
      // 同步抛错等同于「这张没拍到」：不写行、不编造元数据
      return 'dropped'
    }
    if (isThenable(result)) {
      this.pendingShots += 1
      this.shotChain = this.shotChain.then(async () => {
        try {
          const resolved = await result
          if (!resolved) {
            this.settled.dropped += 1
            return
          }
          this.insert(request, resolved)
          this.settled.inserted += 1
        } catch {
          this.settled.failed += 1
        } finally {
          this.pendingShots -= 1
        }
      })
      return 'queued'
    }
    if (!result) return 'dropped'
    this.insert(request, result)
    return 'shot'
  }

  private insert(request: ShotRequest, result: ShotResult): void {
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
