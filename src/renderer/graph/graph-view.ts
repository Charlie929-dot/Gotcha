/**
 * 图谱视觉映射（renderer 纯函数，可单测；m2-plan §3 Phase 2「视觉与交互」）
 *
 * - 六色按技术方案 §6.2；M2 实际只出现知识 `#4FC3F7` / 行为 `#81C784` / 保护占位灰；
 * - 节点尺寸随度数对数增长（避免大节点吞掉画布）；
 * - 边宽 ∝ weight（与 ForceAtlas2 的 edgeWeightInfluence 形成双重编码，D8）；
 * - 邻域高亮：返回节点自身 + 一跳邻居，其余降透明度。
 */

import type { GraphDayData, GraphEdgeDto } from '../../understand/graph-query'

export const NODE_COLORS = {
  knowledge: '#4FC3F7',
  activity: '#81C784',
  protected: '#9E9E9E',
  unknown: '#B0BEC5'
} as const

export const EDGE_COLOR = '#5b5b6e'
export const NODE_SIZE_MIN = 6
export const NODE_SIZE_MAX = 22

export function nodeColor(type: string): string {
  return (NODE_COLORS as Record<string, string>)[type] ?? NODE_COLORS.unknown
}

/** 度数 → 尺寸：log1p 压缩，最大度数映射到 NODE_SIZE_MAX */
export function nodeSize(degree: number, maxDegree: number): number {
  const max = Math.max(0, maxDegree)
  if (max <= 0) return NODE_SIZE_MIN
  const ratio = Math.log1p(Math.max(0, degree)) / Math.log1p(max)
  return NODE_SIZE_MIN + (NODE_SIZE_MAX - NODE_SIZE_MIN) * Math.min(1, Math.max(0, ratio))
}

/** 边宽：weight 0–1 → 1–5px */
export function edgeSize(weight: number): number {
  const clamped = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0
  return 1 + 4 * clamped
}

/** 当前图的最大度数（决定尺寸映射上限） */
export function maxDegree(data: Pick<GraphDayData, 'nodes'>): number {
  return data.nodes.reduce((max, node) => Math.max(max, node.degree), 0)
}

/** 邻域集合：节点自身 + 一跳邻居；用于悬停高亮 */
export function neighborIds(edges: readonly GraphEdgeDto[], nodeId: number): Set<number> {
  const ids = new Set<number>([nodeId])
  for (const edge of edges) {
    if (edge.source === nodeId) ids.add(edge.target)
    else if (edge.target === nodeId) ids.add(edge.source)
  }
  return ids
}

/** 时间窗过滤（客户端二次过滤；M3 分日查询前的兜底） */
export function filterByWindow<T extends { tsStart: number; tsEnd: number }>(
  nodes: readonly T[],
  from: number,
  to: number
): T[] {
  return nodes.filter((node) => node.tsStart <= to && node.tsEnd >= from)
}

/** 节点标签：截断到 max 字（sigma 标签过长会互相压盖） */
export function nodeLabel(title: string, max = 18): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`
}
