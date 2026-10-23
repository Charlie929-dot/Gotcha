/**
 * 图谱只读查询（M2 Phase 2；m2-plan §3 Phase 2「数据」）
 *
 * - 按日期窗口取节点（与日窗口相交，只取 `level = 1`）与两端都在结果集内的边；
 * - 按节点取成员事件（`source_events` → events 行），坏 JSON / 缺失 id 只跳过并计数，
 *   不抛到 UI；
 * - 纯读：只接收 `Db`，不建连接、不写库，供主进程只读连接调用。
 */

import type { Db } from '../db'

export interface GraphNodeDto {
  id: number
  type: string
  title: string
  summary: string
  tsStart: number
  tsEnd: number
  sourceCount: number
  degree: number
}

export interface GraphEdgeDto {
  id: number
  source: number
  target: number
  weight: number
  kind: string
  evidence: string
}

export interface GraphDayData {
  nodes: GraphNodeDto[]
  edges: GraphEdgeDto[]
}

export interface GraphQueryOptions {
  /** 只取该 level（默认 1；M3 起 LOD 可传其它层） */
  level?: number
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
  if (typeof raw !== 'string' || raw.trim() === '') return { ids: [], malformed: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ids: [], malformed: true }
  }
  if (!Array.isArray(parsed)) return { ids: [], malformed: true }
  const seen = new Set<number>()
  for (const value of parsed) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) seen.add(value)
  }
  return { ids: [...seen].sort((a, b) => a - b), malformed: false }
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
       WHERE level = ? AND ts_start IS NOT NULL AND ts_start <= ? AND COALESCE(ts_end, ts_start) >= ?
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
      degree: 0
    }
  })

  if (nodes.length === 0) return { nodes, edges: [] }

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

  return { nodes, edges }
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
    .prepare('SELECT source_events FROM nodes WHERE id = ?')
    .get(nodeId) as { source_events: string | null } | undefined
  if (!node) return { found: false, events: [], missingIds: [], malformed: false }

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
