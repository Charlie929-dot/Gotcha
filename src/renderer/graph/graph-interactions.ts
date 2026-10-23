/**
 * 图谱交互的纯逻辑（可单测；m2 §3 Phase 2「视觉与交互」）
 *
 * - 类型显隐：知识 / 行为 / 保护 / 事件四类，未知 type 归 unknown（默认可见）；
 * - 局部图：以某节点为中心的一跳邻域（节点 + 直接相连的边）；
 * - 统计：给工具栏/测试用的类型计数。
 *
 * DOM / sigma 接线在 `graph.ts`，本文件不碰 DOM。
 */

export type GraphTypeKey = 'knowledge' | 'activity' | 'protected' | 'event' | 'unknown'

export const GRAPH_TYPE_KEYS = ['knowledge', 'activity', 'protected', 'event'] as const

export type VisibleTypes = Record<GraphTypeKey, boolean>

export const TYPE_LABEL: Record<GraphTypeKey, string> = {
  knowledge: '知识',
  activity: '行为',
  protected: '保护',
  event: '事件',
  unknown: '其他'
}

export function defaultVisibleTypes(): VisibleTypes {
  return {
    knowledge: true,
    activity: true,
    protected: true,
    event: true,
    unknown: true
  }
}

export function typeKeyOf(type: string): GraphTypeKey {
  return (GRAPH_TYPE_KEYS as readonly string[]).includes(type)
    ? (type as GraphTypeKey)
    : 'unknown'
}

export function isTypeVisible(type: string, visible: VisibleTypes): boolean {
  return visible[typeKeyOf(type)]
}

/** 切换某类显隐；返回新对象，方便单测与状态比较。 */
export function toggleVisibleType(
  visible: VisibleTypes,
  type: GraphTypeKey,
  next = !visible[type]
): VisibleTypes {
  return { ...visible, [type]: next }
}

export interface InteractionEdge {
  source: string
  target: string
}

/** 以 nodeKey 为中心的一跳邻域：自身 + 直接相连的节点。 */
export function focusNodeSet(edges: Iterable<InteractionEdge>, nodeKey: string): Set<string> {
  const keys = new Set<string>([nodeKey])
  for (const edge of edges) {
    if (edge.source === nodeKey) keys.add(edge.target)
    else if (edge.target === nodeKey) keys.add(edge.source)
  }
  return keys
}

/** 局部图里保留两端都在邻域内的边（含邻居之间的边）。 */
export function edgeInFocus(edge: InteractionEdge, focus: ReadonlySet<string>): boolean {
  return focus.has(edge.source) && focus.has(edge.target)
}

export interface CountableNode {
  type: string
}

export function countNodeTypes(
  nodes: Iterable<CountableNode>,
  events = 0
): Record<GraphTypeKey, number> {
  const counts: Record<GraphTypeKey, number> = {
    knowledge: 0,
    activity: 0,
    protected: 0,
    event: events,
    unknown: 0
  }
  for (const node of nodes) {
    const key = typeKeyOf(node.type)
    counts[key] += 1
  }
  return counts
}
