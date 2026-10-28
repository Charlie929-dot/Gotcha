/**
 * 信息链正文 → `events` 镜像（性能方案 P0-2 第一阶段）
 *
 * 为什么要有这一层：`events` 是时间线 / 时刻 / 主题 / 主题向量的地基（都以 events.id 为键）。
 * 信息链（`chain_content`）已经在采集同一块屏幕的正文，但两个库是分开的。要退役旧管线的
 * 「每 2 s 抓帧 + OCR」，必须先让信息链的正文能落到 `events`，读路径才不用改。
 *
 * 三条纪律：
 * 1. **只镜像正文，不改写语义**：一条 `chain_content` → 一条 `events` 行（自增 id），
 *    `ts` 用内容行的 `captured_at`（触发事件那一刻，不因读取慢而漂）；
 *    截图 / 时刻 / 主题仍按原路径读 events，不做任何特殊分支。
 * 2. **长度与隐私口径**：正文超过 `EVENTS_MIRROR_MAX_CHARS` 只镜像前 4k 字符——
 *    完整正文留在 `chain_content`（检索走信息链）。为什么限长：2026-10-28 真实库
 *    chain_content 平均 15.3k 字 / 行、最大 100k；整段镜像会让 events 正文与 trigram
 *    索引按 3× 增长，违背 P0-2「FTS 停止增长」的目标。镜像前先过 `sanitize()`：
 *    命中密码类规则整条不写（与旧管线「整帧丢弃」同口径），其余命中只标 `sensitive=1`。
 * 3. **镜像失败不影响采集**：写 events 抛错只计数 + 记一条 warn；chain_content 已落库，
 *    证据与检索都不受影响。
 *
 * 时间线里镜像行没有 `shot_path`（证据图在 `chain_shot`）：默认 `capture.save_shots=0`，
 * 旧管线本来也不落时间线截图；需要看图走问记忆的引用段。
 */
import { insertEvent, type Db } from '../db'
import type { ContentPayload } from '../chain/recorder'
import { sanitize } from '../understand/sanitize'

/** 镜像进 events 的正文上限（完整正文仍在 chain_content；理由见文件头第 2 条） */
export const EVENTS_MIRROR_MAX_CHARS = 4_000

export interface ChainEventMirrorStats {
  /** 真正写进 events 的行数 */
  written: number
  /** 正文为空（trim 后）跳过 */
  empty: number
  /** 超过上限、只镜像了前缀的行数（仍计入 written） */
  truncated: number
  /** 命中密码类规则整条不写（与旧管线整帧丢弃同口径） */
  sensitive: number
  /** 段行不存在（数据异常；只计数，不抛） */
  missingSegment: number
  /** 写 events 抛错 */
  failed: number
}

export interface ChainEventMirrorOptions {
  db: Db
  /** 正文镜像上限（默认 4000；单测可调小） */
  maxChars?: number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export interface ChainEventMirror {
  /** 一条 `chain_content` 落库后调用；返回是否写进了 events */
  onContent(segmentId: number, capturedAt: number, payload: ContentPayload): boolean
  readonly stats: ChainEventMirrorStats
}

interface SegmentHeaderRow {
  app: string | null
  exe: string | null
  title_first: string | null
  title_last: string | null
}

export function createChainEventMirror(options: ChainEventMirrorOptions): ChainEventMirror {
  const maxChars = Math.max(1, options.maxChars ?? EVENTS_MIRROR_MAX_CHARS)
  const stats: ChainEventMirrorStats = {
    written: 0,
    empty: 0,
    truncated: 0,
    sensitive: 0,
    missingSegment: 0,
    failed: 0
  }
  // 段的 app / title 只在镜像时读一次（内容写入频率是 ~15s/段，不需要缓存）。
  // **懒 prepare**：镜像器在 `ChainRuntime.start()` 之前构造，首次采集时 chain_segment
  // 可能还没建表；等真有一条内容要镜像时 schema 一定已经在（ensureChainSchema 已跑过）。
  let segmentStatement: ReturnType<Db['prepare']> | null = null
  const readSegment = (segmentId: number): SegmentHeaderRow | undefined => {
    if (!segmentStatement) {
      segmentStatement = options.db.prepare(
        'SELECT app, exe, title_first, title_last FROM chain_segment WHERE id = ?'
      )
    }
    return segmentStatement.get(segmentId) as SegmentHeaderRow | undefined
  }

  return {
    onContent(segmentId: number, capturedAt: number, payload: ContentPayload): boolean {
      if (payload.text.trim() === '') {
        stats.empty++
        return false
      }
      const segment = readSegment(segmentId)
      if (!segment) {
        stats.missingSegment++
        options.log?.('warn', 'chain events mirror skipped: segment missing', { segmentId })
        return false
      }
      const checked = sanitize(payload.text)
      if (checked.drop) {
        // 密码类命中不写 events（旧管线也是整帧丢弃）；chain_content 仍保留原文供本地检索
        stats.sensitive++
        return false
      }
      const capped = payload.text.length > maxChars ? payload.text.slice(0, maxChars) : payload.text
      if (capped.length !== payload.text.length) stats.truncated++
      try {
        insertEvent(options.db, {
          ts: capturedAt,
          app: segment.app ?? segment.exe ?? '',
          windowTitle: segment.title_last || segment.title_first || null,
          ocrText: capped,
          sensitive: checked.sensitive ? 1 : 0
        })
        stats.written++
        return true
      } catch (error) {
        stats.failed++
        options.log?.('warn', 'chain events mirror failed', { segmentId, error: String(error) })
        return false
      }
    },
    stats
  }
}
