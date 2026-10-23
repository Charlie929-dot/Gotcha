/**
 * 时刻（moments）分组与回填（docs/m2-graph-redesign.md §4.1 / §4.5）
 *
 * - 分组口径沿用归纳取批 `cloud/batch.ts`：同 `app + 窗口标题`、相邻 ≤90s 合并；
 *   **额外约束**：时刻不跨本地日（`day_key` 唯一，日历按天筛选）；
 * - `ocr_summary` 去重拼接后截断；原始事件仍是 L0 事实源，不因时刻/主题改写；
 * - 回填幂等：以 `(day_key, start_ts, event_ids)` 判定同一时刻，重复跑只补新增，
 *   不删除、不改写已有时刻（避免 `theme_moments` 断链）。
 */

import type { Db } from '../db'
import { nextLocalDayStart, startOfLocalDay } from './cloud/batch'

/** 同一时刻允许的事件间隔（与 batch.ts 的 mergeGapMs 对齐） */
export const MOMENT_MERGE_GAP_MS = 90_000

/** 时刻 OCR 摘要上限（去重拼接后截断；原始事件不受影响） */
export const MOMENT_OCR_SUMMARY_MAX = 500

/** 回填单次最多处理的本地日数（防异常时间戳让循环失控） */
export const MOMENT_BACKFILL_MAX_DAYS = 400

/** 与 batch.ts 一致的文本归一：压缩空白 */
function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期键 `yyyy-mm-dd`（与时区一致，不用 UTC，避免跨日错位） */
export function localDayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 分组输入的事件（只取分组需要的列） */
export interface MomentEvent {
  id: number
  ts: number
  app: string
  window_title: string | null
  ocr_text: string | null
  sensitive?: number
}

/** 一个已分组的时刻（尚未落库，没有 id） */
export interface GroupedMoment {
  app: string
  title: string
  startTs: number
  endTs: number
  dayKey: string
  ocrSummary: string
  eventIds: number[]
  sensitive: boolean
}

export interface GroupMomentsOptions {
  gapMs?: number
  ocrSummaryMax?: number
}

/**
 * 把事件按本地日 + app/标题 + 相邻 ≤90s 分组成时刻。
 * 输入按 `ts,id` 升序时结果确定；跨本地日、中间插入别的 app/标题都会收束当前时刻。
 */
export function groupMoments(
  events: readonly MomentEvent[],
  options: GroupMomentsOptions = {}
): GroupedMoment[] {
  const gapMs = options.gapMs ?? MOMENT_MERGE_GAP_MS
  const ocrSummaryMax = Math.max(1, options.ocrSummaryMax ?? MOMENT_OCR_SUMMARY_MAX)
  const moments: GroupedMoment[] = []

  interface Draft {
    app: string
    title: string
    startTs: number
    endTs: number
    dayKey: string
    ocrParts: string[]
    eventIds: number[]
    sensitive: boolean
  }
  let current: Draft | null = null

  const close = (): void => {
    if (!current) return
    const summary = current.ocrParts.join(' / ')
    moments.push({
      app: current.app,
      title: current.title,
      startTs: current.startTs,
      endTs: current.endTs,
      dayKey: current.dayKey,
      ocrSummary: summary.length > ocrSummaryMax ? summary.slice(0, ocrSummaryMax) : summary,
      eventIds: current.eventIds,
      sensitive: current.sensitive
    })
    current = null
  }

  for (const event of events) {
    const app = normalize(event.app)
    const title = normalize(event.window_title)
    const ocr = normalize(event.ocr_text)
    const dayKey = localDayKey(event.ts)
    const mergeable =
      current !== null &&
      current.app === app &&
      current.title === title &&
      current.dayKey === dayKey &&
      event.ts - current.endTs <= gapMs
    if (mergeable && current) {
      current.endTs = Math.max(current.endTs, event.ts)
      current.eventIds.push(event.id)
      // 去重：完全相同或已被已有片段包含的不重复拼
      if (ocr !== '' && !current.ocrParts.some((part) => part.includes(ocr))) {
        current.ocrParts.push(ocr)
      }
      current.sensitive = current.sensitive || event.sensitive === 1
      continue
    }
    close()
    current = {
      app,
      title,
      startTs: event.ts,
      endTs: event.ts,
      dayKey,
      ocrParts: ocr === '' ? [] : [ocr],
      eventIds: [event.id],
      sensitive: event.sensitive === 1
    }
  }
  close()

  return moments
}

