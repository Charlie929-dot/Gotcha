/**
 * 图谱只读查询（M2 Phase 2 / v0.3 §4.4 §8）
 *
 * - `queryGraphDay`：旧按日取图路径（M2 Phase 2 起沿用；只取 level=1 节点与两端都在结果集内的边）；
 * - `queryGlobalGraph`：v0.3 全局图数据（主题 + 时刻 + 多归属 + embedding 边 + 位置），
 *   客户端一次性加载后再按日历调暗，不再按日重新构图；
 * - 按节点取成员事件（`source_events` → events 行），坏 JSON / 缺失 id 只跳过并计数，不抛到 UI；
 * - 纯读：只接收 `Db`，不建连接、不写库，供主进程只读连接调用。
 */

import type { Db } from '../db'
import { localDayKey } from './moments'
import { parseEventIdsDetailed } from './source-events'

export interface GraphNodeDto {
  id: number
  type: string
  title: string
  summary: string
  tsStart: number
  tsEnd: number
  sourceCount: number
  degree: number
  eventIds?: number[]
}

export interface GraphEdgeDto {
  id: number
  source: number
  target: number
  weight: number
  kind: string
  evidence: string
}

export interface GraphEventDto {
  id: number
  ts: number
  app: string
  windowTitle: string | null
  sensitive: number
}

export interface GraphDayData {
  nodes: GraphNodeDto[]
  edges: GraphEdgeDto[]
  events?: GraphEventDto[]
}

export interface GraphQueryOptions {
  /** 只取该 level（默认 1；M3 起 LOD 可传其它层） */
  level?: number
  /** 是否一并查出窗口内的原始采集事件（用于全量事件星图展示） */
  includeEvents?: boolean
}

export interface NodeEventDto {
  id: number
  ts: number
  app: string
  windowTitle: string | null
  ocrText: string | null
  sensitive: number
}

export interface NodeEventsResult {
  /** 节点不存在（已删除 / id 非法）时为 false */
  found: boolean
  events: NodeEventDto[]
  /** source_events 里在本库找不到的事件 id（编造 / 已被清理）；必须为 0 才通过可溯验收 */
  missingIds: number[]
  /** source_events 不是合法 JSON 数组（视为坏数据，不抛错） */
  malformed: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseEventIds(raw: string | null): { ids: number[]; malformed: boolean } {
  const parsed = parseEventIdsDetailed(raw)
  return { ids: parsed.ids, malformed: parsed.malformed }
}

interface NodeRow {
  id: number
  type: string | null
  title: string | null
  summary: string | null
  ts_start: number | null
  ts_end: number | null
  source_events: string | null
}

interface EdgeRow {
  id: number
  src: number | null
  dst: number | null
  weight: number | null
  kind: string | null
  evidence: string | null
}

/**
 * 取日期窗口内（与 [from, to] 相交）的节点与边。
 * 边只保留两端都在结果节点集里的，避免画布出现悬空边；degree 按保留下来的边统计。
 */
export function queryGraphDay(
  db: Db,
  from: number,
  to: number,
  options: GraphQueryOptions = {}
): GraphDayData {
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || to < from) return { nodes: [], edges: [] }
  const level = Number.isInteger(options.level) ? (options.level as number) : 1

  const nodeRows = db
    .prepare(
      `SELECT id, type, title, summary, ts_start, ts_end, source_events
       FROM nodes
       WHERE level = ? AND merged_into IS NULL
         AND ts_start IS NOT NULL AND ts_start <= ? AND COALESCE(ts_end, ts_start) >= ?
       ORDER BY ts_start ASC, id ASC`
    )
    .all(level, to, from) as NodeRow[]

  const nodes: GraphNodeDto[] = nodeRows.map((row) => {
    const parsed = parseEventIds(row.source_events)
    const tsStart = row.ts_start ?? 0
    return {
      id: row.id,
      type: row.type ?? 'unknown',
      title: row.title ?? '',
      summary: row.summary ?? '',
      tsStart,
      tsEnd: row.ts_end ?? tsStart,
      sourceCount: parsed.ids.length,
      degree: 0,
      ...(options.includeEvents ? { eventIds: parsed.ids } : {})
    }
  })

