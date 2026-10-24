/**
 * 门一「问」检索 v1（D31 / `docs/memory-orb-design-proposal.md` §3）
 *
 * 口径：
 * - 索引作用于 **L0 全部事件**（`events_fts` 见 `db/schema.ts`），未归纳不等于不可找回；
 *   检索只读 `events` / `events_fts` / `moments`，不依赖 `nodes` / `edges` / 归纳状态；
 * - 中文双路：词长 ≥3 字走 trigram MATCH（快、有排序）；任一词 <3 字走 LIKE 兜底
 *   （trigram 最小 3 字符，两字词 MATCH 恒不命中——见提案附录 A）；
 * - 过滤：app（精确）/ 窗口标题（包含，忽略大小写）/ 时间窗（闭区间），全部落在现成字段；
 * - 结果按「时刻」归并成卡片：命中事件若落在 `moments` 行区间内就复用该时刻（id、起止、
 *   摘要、下钻面板、图谱节点全复用），否则按与 `moments.ts` 相同的口径就地成组；
 * - 片段由**原始 OCR** 现算（`snippet()` 读的是归一化文本，英文会连成一片），
 *   中文词内空格在展示层合并，命中不定位高亮（v1 明确不做，提案 §3.3）。
 */

import type { Db } from '../db'
import { normalizeOcrSql } from '../db/schema'
import type { NodeEventDto, NodeEventsResult } from './graph-query'
import { queryMomentEvents } from './graph-query'
import { localDayKey } from './moments'

/** 查询至少 2 个字符（单字太泛，等于全库扫） */
export const SEARCH_MIN_QUERY_CHARS = 2

/** trigram 分词最小 3 字符：短于它的词只能走 LIKE */
export const SEARCH_MATCH_MIN_TERM_CHARS = 3

/** 单次检索最多取多少条命中事件（超出标 `truncated`） */
export const SEARCH_EVENT_LIMIT = 300

/** 最多返回多少张时刻卡片 */
export const SEARCH_CARD_LIMIT = 50

/** 片段最大展示长度（字符） */
export const SEARCH_SNIPPET_MAX = 120

/** 卡片归并口径：与 `moments.ts` 的时刻分组一致（同 app + 标题、相邻 ≤90s、不跨日） */
export const SEARCH_CLUSTER_GAP_MS = 90_000

export type SearchMode = 'match' | 'like' | 'empty'

export interface SearchInput {
  query: string
  /** 精确匹配 `events.app`；空 / 缺省为不过滤 */
  app?: string | null
  /** `events.window_title` 包含（忽略大小写）；空 / 缺省为不过滤 */
  titleContains?: string | null
  /** 时间窗起点（epoch ms，闭区间） */
  fromTs?: number | null
  /** 时间窗终点（epoch ms，闭区间） */
  toTs?: number | null
}

export interface SearchHitDto {
  startTs: number
  endTs: number
  dayKey: string
  app: string
  windowTitle: string | null
  /** 命中的时刻行 `ocr_summary`（未归纳 / 未成时刻时为 null） */
  ocrSummary: string | null
  /** 展示用片段（来自原始 OCR，带省略号） */
  snippet: string
  /** 这段里命中的事件数 */
  matchedEvents: number
  /** 命中事件 id（升序）；供测试与调试 */
  eventIds: number[]
  /** 命中事件所在的时刻 id；没有对应时刻时为 null */
  momentId: number | null
}

export interface SearchResult {
  /** 归一化后的查询串（词间单空格） */
  query: string
  mode: SearchMode
  hits: SearchHitDto[]
  /** 命中事件总数（受 `SEARCH_EVENT_LIMIT` 截断） */
  matchedEvents: number
  /** 命中事件是否被上限截断 */
  truncated: boolean
}

export interface SearchHitEventsInput {
  momentId?: number | null
  app: string
  windowTitle?: string | null
  startTs: number
  endTs: number
}

interface HitRow {
  id: number
  ts: number
  app: string
  window_title: string | null
  ocr_text: string | null
  rank: number
}

interface MomentRow {
  id: number
  start_ts: number
  end_ts: number
  day_key: string
  app: string | null
  window_title: string | null
  ocr_summary: string | null
}

interface CardDraft {
  key: string
  momentId: number | null
  startTs: number
  endTs: number
  dayKey: string
  app: string
  windowTitle: string | null
  ocrSummary: string | null
  bestRank: number
  rows: HitRow[]
}

/** 字符数（按 code point 计，emoji / 代理对算 1） */
export function countQueryChars(value: string): number {
  return [...value].length
}

/**
 * 查询归一化：先把「中文之间的空格」合并（OCR 逐字断词、用户也可能直接粘贴
 * 「图 谱 设 计」），再按剩余空白切词、词内残余空白一律去掉——与索引侧
 * `normalizeOcrSql` 同口径。
 */
