/**
 * 归纳取批（M2 Phase 1；m2-plan §3 Phase 1）
 *
 * - 游标 `(ts, id)`：只取「ts > cursor_ts」或「同 ts 且 id > cursor_id」的事件；
 * - 批窗口：ts <= now - 5min（留出相邻事件合并窗口），避免把「正在发生」的片段切碎；
 * - 合并：同一 `app + 窗口标题`、相邻 ≤ 90s 的事件合并为一个「时刻」，OCR 摘要去重拼接；
 * - 单批最多 20 个时刻；未进批的事件留在库里，游标只推进到已消费的最后一个事件。
 */

import type { Db } from '../../db'
import { getSetting, setSetting } from '../../db/settings'
import { LLM_DEFAULTS } from './constants'

export interface BatchEvent {
  id: number
  ts: number
  app: string
  window_title: string | null
  ocr_text: string | null
  sensitive: number
}

/** 一个「时刻」：同 app+标题的相邻事件合并，eventIds 用于回溯 source_events */
export interface Moment {
  app: string
  title: string
  startTs: number
  endTs: number
  ocr: string
  eventIds: number[]
  sensitive: boolean
}

export interface BatchCursor {
  ts: number
  id: number
}

export const CURSOR_KEYS = {
  ts: 'graph.cursor_ts',
  id: 'graph.cursor_id'
} as const

export interface ReadBatchResult {
  moments: Moment[]
  /** 已进批的事件（按 ts,id 升序；最后一个即新游标） */
  consumed: BatchEvent[]
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/** 读游标；未设置视为 (0, 0)（从头开始，正常情况下 events 从 1 开始） */
export function readCursor(db: Db): BatchCursor {
  const ts = Number(getSetting(db, CURSOR_KEYS.ts))
  const id = Number(getSetting(db, CURSOR_KEYS.id))
  return { ts: Number.isFinite(ts) ? ts : 0, id: Number.isFinite(id) ? id : 0 }
}

/** 写游标（由落库事务调用，与节点/边写入同一事务） */
export function writeCursor(db: Db, cursor: BatchCursor): void {
  setSetting(db, CURSOR_KEYS.ts, String(cursor.ts))
  setSetting(db, CURSOR_KEYS.id, String(cursor.id))
}

/** 按游标取批事件（ts 升序、同 ts 按 id 升序；最多 batchEventLimit 条） */
export function selectBatchEvents(
  db: Db,
  cursor: BatchCursor,
  now: number,
  options: { lagMs?: number; limit?: number } = {}
): BatchEvent[] {
  const cutoff = now - (options.lagMs ?? LLM_DEFAULTS.batchLagMs)
  if (cutoff < cursor.ts) return []
  return db
    .prepare(
      `SELECT id, ts, app, window_title, ocr_text, sensitive
       FROM events
       WHERE (ts > ? OR (ts = ? AND id > ?)) AND ts <= ?
       ORDER BY ts ASC, id ASC
       LIMIT ?`
    )
    .all(cursor.ts, cursor.ts, cursor.id, cutoff, options.limit ?? LLM_DEFAULTS.batchEventLimit) as BatchEvent[]
}

/**
 * 把事件合并为「时刻」：同一 app + 标题、与前一个事件间隔 ≤ 90s 才合并；
 * 中间插入别的 app/标题即收束当前时刻（不回头重开，保持「相邻」语义）。
 */
export function mergeMoments(
  events: readonly BatchEvent[],
  options: { maxMoments?: number; gapMs?: number } = {}
): ReadBatchResult {
  const maxMoments = options.maxMoments ?? LLM_DEFAULTS.maxMoments
  const gapMs = options.gapMs ?? LLM_DEFAULTS.mergeGapMs
  const moments: Moment[] = []
  let consumedCount = 0

  interface Draft {
    app: string
    title: string
    startTs: number
    endTs: number
    ocrParts: string[]
    eventIds: number[]
    sensitive: boolean
  }
  let current: Draft | null = null

  const close = (): void => {
    if (!current) return
    moments.push({
      app: current.app,
      title: current.title,
      startTs: current.startTs,
      endTs: current.endTs,
      ocr: current.ocrParts.join(' / '),
      eventIds: current.eventIds,
      sensitive: current.sensitive
    })
    consumedCount += current.eventIds.length
    current = null
  }

  for (const event of events) {
    if (moments.length >= maxMoments) break
    const app = normalize(event.app)
    const title = normalize(event.window_title)
    const ocr = normalize(event.ocr_text)
    const mergeable =
      current !== null && current.app === app && current.title === title && event.ts - current.endTs <= gapMs
    if (mergeable && current) {
      current.endTs = Math.max(current.endTs, event.ts)
      current.eventIds.push(event.id)
      // OCR 摘要去重：完全相同或已被已有片段包含则不重复拼（后续出云时统一截断）
      if (ocr !== '' && !current.ocrParts.some((part) => part.includes(ocr))) {
        current.ocrParts.push(ocr)
      }
      current.sensitive = current.sensitive || event.sensitive === 1
      continue
    }
    close()
    if (moments.length >= maxMoments) break
    current = {
      app,
      title,
      startTs: event.ts,
      endTs: event.ts,
      ocrParts: ocr === '' ? [] : [ocr],
      eventIds: [event.id],
      sensitive: event.sensitive === 1
    }
  }
  close()

  return { moments, consumed: events.slice(0, consumedCount) }
}

/** 取一批（读库 + 合并）；无新事件返回空 moments。maxMoments 可由 settings 覆盖（D22） */
export function readBatch(db: Db, now: number, options: { maxMoments?: number } = {}): ReadBatchResult {
  const cursor = readCursor(db)
  const events = selectBatchEvents(db, cursor, now)
  return mergeMoments(events, { maxMoments: options.maxMoments })
}
