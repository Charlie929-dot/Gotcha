/**
 * 归纳落库（M2 Phase 1；m2-plan §3 Phase 1「落库」）
 *
 * 单事务：节点合并 / 插入 → 边去重 → 敏感占位节点 → 游标推进 → 用量记账。
 * - 节点合并：同本地日 + 同 type + 归一化标题 → 并集 source_events、扩展 ts 区间、摘要取更长者；
 * - 边：按 (src, dst, kind='ai') 去重，weight 取最大、evidence 保留非空；
 * - 敏感占位：无法安全剥离的「时刻」只记本地节点（type='protected'，标题「内容已保护」），
 *   日志与出云都不含原文；同一天多个占位合并成一个节点；
 * - 游标与节点/边写入同一事务：任何一步失败整体回滚，游标不动（下次重试同批）。
 */

import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'
import type { Moment } from './cloud/batch'
import { writeCursor, type BatchCursor } from './cloud/batch'
import type { InductionResult } from './structure/schema'

export interface InductionUsage {
  calls: number
  promptTokens: number
  completionTokens: number
}

export interface InductionPersistInput {
  result: InductionResult
  moments: readonly Moment[]
  /** 无法安全剥离、整条不出云的事件 id（来自 buildCloudMomentPayload） */
  excludedEventIds?: readonly number[]
  cursor: BatchCursor
  usage?: InductionUsage
  now: number
}

export interface InductionPersistStats {
  nodesCreated: number
  nodesMerged: number
  placeholders: number
  edgesInserted: number
  edgesUpdated: number
}

export const PLACEHOLDER_NODE = {
  type: 'protected',
  title: '内容已保护',
  summary: '该时刻含敏感内容，未出云（本地占位）'
} as const

export const USAGE_KEY_PREFIX = 'graph.usage.'

/** 本地日期键（节点合并按「本地日」；与 UI 的日期筛选一致） */
export function localDayKey(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim()
}

function parseEventIds(raw: unknown): number[] {
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number' && Number.isInteger(id)) : []
  } catch {
    return []
  }
}

function mergeSummary(current: string, incoming: string): string {
  const a = current.trim()
  const b = incoming.trim()
  if (b.length > a.length) return b
  return a
}

interface NodeAggregate {
  type: string
  title: string
  summary: string
  tsStart: number
  tsEnd: number
  eventIds: Set<number>
}