export function splitQueryTerms(raw: string): string[] {
  const merged = (raw ?? '')
    .replace(
      /([\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f])\s+(?=[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f])/g,
      '$1'
    )
    .replace(/\s+/g, ' ')
    .trim()
  return merged
    .split(' ')
    .map((term) => term.replace(/[\s\u3000\u00a0]+/g, ''))
    .filter((term) => term !== '')
}

/** 查询分类：`empty`（不搜）/ `match`（全部词 ≥3 字）/ `like`（含短词，走兜底） */
export function classifyQuery(raw: string): { query: string; terms: string[]; mode: SearchMode } {
  const terms = splitQueryTerms(raw ?? '')
  const query = terms.join(' ')
  const total = terms.reduce((sum, term) => sum + countQueryChars(term), 0)
  if (total < SEARCH_MIN_QUERY_CHARS) return { query, terms, mode: 'empty' }
  const mode: SearchMode = terms.every(
    (term) => countQueryChars(term) >= SEARCH_MATCH_MIN_TERM_CHARS
  )
    ? 'match'
    : 'like'
  return { query, terms, mode }
}

/** FTS5 短语：整词当字面量，内部引号按 FTS5 规则双写（防注入 / 语法错误） */
export function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/** LIKE 模式转义（配合 `ESCAPE '\'`），`%` `_` 与反斜杠按字面匹配 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

/** 展示用 OCR 归一：中文之间的空格去掉（OCR 逐字断词），其余空白压成单空格 */
export function displayOcrText(raw: string): string {
  return raw
    .replace(/([\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f])\s+(?=[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从原始 OCR 里截一段包含命中词的上下文（v1 不做高亮定位，提案 §3.3） */
export function buildSnippet(
  raw: string | null | undefined,
  terms: readonly string[],
  max = SEARCH_SNIPPET_MAX
): string {
  const text = displayOcrText(raw ?? '')
  if (text === '') return ''
  if (text.length <= max) return text

  const haystack = text.toLowerCase()
  let index = -1
  let length = 0
  for (const term of terms) {
    const found = haystack.indexOf(term.toLowerCase())
    if (found >= 0 && (index < 0 || found < index)) {
      index = found
      length = term.length
    }
  }
  if (index < 0) return `${text.slice(0, max)}…`

  const pad = Math.max(0, Math.floor((max - length) / 2))
  const start = Math.max(0, index - pad)
  const end = Math.min(text.length, start + max)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return `${head}${text.slice(start, end)}${tail}`
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 与 moments.ts 一致的归一（压缩空白 + trim），只用于比较 app / 标题 */
function normalizeLabel(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function labelKey(app: string | null | undefined, title: string | null | undefined): string {
  return `${normalizeLabel(app)}\u0000${normalizeLabel(title)}`
}

function emptyResult(query: string, mode: SearchMode): SearchResult {
  return { query, mode, hits: [], matchedEvents: 0, truncated: false }
}

/** 过滤子句（两条路径共用；命名参数缺省为 NULL 时不生效） */
const FILTER_SQL = `
  AND (@fromTs IS NULL OR e.ts >= @fromTs)
  AND (@toTs IS NULL OR e.ts <= @toTs)
  AND (@app IS NULL OR e.app = @app)
  AND (@titleLike IS NULL OR e.window_title LIKE @titleLike ESCAPE '\\')
`

function selectByMatch(
  db: Db,
  terms: readonly string[],
  filterParams: Record<string, unknown>
): HitRow[] {
  const match = terms.map(ftsPhrase).join(' AND ')
  return db
    .prepare(
      `SELECT e.id, e.ts, e.app, e.window_title, e.ocr_text, bm25(events_fts) AS rank
       FROM events_fts JOIN events e ON e.id = events_fts.rowid
       WHERE events_fts MATCH @match
       ${FILTER_SQL}
       ORDER BY rank ASC, e.ts DESC
       LIMIT @limit`
    )
    .all({ ...filterParams, match, limit: SEARCH_EVENT_LIMIT }) as HitRow[]
}

function selectByLike(db: Db, terms: readonly string[], filterParams: Record<string, unknown>): HitRow[] {
  const likeSql = terms
    .map((_, index) => `events_fts.ocr_text LIKE @like${index} ESCAPE '\\'`)
    .join(' AND ')
  const params: Record<string, unknown> = { ...filterParams, limit: SEARCH_EVENT_LIMIT }
  terms.forEach((term, index) => {
    params[`like${index}`] = `%${escapeLikePattern(term)}%`
  })
  return db
    .prepare(
      `SELECT e.id, e.ts, e.app, e.window_title, e.ocr_text, 0 AS rank
       FROM events_fts JOIN events e ON e.id = events_fts.rowid
       WHERE ${likeSql}
       ${FILTER_SQL}
       ORDER BY e.ts DESC
       LIMIT @limit`
    )
    .all(params) as HitRow[]
}

/** 取查询涉及日期的时刻行（一次 IN，避免逐条回查） */
function loadMoments(db: Db, dayKeys: readonly string[]): Map<string, Map<string, MomentRow[]>> {
  const byDay = new Map<string, Map<string, MomentRow[]>>()
  if (dayKeys.length === 0) return byDay
  const placeholders = dayKeys.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, start_ts, end_ts, day_key, app, window_title, ocr_summary
       FROM moments WHERE day_key IN (${placeholders})
       ORDER BY start_ts ASC, id ASC`
    )
    .all(...dayKeys) as MomentRow[]
  for (const row of rows) {
    let byLabel = byDay.get(row.day_key)
    if (!byLabel) {
      byLabel = new Map<string, MomentRow[]>()
      byDay.set(row.day_key, byLabel)
    }
    const key = labelKey(row.app, row.window_title)
    const list = byLabel.get(key)
    if (list) list.push(row)
    else byLabel.set(key, [row])
  }
  return byDay
}

function findMoment(
  index: Map<string, Map<string, MomentRow[]>>,
  dayKey: string,
  row: HitRow
): MomentRow | null {
  const list = index.get(dayKey)?.get(labelKey(row.app, row.window_title))
  if (!list) return null
  for (const moment of list) {
    if (moment.start_ts <= row.ts && row.ts <= moment.end_ts) return moment
  }
  return null
}

function pickSnippetRow(rows: readonly HitRow[], terms: readonly string[]): HitRow {
  for (const row of rows) {
    const text = displayOcrText(row.ocr_text ?? '').toLowerCase()
    if (terms.some((term) => text.includes(term.toLowerCase()))) return row
  }
  return rows[0]
}

/**
 * 把命中事件归并成时刻卡片。
 * - 事件落在 `moments` 区间内 → 复用该时刻（字段以时刻行为准，带 `momentId`）；
 * - 否则按 `moments.ts` 口径（同 app + 标题、相邻 ≤90s、不跨日）就地成组。
 */
function buildCards(db: Db, rows: readonly HitRow[], terms: readonly string[], mode: SearchMode): SearchHitDto[] {
  const sorted = [...rows].sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts - b.ts))
  const dayKeys = [...new Set(sorted.map((row) => localDayKey(row.ts)))]
  const momentIndex = loadMoments(db, dayKeys)

  const cards = new Map<string, CardDraft>()
  const openCluster = new Map<string, CardDraft>()
  let clusterSeq = 0

  for (const row of sorted) {
    const dayKey = localDayKey(row.ts)
    const moment = findMoment(momentIndex, dayKey, row)
    if (moment) {
      const key = `m:${moment.id}`
      const existing = cards.get(key)
      if (existing) {
        existing.endTs = Math.max(existing.endTs, row.ts)
        existing.bestRank = Math.min(existing.bestRank, row.rank)
        existing.rows.push(row)
      } else {
        const draft: CardDraft = {
          key,
          momentId: moment.id,
          startTs: moment.start_ts,
          endTs: moment.end_ts,
          dayKey: moment.day_key,
          app: moment.app ?? normalizeLabel(row.app),
          windowTitle: moment.window_title,
          ocrSummary: moment.ocr_summary,
          bestRank: row.rank,
          rows: [row]
        }
        cards.set(key, draft)
      }
      continue
    }

    const clusterKey = `${dayKey}|${labelKey(row.app, row.window_title)}`
    const open = openCluster.get(clusterKey)
    if (open && row.ts - open.endTs <= SEARCH_CLUSTER_GAP_MS) {
      open.endTs = row.ts
      open.bestRank = Math.min(open.bestRank, row.rank)
      open.rows.push(row)
      continue
    }
    clusterSeq += 1
    const draft: CardDraft = {
      key: `c:${clusterSeq}`,
      momentId: null,
      startTs: row.ts,
      endTs: row.ts,
      dayKey,
      app: normalizeLabel(row.app),
      windowTitle: row.window_title,
      ocrSummary: null,
      bestRank: row.rank,
      rows: [row]
    }
    cards.set(draft.key, draft)
    openCluster.set(clusterKey, draft)
  }

  const ranked: Array<{ hit: SearchHitDto; bestRank: number }> = []
  for (const draft of cards.values()) {
    const snippetRow = pickSnippetRow(draft.rows, terms)
    ranked.push({
      bestRank: draft.bestRank,
      hit: {
        startTs: draft.startTs,
        endTs: draft.endTs,
        dayKey: draft.dayKey,
        app: draft.app,
        windowTitle: draft.windowTitle,
        ocrSummary: draft.ocrSummary,
        snippet: buildSnippet(snippetRow.ocr_text, terms),
        matchedEvents: draft.rows.length,
        eventIds: draft.rows.map((row) => row.id).sort((a, b) => a - b),
        momentId: draft.momentId
      }
    })
  }

  // MATCH 按 bm25 相关度（同分按时间倒序）；LIKE 无相关度 → 纯时间倒序
  ranked.sort((a, b) => {
    if (mode === 'match' && a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
    return b.hit.startTs - a.hit.startTs
  })

  return ranked.slice(0, SEARCH_CARD_LIMIT).map((item) => item.hit)
}

/**
 * 检索 L0 事件并归并成时刻卡片。
 * 只读：不建连接、不写库、不触发归纳，供主进程只读连接调用。
 */
export function searchEvents(db: Db, input: SearchInput): SearchResult {
  const classified = classifyQuery(input?.query ?? '')
  if (classified.mode === 'empty') return emptyResult(classified.query, 'empty')

  const app = normalizeLabel(input.app)
  const title = normalizeLabel(input.titleContains)
  const fromTs = isFiniteNumber(input.fromTs) ? input.fromTs : null
  const toTs = isFiniteNumber(input.toTs) ? input.toTs : null
  if (fromTs !== null && toTs !== null && toTs < fromTs) return emptyResult(classified.query, classified.mode)

  const filterParams: Record<string, unknown> = {
    fromTs,
    toTs,
    app: app === '' ? null : app,
    titleLike: title === '' ? null : `%${escapeLikePattern(title)}%`
  }

  const rows =
    classified.mode === 'match'
      ? selectByMatch(db, classified.terms, filterParams)
      : selectByLike(db, classified.terms, filterParams)

  return {
    query: classified.query,
    mode: classified.mode,
    hits: buildCards(db, rows, classified.terms, classified.mode),
    matchedEvents: rows.length,
    truncated: rows.length >= SEARCH_EVENT_LIMIT
  }
}

/**
 * 卡片下钻：返回该时刻的原始事件。
 * - 有 `momentId` 时直接复用时刻成员事件（与图谱侧栏同源）；
 * - 否则按 app + 标题 + 区间从 L0 现取（未成时刻的事件也能下钻）。
 */
export function querySearchHitEvents(db: Db, input: SearchHitEventsInput): NodeEventsResult {
  if (isPositiveInt(input.momentId)) return queryMomentEvents(db, input.momentId)
  const { startTs, endTs } = input
  if (!isFiniteNumber(startTs) || !isFiniteNumber(endTs) || endTs < startTs) {
    return { found: false, events: [], missingIds: [], malformed: false }
  }
  const app = normalizeLabel(input.app)
  const title = normalizeLabel(input.windowTitle)
  const rows = db
    .prepare(
      `SELECT id, ts, app, window_title, ocr_text, sensitive
       FROM events WHERE ts >= ? AND ts <= ?
       ORDER BY ts ASC, id ASC`
    )
    .all(startTs, endTs) as Array<{
    id: number
    ts: number
    app: string
    window_title: string | null
    ocr_text: string | null
    sensitive: number | null
  }>
  const events: NodeEventDto[] = rows
    .filter(
      (row) =>
        normalizeLabel(row.app) === app &&
        (title === '' || normalizeLabel(row.window_title) === title)
    )
    .map((row) => ({
      id: row.id,
      ts: row.ts,
      app: row.app,
      windowTitle: row.window_title,
      ocrText: row.ocr_text,
      sensitive: row.sensitive === 1 ? 1 : 0
    }))
  return { found: true, events, missingIds: [], malformed: false }
}

/** app 过滤器的候选项（按事件量倒序；空 app 不列） */
export function listSearchApps(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT app, COUNT(*) AS n FROM events
       WHERE app IS NOT NULL AND app <> ''
       GROUP BY app ORDER BY n DESC, app ASC`
    )
    .all() as Array<{ app: string; n: number }>
  return rows.map((row) => row.app)
}

/**
 * 整体重建检索索引（派生数据，坏了可重来；L0 不动）。
 * 与 v5 迁移里的重建同一口径：先清空再按 `events` 全量灌入。
 */
export function rebuildEventSearchIndex(db: Db): number {
  const run = db.transaction(() => {
    db.exec('DELETE FROM events_fts')
    db.prepare(
      `INSERT INTO events_fts(rowid, ocr_text)
       SELECT id, ${normalizeOcrSql('ocr_text')} FROM events`
    ).run()
    const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    return row.n
  })
  return run()
}