  let events: GraphEventDto[] | undefined
  if (options.includeEvents) {
    const eventRows = db
      .prepare(
        `SELECT id, ts, app, window_title, sensitive
         FROM events
         WHERE ts >= ? AND ts <= ?
         ORDER BY ts ASC`
      )
      .all(from, to) as {
        id: number
        ts: number
        app: string
        window_title: string | null
        sensitive: number | null
      }[]
    events = eventRows.map((row) => ({
      id: row.id,
      ts: row.ts,
      app: row.app,
      windowTitle: row.window_title,
      sensitive: row.sensitive === 1 ? 1 : 0
    }))
  }

  if (nodes.length === 0) {
    return options.includeEvents ? { nodes, edges: [], events: events ?? [] } : { nodes, edges: [] }
  }

  const byId = new Map<number, GraphNodeDto>()
  for (const node of nodes) byId.set(node.id, node)

  // M2 单日节点数百；先全量取边再按端点过滤（避免 IN 参数上限，也避免拼 SQL）
  const edgeRows = db
    .prepare('SELECT id, src, dst, weight, kind, evidence FROM edges')
    .all() as EdgeRow[]

  const edges: GraphEdgeDto[] = []
  for (const row of edgeRows) {
    const source = row.src
    const target = row.dst
    if (!isFiniteNumber(source) || !isFiniteNumber(target)) continue
    const srcNode = byId.get(source)
    const dstNode = byId.get(target)
    if (!srcNode || !dstNode) continue
    const weight = isFiniteNumber(row.weight) ? row.weight : 0
    edges.push({
      id: row.id,
      source,
      target,
      weight,
      kind: row.kind ?? 'ai',
      evidence: row.evidence ?? ''
    })
    srcNode.degree += 1
    dstNode.degree += 1
  }

  return { nodes, edges, ...(events !== undefined ? { events } : {}) }
}

/** 单次 IN 查询的事件 id 上限（SQLite 变量上限内的保守值） */
const NODE_EVENT_CHUNK = 400

interface EventRow {
  id: number
  ts: number
  app: string
  window_title: string | null
  ocr_text: string | null
  sensitive: number | null
}

function selectEventsByIds(db: Db, ids: readonly number[]): EventRow[] {
  const rows: EventRow[] = []
  for (let start = 0; start < ids.length; start += NODE_EVENT_CHUNK) {
    const chunk = ids.slice(start, start + NODE_EVENT_CHUNK)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    rows.push(
      ...(db
        .prepare(
          `SELECT id, ts, app, window_title, ocr_text, sensitive
           FROM events WHERE id IN (${placeholders})`
        )
        .all(...chunk) as EventRow[])
    )
  }
  return rows
}

/** 节点成员事件（时间线同款字段；只读，供侧栏下钻） */
export function queryNodeEvents(db: Db, nodeId: number): NodeEventsResult {
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    return { found: false, events: [], missingIds: [], malformed: false }
  }
  const node = db
    .prepare('SELECT source_events, merged_into FROM nodes WHERE id = ?')
    .get(nodeId) as { source_events: string | null; merged_into: number | null } | undefined
  if (!node) return { found: false, events: [], missingIds: [], malformed: false }

  // 已合并节点：跟随到存活节点（旧缓存里可能还拿着被合并的 id）
  if (node.merged_into !== null) {
    return queryNodeEvents(db, node.merged_into)
  }

  const parsed = parseEventIds(node.source_events)
  if (parsed.ids.length === 0) {
    return { found: true, events: [], missingIds: [], malformed: parsed.malformed }
  }

  const rows = selectEventsByIds(db, parsed.ids)
  const byId = new Map<number, EventRow>()
  for (const row of rows) byId.set(row.id, row)

  const events: NodeEventDto[] = []
  const missingIds: number[] = []
  for (const id of parsed.ids) {
    const row = byId.get(id)
    if (!row) {
      missingIds.push(id)
      continue
    }
    events.push({
      id: row.id,
      ts: row.ts,
      app: row.app,
      windowTitle: row.window_title,
      ocrText: row.ocr_text,
      sensitive: row.sensitive === 1 ? 1 : 0
    })
  }
  // 按时间顺序展示（source_events 本身是 id 升序，不代表时间顺序）
  events.sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts - b.ts))
  return { found: true, events, missingIds, malformed: parsed.malformed }
}

