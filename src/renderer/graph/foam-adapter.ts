/**
 * 全局图数据 → Foam `GraphData` 的映射（方案 §7.2；纯函数，可单测）。
 *
 * 节点：
 * - 主题 `t:<id>`：type = knowledge / activity / protected，半径按成员数 6–22；
 * - 时刻 `m:<id>`：type = moment，半径 2–3，多归属时略大。
 * 边：
 * - 主题↔主题 `kind='embedding'`，`weight` = 余弦相似度（距离编码，F2）；
 * - 主题↔时刻 `kind='membership'`，默认不画、只参与力与高亮（F1）。
 */

import type { GraphData, GraphDataLink, NodeInfo } from '../foam/protocol'
import { momentMatchesDays, themeMatchesDays } from './calendar'

export interface ThemeSeed {
  id: number
  type: string
  title: string
  summary?: string
  tsStart: number
  tsEnd: number
  sourceCount: number
}

export interface MomentSeed {
  id: number
  ts: number
  dayKey: string
  app: string
  title: string
  themeIds: number[]
}

export interface ThemeEdgeSeed {
  source: number
  target: number
  weight: number
}

export interface GlobalGraphInput {
  themes: ThemeSeed[]
  moments: MomentSeed[]
  edges: ThemeEdgeSeed[]
}

export interface GlobalGraphView {
  data: GraphData
  themeIds: string[]
  momentIds: string[]
}

export const THEME_PREFIX = 't:'
export const MOMENT_PREFIX = 'm:'

export function themeNodeId(id: number): string {
  return `${THEME_PREFIX}${id}`
}

export function momentNodeId(id: number): string {
  return `${MOMENT_PREFIX}${id}`
}

export function nodeIdOf(value: string): number {
  const raw = value.slice(2)
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

const THEME_SIZE_MIN = 6
const THEME_SIZE_MAX = 22
/** 成员数上限参考值（方案：2700 成员 / 210 主题，单个主题可达 40+）。 */
const THEME_SIZE_CAP = 40
const MOMENT_SIZE = 2.4
const MOMENT_SHARED_SIZE = 3

/** 主题半径：log1p(sourceCount) 压缩到 6–22（与 v0.2 的 6–22 视觉一致）。 */
export function themeSize(sourceCount: number): number {
  const count = Number.isFinite(sourceCount) ? Math.max(0, sourceCount) : 0
  const ratio = Math.min(1, Math.log1p(count) / Math.log1p(THEME_SIZE_CAP))
  return THEME_SIZE_MIN + (THEME_SIZE_MAX - THEME_SIZE_MIN) * ratio
}

function truncate(text: string, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`
}

function themeNode(theme: ThemeSeed): NodeInfo {
  return {
    id: themeNodeId(theme.id),
    type: theme.type || 'knowledge',
    title: truncate(theme.title, 24),
    properties: {
      size: themeSize(theme.sourceCount),
      tsStart: theme.tsStart,
      tsEnd: theme.tsEnd,
      sourceCount: theme.sourceCount
    },
    tags: []
  }
}

function momentNode(moment: MomentSeed): NodeInfo {
  return {
    id: momentNodeId(moment.id),
    type: 'moment',
    title: truncate(`${moment.app} · ${moment.title}`, 28),
    properties: {
      size: moment.themeIds.length > 1 ? MOMENT_SHARED_SIZE : MOMENT_SIZE,
      dayKey: moment.dayKey,
      tsStart: moment.ts,
      tsEnd: moment.ts,
      app: moment.app
    },
    tags: []
  }
}

/** 把全局图输入映射成 Foam 的 GraphData（成员边 + 主题相似边）。 */
export function toFoamGraph(input: GlobalGraphInput): GlobalGraphView {
  const nodeInfo: Record<string, NodeInfo> = {}
  const themeIds: string[] = []
  const momentIds: string[] = []

  for (const theme of input.themes) {
    const node = themeNode(theme)
    nodeInfo[node.id] = node
    themeIds.push(node.id)
  }
  for (const moment of input.moments) {
    const node = momentNode(moment)
    nodeInfo[node.id] = node
    momentIds.push(node.id)
  }

  const links: GraphDataLink[] = []
  const seenEdges = new Set<string>()
  for (const edge of input.edges) {
    const source = themeNodeId(edge.source)
    const target = themeNodeId(edge.target)
    if (!nodeInfo[source] || !nodeInfo[target]) continue
    const pair = source < target ? `${source}|${target}` : `${target}|${source}`
    if (seenEdges.has(pair)) continue
    seenEdges.add(pair)
    links.push({ source, target, weight: edge.weight, kind: 'embedding' })
  }

  const seenMembership = new Set<string>()
  for (const moment of input.moments) {
    const target = momentNodeId(moment.id)
    for (const themeId of moment.themeIds) {
      const source = themeNodeId(themeId)
      if (!nodeInfo[source]) continue
      const pair = `${source}|${target}`
      if (seenMembership.has(pair)) continue
      seenMembership.add(pair)
      links.push({ source, target, kind: 'membership' })
    }
  }

  return { data: { nodeInfo, links }, themeIds, momentIds }
}

/**
 * 时间筛选：返回需要调暗（而不是删除）的节点 id 集合。
 * `days === null`（全部）时返回空集合。
 */
export function timeDimmedIds(
  input: GlobalGraphInput,
  days: Set<string> | null
): Set<string> {
  const dimmed = new Set<string>()
  if (days === null) return dimmed
  for (const theme of input.themes) {
    if (!themeMatchesDays(theme.tsStart, theme.tsEnd, days)) {
      dimmed.add(themeNodeId(theme.id))
    }
  }
  for (const moment of input.moments) {
    if (!momentMatchesDays(moment.dayKey, days)) {
      dimmed.add(momentNodeId(moment.id))
    }
  }
  return dimmed
}

/** 时间筛选后仍在范围内的节点（用于相机适配，F8）。 */
export function focusedIdsForDays(
  input: GlobalGraphInput,
  days: Set<string> | null
): { themeIds: string[]; momentIds: string[] } {
  const themeIds: string[] = []
  const momentIds: string[] = []
  for (const theme of input.themes) {
    if (themeMatchesDays(theme.tsStart, theme.tsEnd, days)) themeIds.push(themeNodeId(theme.id))
  }
  for (const moment of input.moments) {
    if (momentMatchesDays(moment.dayKey, days)) momentIds.push(momentNodeId(moment.id))
  }
  return { themeIds, momentIds }
}

/** 侧栏「也属于」：时刻的其它主题（与主归属分开显示）。 */
export function otherThemesOfMoment(moment: MomentSeed): number[] {
  return moment.themeIds.slice(1)
}

/** 成员数统计（状态栏/计数用）。 */
export function countMembership(input: GlobalGraphInput): number {
  let total = 0
  for (const moment of input.moments) total += moment.themeIds.length
  return total
}
