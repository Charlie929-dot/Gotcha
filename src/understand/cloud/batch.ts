/**
 * 归纳取批（M2 Phase 1；m2-plan §3 Phase 1）
 *
 * - 游标 `(ts, id)`：只取「ts > cursor_ts」或「同 ts 且 id > cursor_id」的事件；
 * - 批窗口：ts <= now - 5min（留出相邻事件合并窗口），避免把「正在发生」的片段切碎；
 * - 合并：同一 `app + 窗口标题`、相邻 ≤ 90s 的事件合并为一个「时刻」，OCR 摘要去重拼接；
 * - 单批最多 20 个时刻；单时刻最多回显 40 个事件 id，整批最多回显 400 个 id
 *   （输出必须列举全部 id，超限确定性切分 / 留给下一批，避免输出截断后同批反复卡住；F04）；
 *   未进批的事件留在库里，游标只推进到已消费的最后一个事件。
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
  options: {
    maxMoments?: number
    gapMs?: number
    maxEventIdsPerMoment?: number
    maxEventIds?: number
  } = {}
): ReadBatchResult {
  const maxMoments = options.maxMoments ?? LLM_DEFAULTS.maxMoments
  const gapMs = options.gapMs ?? LLM_DEFAULTS.mergeGapMs
  const maxEventIdsPerMoment = Math.max(1, options.maxEventIdsPerMoment ?? LLM_DEFAULTS.maxEventIdsPerMoment)
  const maxEventIds = Math.max(1, options.maxEventIds ?? LLM_DEFAULTS.batchMaxEventIds)
  const moments: Moment[] = []
  let consumedCount = 0
  /** 已进批的事件 id 数：输出必须全部回显，整批到顶就停，未消费事件留给下一批（F04） */
  let batchEventIds = 0

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
      current !== null &&
      current.app === app &&
      current.title === title &&
      event.ts - current.endTs <= gapMs &&
      // 单个时刻回显 id 到顶就切开：同一 app/标题的长会话拆成多个相邻时刻（F04）
      current.eventIds.length < maxEventIdsPerMoment
    if (mergeable && current) {
      // 整批 id 到顶：当前时刻保持已合并部分，未消费事件留给下一批
      if (batchEventIds + 1 > maxEventIds) break
      current.endTs = Math.max(current.endTs, event.ts)
      current.eventIds.push(event.id)
      // OCR 摘要去重：完全相同或已被已有片段包含则不重复拼（后续出云时统一截断）
      if (ocr !== '' && !current.ocrParts.some((part) => part.includes(ocr))) {
        current.ocrParts.push(ocr)
      }
      current.sensitive = current.sensitive || event.sensitive === 1
      batchEventIds += 1
      continue
    }
    close()
    if (moments.length >= maxMoments) break
    if (batchEventIds + 1 > maxEventIds) break
    current = {
      app,
      title,
      startTs: event.ts,
      endTs: event.ts,
      ocrParts: ocr === '' ? [] : [ocr],
      eventIds: [event.id],
      sensitive: event.sensitive === 1
    }
    batchEventIds += 1
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

/* ------------------------------------------------------------------ *
 * 按本地日取批（D28）
 *
 * 归纳不再从旧游标一路补历史：自动只跑今天，手动只跑图谱当前查看日。
 * 已归纳事件以节点 `source_events` 为准过滤，重复点击只处理剩余事件。
 * ------------------------------------------------------------------ */

/** 本地日 00:00:00.000 的时间戳（与图谱 / 时间线的日期窗口一致） */
export function startOfLocalDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 下一个本地日 00:00:00.000 的时间戳 */
export function nextLocalDayStart(ts: number): number {
  const date = new Date(ts)
  date.setDate(date.getDate() + 1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function parseSourceEventIds(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
      : []
  } catch {
    return []
  }
}

/**
 * 某天已被节点覆盖的事件 id（含敏感占位节点）。
 * 只查 ts 区间与当天相交的节点，避免全表扫描。
 */
export function readInducedEventIds(db: Db, from: number, to: number): Set<number> {
  const rows = db
    .prepare(
      'SELECT source_events FROM nodes WHERE level = 1 AND ts_start IS NOT NULL AND ts_end IS NOT NULL AND ts_end >= ? AND ts_start <= ?'
    )
    .all(from, to) as Array<{ source_events: string | null }>
  const ids = new Set<number>()
  for (const row of rows) {
    for (const id of parseSourceEventIds(row.source_events)) ids.add(id)
  }
  return ids
}

/** 按本地日读取原始事件（ts 升序）；默认上限 2 万条，防单日异常数据一次拉爆内存 */
export function selectDayEvents(
  db: Db,
  from: number,
  to: number,
  options: { limit?: number } = {}
): BatchEvent[] {
  if (to < from) return []
  return db
    .prepare(
      `SELECT id, ts, app, window_title, ocr_text, sensitive
       FROM events
       WHERE ts >= ? AND ts <= ?
       ORDER BY ts ASC, id ASC
       LIMIT ?`
    )
    .all(from, to, options.limit ?? 20_000) as BatchEvent[]
}

export interface ReadDayBatchOptions {
  maxMoments?: number
  /** 单日原始事件读取上限（默认 2 万） */
  limit?: number
}

/**
 * 按天取一批：只返回该天尚未被节点覆盖的事件。
 * - 自动归纳传今天；手动归纳传当前查看日；
 * - 已归纳事件（含占位）跳过，因此重复点击是幂等的，不会重复出云；
 * - 不推进旧游标（`graph.cursor_*` 仅保留兼容，不再驱动归纳）。
 */
export function readDayBatch(
  db: Db,
  from: number,
  to: number,
  options: ReadDayBatchOptions = {}
): ReadBatchResult {
  const events = selectDayEvents(db, from, to, { limit: options.limit })
  if (events.length === 0) return { moments: [], consumed: [] }
  const induced = readInducedEventIds(db, from, to)
  const uninduced = induced.size === 0 ? events : events.filter((event) => !induced.has(event.id))
  return mergeMoments(uninduced, { maxMoments: options.maxMoments })
}