/** 时刻成员事件（侧栏下钻；`event_ids` 与节点 `source_events` 同口径解析） */
export function queryMomentEvents(db: Db, momentId: number): NodeEventsResult {
  if (!Number.isInteger(momentId) || momentId <= 0) {
    return { found: false, events: [], missingIds: [], malformed: false }
  }
  const moment = db
    .prepare('SELECT event_ids FROM moments WHERE id = ?')
    .get(momentId) as { event_ids: string | null } | undefined
  if (!moment) return { found: false, events: [], missingIds: [], malformed: false }

  const parsed = parseEventIds(moment.event_ids)
  if (parsed.ids.length === 0) {
    return { found: true, events: [], missingIds: [], malformed: parsed.malformed }
  }

  const rows = selectEventsByIds(db, parsed.ids)
  const byId = new Map<number, EventRow>()
  for (const row of rows) byId.set(row.id, row)

  const events: NodeEventDto[] = []
  const missingIds: number[] = []
  for (const id of parsed.ids) {
    const row = byId.get(id)
    if (!row) {
      missingIds.push(id)
      continue
    }
    events.push({
      id: row.id,
      ts: row.ts,
      app: row.app,
      windowTitle: row.window_title,
      ocrText: row.ocr_text,
      sensitive: row.sensitive === 1 ? 1 : 0
    })
  }
  events.sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts - b.ts))
  return { found: true, events, missingIds, malformed: parsed.malformed }
}

/* ------------------------------------------------------------------ *
 * v0.3 全局图（docs/m2-graph-redesign.md §4 / §8）
 * ------------------------------------------------------------------ */

export interface GlobalThemeDto {
  id: number
  type: string
  title: string
  summary: string
  tsStart: number
  tsEnd: number
  /** `source_events` 里的成员事件数（v2 兼容字段，不代表权威归属） */
  sourceCount: number
  /** `theme_moments` 里的成员时刻数（v3 权威） */
  memberCount: number
  /** 返回边集内的度（只算 embedding 边） */
  degree: number
}

export interface GlobalMomentDto {
  id: number
  startTs: number
  endTs: number
  dayKey: string
  app: string | null
  windowTitle: string | null
  ocrSummary: string | null
  eventIds: number[]
  /** 是否有任何主题归属（false = 悬空时刻，日历聚焦时不会出现） */
  assigned: boolean
}

export interface MembershipDto {
  themeId: number
  momentId: number
  weight: number
  /** 'owner' | 'secondary' | 'manual' */
  source: string
}

export interface NodePositionDto {
  nodeId: number
  x: number
  y: number
}

export interface DayActivityDto {
  /** 本地日 `yyyy-mm-dd` */
  dayKey: string
  /** 当天采集到的全部事件数（含还没成时刻的积压） */
  events: number
  /** 当天时刻数（`moments` 表，含未归属主题的） */
  moments: number
  /**
   * 当天**还没归属任何主题**的时刻数（「待归纳」，日历空心点用）。
   * 口径是时刻 → 主题，不是事件 → 时刻：事件成时刻是本地分组、回填一跑就补齐；
   * 时刻成主题要过归纳（D28 只自动归纳今天），这才是会长期积压的那一层。
   */
  pending: number
}

export interface GraphGlobalStats {
  themes: number
  moments: number
  memberships: number
  edges: number
  positions: number
}

export interface GraphGlobalData {
  themes: GlobalThemeDto[]
  moments: GlobalMomentDto[]
  memberships: MembershipDto[]
  edges: GraphEdgeDto[]
  positions: NodePositionDto[]
  /** 按本地日的活动量（日历日格热力用；含未归纳积压的事件） */
  dayActivity: DayActivityDto[]
  stats: GraphGlobalStats
}