export interface MomentDayBackfillResult {
  dayKey: string
  /** 当天读到的原始事件数 */
  events: number
  /** 新写入的时刻数 */
  created: number
  /** 已存在（同 day_key/start_ts/event_ids）而跳过的时刻数 */
  existing: number
}

export interface MomentBackfillOptions {
  /** 写入 created_at 的时间；用例注入固定值，避免依赖当前时间 */
  now?: number
  /** 单日最多处理天数（默认 MOMENT_BACKFILL_MAX_DAYS） */
  maxDays?: number
  /** 只回填 ts 落在 [from, to] 的事件（缺省按库内 events 的最早/最晚时刻） */
  from?: number
  to?: number
}

export interface MomentBackfillResult {
  days: number
  events: number
  created: number
  existing: number
  /** 是否因 maxDays 上限提前停止（仍有未回填的日） */
  truncated: boolean
}

function selectDayEvents(db: Db, from: number, to: number): MomentEvent[] {
  return db
    .prepare(
      `SELECT id, ts, app, window_title, ocr_text, sensitive
       FROM events
       WHERE ts >= ? AND ts < ?
       ORDER BY ts ASC, id ASC`
    )
    .all(from, to) as MomentEvent[]
}

const FIND_EXISTING_SQL = `
  SELECT id FROM moments WHERE day_key = ? AND start_ts = ? AND event_ids = ?
`

const INSERT_MOMENT_SQL = `
  INSERT INTO moments (start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`

/**
 * 回填某个本地日的时刻（幂等）。
 * 区间为左闭右开 `[dayStart, nextDayStart)`，避免 23:59:59.999 与次日 00:00 重复计入。
 */
export function backfillMomentsForDay(
  db: Db,
  dayStart: number,
  nextDayStart: number,
  options: { now?: number } = {}
): MomentDayBackfillResult {
  const dayKey = localDayKey(dayStart)
  const now = options.now ?? Date.now()
  const events = selectDayEvents(db, dayStart, nextDayStart)
  const groups = groupMoments(events)

  const findExisting = db.prepare(FIND_EXISTING_SQL)
  const insert = db.prepare(INSERT_MOMENT_SQL)
  let created = 0
  let existing = 0
  const run = db.transaction(() => {
    for (const group of groups) {
      const eventIds = JSON.stringify(group.eventIds)
      const found = findExisting.get(dayKey, group.startTs, eventIds) as { id: number } | undefined
      if (found) {
        existing += 1
        continue
      }
      insert.run(
        group.startTs,
        group.endTs,
        dayKey,
        group.app,
        group.title,
        group.ocrSummary,
        eventIds,
        now
      )
      created += 1
    }
  })
  run()

  return { dayKey, events: events.length, created, existing }
}

/** 取事件时间范围（没有事件返回 null） */
export function eventTimeRange(db: Db): { min: number; max: number } | null {
  const row = db
    .prepare('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM events')
    .get() as { minTs: number | null; maxTs: number | null }
  if (typeof row.minTs !== 'number' || typeof row.maxTs !== 'number') return null
  return { min: row.minTs, max: row.maxTs }
}

/**
 * 回填全部（或指定区间）时刻；按本地日逐天分组，逐日事务提交。
 * 事件是追加写的，重复执行只补新增时刻；`maxDays` 防止异常时间戳导致长循环。
 */
export function backfillAllMoments(
  db: Db,
  options: MomentBackfillOptions = {}
): MomentBackfillResult {
  const maxDays = Math.max(1, options.maxDays ?? MOMENT_BACKFILL_MAX_DAYS)
  const now = options.now ?? Date.now()

  let from = options.from
  let to = options.to
  if (from === undefined || to === undefined) {
    const range = eventTimeRange(db)
    if (!range) return { days: 0, events: 0, created: 0, existing: 0, truncated: false }
    from = from ?? range.min
    to = to ?? range.max
  }
  if (to < from) return { days: 0, events: 0, created: 0, existing: 0, truncated: false }

  const result: MomentBackfillResult = {
    days: 0,
    events: 0,
    created: 0,
    existing: 0,
    truncated: false
  }

  let cursor = startOfLocalDay(from)
  const lastDay = startOfLocalDay(to)
  while (cursor <= lastDay) {
    if (result.days >= maxDays) {
      result.truncated = true
      break
    }
    const next = nextLocalDayStart(cursor)
    const day = backfillMomentsForDay(db, cursor, next, { now })
    result.days += 1
    result.events += day.events
    result.created += day.created
    result.existing += day.existing
    cursor = next
  }

  return result
}