function upsertNode(db: Db, aggregate: NodeAggregate): { id: number; merged: boolean } {
  const candidates = db
    .prepare('SELECT id, summary, ts_start, ts_end, source_events FROM nodes WHERE level = 1 AND type = ? AND title = ?')
    .all(aggregate.type, aggregate.title) as Array<{
    id: number
    summary: string | null
    ts_start: number | null
    ts_end: number | null
    source_events: string | null
  }>
  const day = localDayKey(aggregate.tsStart)
  const existing = candidates.find((row) => row.ts_start !== null && localDayKey(row.ts_start) === day)

  if (existing) {
    const sourceEvents = new Set(parseEventIds(existing.source_events))
    for (const id of aggregate.eventIds) sourceEvents.add(id)
    const tsStart = Math.min(existing.ts_start ?? aggregate.tsStart, aggregate.tsStart)
    const tsEnd = Math.max(existing.ts_end ?? aggregate.tsEnd, aggregate.tsEnd)
    const summary = mergeSummary(existing.summary ?? '', aggregate.summary)
    db.prepare('UPDATE nodes SET summary = ?, ts_start = ?, ts_end = ?, source_events = ? WHERE id = ?').run(
      summary,
      tsStart,
      tsEnd,
      JSON.stringify([...sourceEvents].sort((a, b) => a - b)),
      existing.id
    )
    return { id: existing.id, merged: true }
  }

  const result = db
    .prepare(
      `INSERT INTO nodes (level, type, title, summary, ts_start, ts_end, source_events, meta_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      aggregate.type,
      aggregate.title,
      aggregate.summary,
      aggregate.tsStart,
      aggregate.tsEnd,
      JSON.stringify([...aggregate.eventIds].sort((a, b) => a - b))
    )
  return { id: Number(result.lastInsertRowid), merged: false }
}

function upsertAiEdge(db: Db, src: number, dst: number, weight: number, evidence: string): 'inserted' | 'updated' {
  const existing = db
    .prepare("SELECT id, weight, evidence FROM edges WHERE src = ? AND dst = ? AND kind = 'ai'")
    .get(src, dst) as { id: number; weight: number | null; evidence: string | null } | undefined
  if (existing) {
    db.prepare('UPDATE edges SET weight = ?, evidence = ? WHERE id = ?').run(
      Math.max(existing.weight ?? 0, weight),
      existing.evidence && existing.evidence.trim() !== '' ? existing.evidence : evidence,
      existing.id
    )
    return 'updated'
  }
  db.prepare("INSERT INTO edges (src, dst, weight, kind, evidence) VALUES (?, ?, ?, 'ai', ?)").run(
    src,
    dst,
    weight,
    evidence
  )
  return 'inserted'
}

function addUsage(db: Db, now: number, usage: InductionUsage | undefined): void {
  if (!usage) return
  const key = `${USAGE_KEY_PREFIX}${localDayKey(now)}`
  let current = { calls: 0, prompt_tokens: 0, completion_tokens: 0 }
  const raw = getSetting(db, key)
  if (raw !== '') {
    try {
      const parsed = JSON.parse(raw) as Partial<typeof current>
      current = {
        calls: Number(parsed.calls) || 0,
        prompt_tokens: Number(parsed.prompt_tokens) || 0,
        completion_tokens: Number(parsed.completion_tokens) || 0
      }
    } catch {
      // 坏数据直接覆盖为本次用量
    }
  }
  setSetting(
    db,
    key,
    JSON.stringify({
      calls: current.calls + usage.calls,
      prompt_tokens: current.prompt_tokens + usage.promptTokens,
      completion_tokens: current.completion_tokens + usage.completionTokens
    })
  )
}

/** 读今日用量（预算判断用） */
export function readUsage(db: Db, now: number): InductionUsage {
  const raw = getSetting(db, `${USAGE_KEY_PREFIX}${localDayKey(now)}`)
  if (raw === '') return { calls: 0, promptTokens: 0, completionTokens: 0 }
  try {
    const parsed = JSON.parse(raw) as {
      calls?: number
      prompt_tokens?: number
      completion_tokens?: number
    }
    return {
      calls: Number(parsed.calls) || 0,
      promptTokens: Number(parsed.prompt_tokens) || 0,
      completionTokens: Number(parsed.completion_tokens) || 0
    }
  } catch {
    return { calls: 0, promptTokens: 0, completionTokens: 0 }
  }
}

/** 事件 id → 所属时刻（用于占位节点的 ts 区间） */
function momentRanges(moments: readonly Moment[]): Map<number, { startTs: number; endTs: number }> {
  const map = new Map<number, { startTs: number; endTs: number }>()
  for (const moment of moments) {
    for (const id of moment.eventIds) map.set(id, { startTs: moment.startTs, endTs: moment.endTs })
  }
  return map
}

function nodeAggregateFromEventIds(
  eventIds: readonly number[],
  ranges: Map<number, { startTs: number; endTs: number }>
): { tsStart: number; tsEnd: number; ids: number[] } | null {
  const ids = eventIds.filter((id) => ranges.has(id))
  if (ids.length === 0) return null
  let tsStart = Number.POSITIVE_INFINITY
  let tsEnd = Number.NEGATIVE_INFINITY
  for (const id of ids) {
    const range = ranges.get(id)!
    tsStart = Math.min(tsStart, range.startTs)
    tsEnd = Math.max(tsEnd, range.endTs)
  }
  return { tsStart, tsEnd, ids }
}

/** 落库（单事务）。返回写入统计；事务内抛错整体回滚。 */
export function persistInduction(db: Db, input: InductionPersistInput): InductionPersistStats {
  const stats: InductionPersistStats = {
    nodesCreated: 0,
    nodesMerged: 0,
    placeholders: 0,
    edgesInserted: 0,
    edgesUpdated: 0
  }
  const ranges = momentRanges(input.moments)

  db.transaction(() => {
    const nodeIds: number[] = input.result.nodes.map(() => -1)
    input.result.nodes.forEach((node, index) => {
      const range = nodeAggregateFromEventIds(node.eventIds, ranges)
      if (!range) return
      const result = upsertNode(db, {
        type: node.type,
        title: normalizeTitle(node.title),
        summary: node.summary,
        tsStart: range.tsStart,
        tsEnd: range.tsEnd,
        eventIds: new Set(range.ids)
      })
      if (result.merged) stats.nodesMerged += 1
      else stats.nodesCreated += 1
      nodeIds[index] = result.id
    })

    for (const edge of input.result.edges) {
      const src = nodeIds[edge.from]
      const dst = nodeIds[edge.to]
      if (src === undefined || dst === undefined || src < 0 || dst < 0) continue
      const kind = upsertAiEdge(db, src, dst, edge.weight, edge.evidence)
      if (kind === 'inserted') stats.edgesInserted += 1
      else stats.edgesUpdated += 1
    }

    // 敏感时刻 → 本地占位节点（按本地日合并；payload 里没有原文）
    const excluded = input.excludedEventIds ?? []
    const placeholderByDay = new Map<string, NodeAggregate>()
    for (const id of excluded) {
      const range = ranges.get(id)
      if (!range) continue
      const day = localDayKey(range.startTs)
      const aggregate = placeholderByDay.get(day) ?? {
        type: PLACEHOLDER_NODE.type,
        title: PLACEHOLDER_NODE.title,
        summary: PLACEHOLDER_NODE.summary,
        tsStart: range.startTs,
        tsEnd: range.endTs,
        eventIds: new Set<number>()
      }
      aggregate.tsStart = Math.min(aggregate.tsStart, range.startTs)
      aggregate.tsEnd = Math.max(aggregate.tsEnd, range.endTs)
      aggregate.eventIds.add(id)
      placeholderByDay.set(day, aggregate)
    }
    for (const aggregate of placeholderByDay.values()) {
      const result = upsertNode(db, aggregate)
      if (result.merged) stats.nodesMerged += 1
      else {
        stats.nodesCreated += 1
        stats.placeholders += 1
      }
    }

    writeCursor(db, input.cursor)
    addUsage(db, input.now, input.usage)
  })()

  return stats
}