export interface GlobalQueryOptions {
  /** 是否包含没有主题归属的时刻（默认 false：画布不出现悬空点） */
  includeOrphanMoments?: boolean
  /** 兼容期回退：把旧 `kind='ai'` 边也带上（默认不含；回填期间显式开启） */
  includeLegacyAiEdges?: boolean
  /** 是否读 node_positions 做布局 seed（默认 true） */
  includePositions?: boolean
}

interface GlobalThemeRow {
  id: number
  type: string | null
  title: string | null
  summary: string | null
  ts_start: number | null
  ts_end: number | null
  source_events: string | null
}

interface GlobalMomentRow {
  id: number
  start_ts: number
  end_ts: number
  day_key: string
  app: string | null
  window_title: string | null
  ocr_summary: string | null
  event_ids: string | null
}

export function emptyGlobalGraph(): GraphGlobalData {
  return {
    themes: [],
    moments: [],
    memberships: [],
    edges: [],
    positions: [],
    dayActivity: [],
    stats: { themes: 0, moments: 0, memberships: 0, edges: 0, positions: 0 }
  }
}

/**
 * 按本地日汇总活动量（日历日格热力 + 空心点）。
 * - 事件：`events` 表按本地日逐条计数（含未进时刻的积压——日格计数要的是「这天有多忙」）；
 * - 时刻：`moments` 表按 `day_key` 计数（含未归属主题的，与事件数同口径）；
 * - 待归纳：`moments` 里还没出现在 `theme_moments` 的时刻（有时刻没主题＝这天归纳没跑完）。
 */
function queryDayActivity(db: Db): DayActivityDto[] {
  const byDay = new Map<string, DayActivityDto>()
  const bucket = (key: string): DayActivityDto => {
    const existing = byDay.get(key)
    if (existing) return existing
    const created: DayActivityDto = { dayKey: key, events: 0, moments: 0, pending: 0 }
    byDay.set(key, created)
    return created
  }

  const eventRows = db.prepare('SELECT ts FROM events').all() as Array<{ ts: number }>
  for (const row of eventRows) {
    if (!isFiniteNumber(row.ts)) continue
    bucket(localDayKey(row.ts)).events += 1
  }
  const momentRows = db
    .prepare('SELECT day_key, COUNT(*) AS moments FROM moments GROUP BY day_key')
    .all() as Array<{ day_key: string | null; moments: number }>
  for (const row of momentRows) {
    if (!row.day_key) continue
    bucket(row.day_key).moments += isFiniteNumber(row.moments) ? row.moments : 0
  }
  // 时刻还没挂到任何主题上（`theme_moments` 无行）——「待归纳」
  const pendingRows = db
    .prepare(
      `SELECT m.day_key AS day_key, COUNT(*) AS pending
       FROM moments m
       WHERE NOT EXISTS (SELECT 1 FROM theme_moments t WHERE t.moment_id = m.id)
       GROUP BY m.day_key`
    )
    .all() as Array<{ day_key: string | null; pending: number }>
  for (const row of pendingRows) {
    if (!row.day_key) continue
    bucket(row.day_key).pending += isFiniteNumber(row.pending) ? row.pending : 0
  }

  return [...byDay.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey))
}

/**
 * 一次取全量全局图（当前规模 210 主题 / ~800 时刻，客户端内存里筛选即可）。
 * - 边默认只取 `kind='embedding'`，旧 `ai` 边不出现（G-graph-query 验收）；
 * - 两端有一端不在主题集内的边丢弃，避免悬空边；
 * - 悬空时刻默认不返回（`includeOrphanMoments` 可显式要）。
 */
export function queryGlobalGraph(db: Db, options: GlobalQueryOptions = {}): GraphGlobalData {
  const themeRows = db
    .prepare(
      `SELECT id, type, title, summary, ts_start, ts_end, source_events
       FROM nodes WHERE level = 1 AND merged_into IS NULL ORDER BY id ASC`
    )
    .all() as GlobalThemeRow[]

  const membershipRows = db
    .prepare('SELECT theme_id, moment_id, weight, source FROM theme_moments')
    .all() as Array<{ theme_id: number; moment_id: number; weight: number | null; source: string | null }>

  const momentRows = db
    .prepare(
      `SELECT id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids
       FROM moments ORDER BY start_ts ASC, id ASC`
    )
    .all() as GlobalMomentRow[]

  const themes: GlobalThemeDto[] = themeRows.map((row) => {
    const tsStart = row.ts_start ?? 0
    return {
      id: row.id,
      type: row.type ?? 'unknown',
      title: row.title ?? '',
      summary: row.summary ?? '',
      tsStart,
      tsEnd: row.ts_end ?? tsStart,
      sourceCount: parseEventIds(row.source_events).ids.length,
      memberCount: 0,
      degree: 0
    }
  })
  const themeById = new Map<number, GlobalThemeDto>()
  for (const theme of themes) themeById.set(theme.id, theme)

  const memberships: MembershipDto[] = []
  const momentThemeCount = new Map<number, number>()
  for (const row of membershipRows) {
    const theme = themeById.get(row.theme_id)
    // 主题被合并/删除后的残留归属不返回（避免侧栏指向不存在的节点）
    if (!theme) continue
    memberships.push({
      themeId: row.theme_id,
      momentId: row.moment_id,
      weight: isFiniteNumber(row.weight) ? row.weight : 1,
      source: row.source ?? 'owner'
    })
    theme.memberCount += 1
    momentThemeCount.set(row.moment_id, (momentThemeCount.get(row.moment_id) ?? 0) + 1)
  }

  const moments: GlobalMomentDto[] = []
  for (const row of momentRows) {
    const assigned = (momentThemeCount.get(row.id) ?? 0) > 0
    if (!assigned && !options.includeOrphanMoments) continue
    moments.push({
      id: row.id,
      startTs: row.start_ts,
      endTs: row.end_ts,
      dayKey: row.day_key,
      app: row.app,
      windowTitle: row.window_title,
      ocrSummary: row.ocr_summary,
      eventIds: parseEventIds(row.event_ids).ids,
      assigned
    })
  }

  const edgeKinds = options.includeLegacyAiEdges ? ['embedding', 'ai'] : ['embedding']
  const placeholders = edgeKinds.map(() => '?').join(',')
  const edgeRows = db
    .prepare(
      `SELECT id, src, dst, weight, kind, evidence FROM edges
       WHERE kind IN (${placeholders}) ORDER BY id ASC`
    )
    .all(...edgeKinds) as EdgeRow[]

  const edges: GraphEdgeDto[] = []
  for (const row of edgeRows) {
    const source = row.src
    const target = row.dst
    if (!isFiniteNumber(source) || !isFiniteNumber(target)) continue
    const srcTheme = themeById.get(source)
    const dstTheme = themeById.get(target)
    if (!srcTheme || !dstTheme) continue
    edges.push({
      id: row.id,
      source,
      target,
      weight: isFiniteNumber(row.weight) ? row.weight : 0,
      kind: row.kind ?? 'embedding',
      evidence: row.evidence ?? ''
    })
    srcTheme.degree += 1
    dstTheme.degree += 1
  }

  let positions: NodePositionDto[] = []
  if (options.includePositions !== false) {
    const positionRows = db
      .prepare('SELECT node_id, x, y FROM node_positions ORDER BY node_id ASC')
      .all() as Array<{ node_id: number; x: number; y: number }>
    positions = positionRows
      .filter((row) => themeById.has(row.node_id))
      .map((row) => ({ nodeId: row.node_id, x: row.x, y: row.y }))
  }

  return {
    themes,
    moments,
    memberships,
    edges,
    positions,
    dayActivity: queryDayActivity(db),
    stats: {
      themes: themes.length,
      moments: moments.length,
      memberships: memberships.length,
      edges: edges.length,
      positions: positions.length
    }
  }
}
