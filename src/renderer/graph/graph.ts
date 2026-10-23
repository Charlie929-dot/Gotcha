/**
 * 图谱窗口（M2 Phase 2b）
 *
 * - 数据：`graph:query` 取当天节点/边 → graphology + sigma 力导向画布（懒加载，时间线不背图谱体积）；
 * - 交互：滚轮缩放、拖拽平移、悬停高亮邻域（其余降透明度）、点击节点开侧栏（C4）；
 * - 侧栏「在时间线中查看」带日期跳转；设置抽屉覆盖归纳参数 / 供应商 / 快捷键 / 出网确认（D21/D22/D24）；
 * - 空状态（未配置 key / 未确认出网 / 采集暂停 / 无节点）与归纳状态徽标。
 *
 * 视觉映射在 `graph-view.ts`（纯函数），侧栏在 `graph-panel.ts`，设置抽屉在
 * `graph-settings-panel.ts`；本文件只做 DOM / sigma / IPC 接线。
 */

import { dayRange, formatDate, startOfDay } from '../timeline'
import type { GraphDayData } from '../../understand/graph-query'
import type { GraphApi } from '../graph-preload'
import type { GraphInduceResult } from '../../main/graph-ipc'
import type { GraphSettingsView } from '../../main/graph-settings'
import type { InductionSnapshot } from '../../main/induction-runtime'
import {
  EDGE_COLOR,
  EVENT_NODE_SIZE,
  SUB_EDGE_COLOR,
  edgeSize,
  maxDegree,
  neighborKeys,
  nodeColor,
  nodeLabel,
  nodeSize
} from './graph-view'
import {
  defaultVisibleTypes,
  focusNodeSet,
  isTypeVisible,
  toggleVisibleType,
  type GraphTypeKey,
  type VisibleTypes
} from './graph-interactions'
import { createNodePanel } from './graph-panel'
import { createSettingsPanel } from './graph-settings-panel'

declare global {
  interface Window {
    gotchaGraph: GraphApi
    /** E2E 只读钩子：sigma 画布不便于按像素点击，测试通过它走同一 openNode 路径 */
    __gotchaGraphView?: {
      count(): number
      select(nodeId: number): Promise<void>
      hover(nodeId: number | null): void
      focus(nodeId: number | string): void
      clearFocus(): void
      filters(): Record<string, boolean>
      visibleCounts(): { nodes: number; edges: number }
    }
  }
}

type GraphInstance = import('graphology').default
type SigmaInstance = import('sigma').default

interface SigmaModules {
  Graph: new (options?: Record<string, unknown>) => GraphInstance
  Sigma: new (
    graph: GraphInstance,
    container: HTMLElement,
    settings?: Record<string, unknown>
  ) => SigmaInstance
  forceAtlas2: {
    assign(graph: GraphInstance, options?: Record<string, unknown>): void
    inferSettings(graph: GraphInstance): Record<string, unknown>
  }
}

const statusEl = document.getElementById('status')
const dateEl = document.getElementById('date')
const emptyEl = document.getElementById('empty')
const countEl = document.getElementById('node-count')
const containerEl = document.getElementById('sigma-container')
const consentEl = document.getElementById('consent')
const consentButton = document.getElementById('consent-btn')
const metaEl = document.getElementById('meta')
const panelEl = document.getElementById('panel')
const panelTitleEl = document.getElementById('panel-title')
const panelSummaryEl = document.getElementById('panel-summary')
const panelMetaEl = document.getElementById('panel-meta')
const panelEventsEl = document.getElementById('panel-events')
const panelTimelineEl = document.getElementById('panel-timeline')
const drawerEl = document.getElementById('drawer')
const focusBarEl = document.getElementById('focus-bar')
const focusLabelEl = document.getElementById('focus-label')
const focusExitEl = document.getElementById('focus-exit')
const filterInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('[data-type-filter]')
)

if (
  !statusEl ||
  !dateEl ||
  !emptyEl ||
  !countEl ||
  !containerEl ||
  !consentEl ||
  !consentButton ||
  !metaEl ||
  !panelEl ||
  !panelTitleEl ||
  !panelSummaryEl ||
  !panelMetaEl ||
  !panelEventsEl ||
  !panelTimelineEl ||
  !drawerEl ||
  !focusBarEl ||
  !focusLabelEl ||
  !focusExitEl
) {
  throw new Error('图谱页面 DOM 不完整')
}

const els = {
  status: statusEl,
  date: dateEl,
  empty: emptyEl,
  count: countEl,
  container: containerEl,
  consent: consentEl,
  consentButton,
  meta: metaEl,
  panel: panelEl,
  panelTitle: panelTitleEl,
  panelSummary: panelSummaryEl,
  panelMeta: panelMetaEl,
  panelEvents: panelEventsEl,
  panelTimeline: panelTimelineEl as HTMLButtonElement,
  drawer: drawerEl,
  focusBar: focusBarEl,
  focusLabel: focusLabelEl,
  focusExit: focusExitEl
}

let day = startOfDay(Date.now())
let snapshot: InductionSnapshot | null = null
let lastData: GraphDayData = { nodes: [], edges: [] }
let graph: GraphInstance | null = null
let renderer: SigmaInstance | null = null
let modules: SigmaModules | null = null
let hoveredKey: string | null = null
let loading = false
let visibleTypes: VisibleTypes = defaultVisibleTypes()
let focusKey: string | null = null
let focusSet: Set<string> | null = null
let currentEdges: Array<{ source: string; target: string }> = []
const nodeTypeByKey = new Map<string, string>()

const panel = createNodePanel(
  {
    panel: els.panel,
    title: els.panelTitle,
    summary: els.panelSummary,
    meta: els.panelMeta,
    events: els.panelEvents,
    timelineButton: els.panelTimeline
  },
  { openTimeline: (ts) => void window.gotchaGraph.openTimeline(ts) }
)

document.getElementById('panel-close')?.addEventListener('click', () => panel.hide())

const settingsPanel = createSettingsPanel(document.body, window.gotchaGraph, (settings) => {
  void applySavedSettings(settings)
})
document.getElementById('settings')?.addEventListener('click', () => {
  void settingsPanel.open()
})

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '归纳中…',
  backoff: '退避重试',
  error: '上次失败',
  'budget-exhausted': '今日预算已用尽',
  stopped: '未运行'
}

function statusView(current: InductionSnapshot | null): { kind: string; text: string } {
  if (!current) return { kind: 'idle', text: '读取中…' }
  if (!current.consent) return { kind: 'consent', text: '未确认出网' }
  if (!current.client.ok) {
    if (current.client.reason === 'missing-key') {
      return { kind: 'error', text: `未配置密钥（${current.client.apiKeyEnv ?? '环境变量'}）` }
    }
    if (current.client.reason === 'invalid-providers') {
      return { kind: 'error', text: '供应商配置损坏' }
    }
    if (current.client.reason === 'unknown-provider') {
      return { kind: 'error', text: '当前供应商不存在' }
    }
    return { kind: 'error', text: '供应商配置不可用' }
  }
  if (!current.captureRunning && current.status === 'stopped') {
    return { kind: 'idle', text: '采集暂停，归纳已停' }
  }
  if (current.status === 'budget-exhausted') {
    return { kind: 'budget', text: STATUS_LABEL[current.status] }
  }
  if (current.status === 'error') return { kind: 'error', text: '上次归纳失败' }
  if (current.status === 'backoff') return { kind: 'backoff', text: STATUS_LABEL[current.status] }
  if (current.status === 'running') return { kind: 'running', text: STATUS_LABEL[current.status] }
  return {
    kind: current.status === 'idle' ? 'ok' : 'idle',
    text: STATUS_LABEL[current.status] ?? current.status
  }
}

function applySnapshot(next: InductionSnapshot): void {
  snapshot = next
  const view = statusView(next)
  els.status.dataset.kind = view.kind
  els.status.textContent = view.text
  els.consent.hidden = !(next.client.ok && !next.consent)
  const canInduce = next.client.ok && next.captureRunning
  ;(document.getElementById('induce') as HTMLButtonElement | null)?.toggleAttribute(
    'disabled',
    !canInduce
  )
  renderEmpty()
  renderMeta()
}

function renderEmpty(): void {
  let kind = ''
  let text = ''
  if (snapshot && !snapshot.client.ok) {
    kind = 'no-key'
    text =
      snapshot.client.reason === 'missing-key'
        ? `未检测到密钥（${snapshot.client.apiKeyEnv ?? '环境变量'}）；到设置里填写 API Key 保存后立即生效`
        : '供应商配置不可用，请到设置检查'
  } else if (snapshot && !snapshot.consent) {
    kind = 'consent'
    text = '确认出网后才会开始归纳'
  } else if (snapshot && !snapshot.captureRunning) {
    kind = 'paused'
    text = '采集暂停中；恢复记录后继续归纳'
  } else if (lastData.nodes.length === 0 && (lastData.events?.length ?? 0) === 0) {
    kind = 'no-nodes'
    text = '这一天还没有记录到任何事件'
  }
  els.empty.hidden = kind === ''
  if (kind !== '') {
    els.empty.dataset.kind = kind
    els.empty.textContent = text
  }
}

function renderMeta(): void {
  els.meta.textContent = snapshot?.consent
    ? '数据只存本地；出网内容经统一脱敏'
    : '确认出网前不会发送任何内容'
}

function renderCount(data: GraphDayData): void {
  const count = data.nodes.length
  const eventCount = data.events?.length ?? 0
  const totalEdges = data.edges.length
  if (count === 0 && eventCount === 0) {
    els.count.textContent = ''
  } else if (eventCount > 0) {
    els.count.textContent = `${count} 个节点（${count} 个主题 · ${eventCount} 个事件） · ${totalEdges} 条边`
  } else {
    els.count.textContent = `${count} 个节点 · ${totalEdges} 条边`
  }
  els.count.dataset.nodes = String(count)
  els.count.dataset.edges = String(totalEdges)
}

async function ensureModules(): Promise<SigmaModules> {
  if (modules) return modules
  const [graphology, sigma, layout] = await Promise.all([
    import('graphology'),
    import('sigma'),
    import('graphology-layout-forceatlas2')
  ])
  modules = {
    Graph: graphology.default as SigmaModules['Graph'],
    Sigma: sigma.default as SigmaModules['Sigma'],
    forceAtlas2: layout.default as unknown as SigmaModules['forceAtlas2']
  }
  return modules
}

function nodeTypeOf(key: string): string {
  return nodeTypeByKey.get(key) ?? 'unknown'
}

function hiddenNode(key: string): boolean {
  if (focusSet && !focusSet.has(key)) return true
  return !isTypeVisible(nodeTypeOf(key), visibleTypes)
}

function clearFocusState(): void {
  focusKey = null
  focusSet = null
  els.focusBar.hidden = true
}

function exitFocus(): void {
  if (!focusKey && !focusSet) return
  clearFocusState()
  renderer?.refresh()
}

function enterFocus(key: string): void {
  if (!graph || !graph.hasNode(key)) return
  if (!isTypeVisible(nodeTypeOf(key), visibleTypes)) return
  focusSet = focusNodeSet(currentEdges, key)
  focusKey = key
  const label = (graph.getNodeAttribute(key, 'fullLabel') as string | undefined) || key
  els.focusLabel.textContent = label
  els.focusBar.hidden = false
  renderer?.refresh()

  // 聚焦时把相机移到该节点（不改缩放），避免局部图落在视野外
  const position = graph.getNodeAttributes(key) as { x: number; y: number }
  if (renderer && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    const framed = renderer.graphToFramedGraph({ x: position.x, y: position.y })
    void renderer.getCamera().animate({ x: framed.x, y: framed.y }, { duration: 300 })
  }
}

for (const input of filterInputs) {
  input.addEventListener('change', () => {
    const type = input.dataset.typeFilter as GraphTypeKey | undefined
    if (!type || !(type in visibleTypes)) return
    visibleTypes = toggleVisibleType(visibleTypes, type, input.checked)
    if (focusKey && !isTypeVisible(nodeTypeOf(focusKey), visibleTypes)) {
      exitFocus()
    } else {
      renderer?.refresh()
    }
  })
}

els.focusExit.addEventListener('click', () => exitFocus())
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && focusKey) exitFocus()
})

async function renderCanvas(data: GraphDayData): Promise<void> {
  const current = await ensureModules()
  renderer?.kill()
  renderer = null
  graph = null
  hoveredKey = null
  nodeTypeByKey.clear()
  currentEdges = []
  clearFocusState()

  const maxDeg = maxDegree(data)
  const graphInstance = new current.Graph({ multi: false, type: 'undirected' })
  const allEdges: Array<{ source: string; target: string }> = []
  const edgeById = new Map<string, { source: string; target: string }>()

  // 1. 概念 Hub 节点分布：根据主题数量分配充沛的星系半径
  const hubRadius = 140 + 26 * Math.sqrt(Math.max(1, data.nodes.length))
  const nodeCenterMap = new Map<number, { x: number; y: number }>()

  data.nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, data.nodes.length)
    const x = Math.cos(angle) * hubRadius
    const y = Math.sin(angle) * hubRadius
    nodeCenterMap.set(node.id, { x, y })
    graphInstance.addNode(String(node.id), {
      x,
      y,
      size: nodeSize(node.degree, maxDeg),
      color: nodeColor(node.type),
      label: nodeLabel(node.title),
      fullLabel: node.title,
      nodeType: 'concept'
    })
    nodeTypeByKey.set(String(node.id), node.type)
  })

  // 2. 概念节点之间的语义边
  for (const edge of data.edges) {
    const srcKey = String(edge.source)
    const dstKey = String(edge.target)
    if (!graphInstance.hasNode(srcKey) || !graphInstance.hasNode(dstKey)) continue
    if (graphInstance.hasEdge(srcKey, dstKey)) continue
    const edgeKey = String(edge.id)
    graphInstance.addEdgeWithKey(edgeKey, srcKey, dstKey, {
      size: edgeSize(edge.weight),
      color: EDGE_COLOR,
      weight: edge.weight,
      edgeType: 'concept'
    })
    edgeById.set(edgeKey, { source: srcKey, target: dstKey })
    allEdges.push({ source: srcKey, target: dstKey })
  }

  // 3. 事件 Leaf 节点与从属边
  const events = data.events ?? []
  const eventParentMap = new Map<number, number>()
  for (const node of data.nodes) {
    if (node.eventIds) {
      for (const evId of node.eventIds) {
        if (!eventParentMap.has(evId)) eventParentMap.set(evId, node.id)
      }
    }
  }

  events.forEach((ev, i) => {
    const evKey = `ev-${ev.id}`
    const parentNodeId = eventParentMap.get(ev.id)
    let initX = 0
    let initY = 0
    if (parentNodeId !== undefined && nodeCenterMap.has(parentNodeId)) {
      const parentPos = nodeCenterMap.get(parentNodeId)!
      const leafAngle = (2 * Math.PI * (i % 24)) / 24
      const leafDist = 28 + (i % 5) * 8
      initX = parentPos.x + Math.cos(leafAngle) * leafDist
      initY = parentPos.y + Math.sin(leafAngle) * leafDist
    } else {
      const outerAngle = (2 * Math.PI * i) / Math.max(1, events.length)
      const outerRadius = hubRadius + 90
      initX = Math.cos(outerAngle) * outerRadius
      initY = Math.sin(outerAngle) * outerRadius
    }

    graphInstance.addNode(evKey, {
      x: initX,
      y: initY,
      size: EVENT_NODE_SIZE,
      color: '#58677c',
      label: '', // 事件节点默认不显式文字，悬停才显示，防止遮挡
      fullLabel: ev.windowTitle || ev.app,
      nodeType: 'event',
      eventId: ev.id
    })
    nodeTypeByKey.set(evKey, 'event')

    if (parentNodeId !== undefined && graphInstance.hasNode(String(parentNodeId))) {
      const edgeKey = `sub-${parentNodeId}-${ev.id}`
      const parentKey = String(parentNodeId)
      if (!graphInstance.hasEdge(parentKey, evKey)) {
        graphInstance.addEdgeWithKey(edgeKey, parentKey, evKey, {
          size: 1,
          color: SUB_EDGE_COLOR,
          weight: 0.25,
          edgeType: 'sub'
        })
        edgeById.set(edgeKey, { source: parentKey, target: evKey })
        allEdges.push({ source: parentKey, target: evKey })
      }
    }
  })

  // 4. ForceAtlas2 力导向布局：通过连线体现联系，通过远近体现相关性
  currentEdges = allEdges
  current.forceAtlas2.assign(graphInstance, {
    iterations: 180,
    settings: {
      ...current.forceAtlas2.inferSettings(graphInstance),
      edgeWeightInfluence: 1.2,
      gravity: 0.04, // 低向心引力，星团自然舒展
      scalingRatio: 30, // 充沛斥力，拉开优雅间距
      slowDown: 4,
      barnesHutOptimize: true,
      adjustSizes: true // 节点尺寸碰撞防重叠
    }
  })

  graph = graphInstance
  els.container.hidden = false
  renderer = new current.Sigma(graphInstance, els.container, {
    renderLabels: true,
    itemSizesReference: 'screen', // 关键！锁定物理像素，防止缩放膨胀成巨球
    labelDensity: 0.25,
    labelGridCellSize: 80,
    labelRenderedSizeThreshold: 4,
    labelColor: { color: '#abb2bf' },
    labelSize: 11,
    labelFont: 'Segoe UI, -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif',
    defaultEdgeColor: '#20242c',
    minCameraRatio: 0.05,
    maxCameraRatio: 10,
    nodeReducer: (nodeKey: string, attrs: Record<string, unknown>) => {
      if (hiddenNode(nodeKey)) return { ...attrs, visibility: 'hidden' as const }
      if (hoveredKey === null) return attrs
      const keep = neighborKeys(allEdges, hoveredKey)
      if (!keep.has(nodeKey)) {
        return { ...attrs, color: '#161820', label: '' }
      }
      return nodeKey === hoveredKey
        ? {
            ...attrs,
            size: Number(attrs.size ?? 4) * 1.35,
            label: (attrs.fullLabel as string) || (attrs.label as string) || ''
          }
        : attrs
    },
    edgeReducer: (edgeKey: string, attrs: Record<string, unknown>) => {
      const endpoints = edgeById.get(edgeKey)
      if (endpoints && (hiddenNode(endpoints.source) || hiddenNode(endpoints.target))) {
        return { ...attrs, visibility: 'hidden' as const }
      }
      if (hoveredKey === null) return attrs
      if (!endpoints) return attrs
      const relates = endpoints.source === hoveredKey || endpoints.target === hoveredKey
      if (relates) {
        return { ...attrs, color: '#4fc3f7', size: Math.max(1.5, Number(attrs.size ?? 1) * 1.4) }
      }
      return { ...attrs, color: '#14151c' }
    }
  })

  renderer.on('clickNode', (payload: { node: string }) => {
    if (payload.node.startsWith('ev-')) {
      const evId = Number(payload.node.slice(3))
      const ev = (lastData.events ?? []).find((item) => item.id === evId)
      if (ev) {
        const parentId = eventParentMap.get(evId)
        const parent = parentId ? lastData.nodes.find((n) => n.id === parentId) : undefined
        panel.showEvent(ev, parent)
      }
    } else {
      void openNode(Number(payload.node))
    }
  })
  renderer.on('enterNode', (payload: { node: string }) => {
    hoveredKey = payload.node
    renderer?.refresh()
  })
  renderer.on('leaveNode', () => {
    hoveredKey = null
    renderer?.refresh()
  })
  renderer.on('doubleClickNode', (payload: { node: string; preventSigmaDefault?: () => void }) => {
    payload.preventSigmaDefault?.()
    enterFocus(payload.node)
  })
  renderer.on('doubleClickStage', () => {
    if (focusKey) exitFocus()
  })
  renderer.on('clickStage', () => {
    panel.hide()
    if (focusKey) exitFocus()
  })
  void renderer.getCamera().reset()
}

async function openNode(nodeId: number): Promise<void> {
  const node = lastData.nodes.find((item) => item.id === nodeId)
  if (!node) return
  const result = await window.gotchaGraph.nodeEvents(nodeId)
  panel.show(node, result)
}

async function load(): Promise<void> {
  if (loading) return
  loading = true
  els.date.textContent = formatDate(day)
  const { from, to } = dayRange(day)
  try {
    lastData = await window.gotchaGraph.query(from, to)
    renderCount(lastData)
    renderEmpty()
    const totalItems = lastData.nodes.length + (lastData.events?.length ?? 0)
    if (totalItems > 0) {
      await renderCanvas(lastData)
    } else {
      renderer?.kill()
      renderer = null
      graph = null
      els.container.hidden = true
    }
  } catch (error) {
    lastData = { nodes: [], edges: [] }
    renderCount(lastData)
    els.container.hidden = true
    els.empty.hidden = false
    els.empty.dataset.kind = 'error'
    els.empty.textContent = `读取失败：${String(error)}`
  } finally {
    loading = false
  }
}

function shiftDay(delta: number): void {
  const next = new Date(day)
  next.setDate(next.getDate() + delta)
  day = startOfDay(next.getTime())
  void load()
}

async function refreshStatus(): Promise<void> {
  try {
    applySnapshot(await window.gotchaGraph.status())
  } catch {
    // 状态读取失败不阻塞列表
  }
}

async function refresh(): Promise<void> {
  await refreshStatus()
  await load()
}

async function applySavedSettings(settings: GraphSettingsView): Promise<void> {
  await refreshStatus()
  if (settings.outboundConsent) await load()
}

document.getElementById('prev')?.addEventListener('click', () => shiftDay(-1))
document.getElementById('next')?.addEventListener('click', () => shiftDay(1))
document.getElementById('today')?.addEventListener('click', () => {
  day = startOfDay(Date.now())
  void load()
})
document.getElementById('refresh')?.addEventListener('click', () => void refresh())
document.getElementById('timeline')?.addEventListener('click', () => {
  void window.gotchaGraph.openTimeline(day)
})

document.getElementById('induce')?.addEventListener('click', async () => {
  const result: GraphInduceResult = await window.gotchaGraph.induceNow()
  if (result.status === 'ok') {
    await refresh()
    return
  }
  if (result.status === 'skipped' && result.reason === 'consent') {
    els.consent.hidden = false
    return
  }
  if (result.status === 'skipped' && result.reason === 'paused') {
    els.empty.hidden = false
    els.empty.dataset.kind = 'paused'
    els.empty.textContent = '采集暂停中；恢复记录后才能归纳'
    return
  }
  if (result.status === 'skipped' && result.reason === 'not-configured') {
    els.empty.hidden = false
    els.empty.dataset.kind = 'no-key'
    els.empty.textContent = '未配置可用的 LLM 供应商'
    return
  }
  if (result.status === 'error') {
    els.empty.hidden = false
    els.empty.dataset.kind = 'error'
    els.empty.textContent = `归纳失败：${result.message}`
  }
})

els.consentButton.addEventListener('click', async () => {
  try {
    applySnapshot(await window.gotchaGraph.setConsent(true))
    await window.gotchaGraph.induceNow()
    await refresh()
  } catch (error) {
    els.empty.hidden = false
    els.empty.dataset.kind = 'error'
    els.empty.textContent = `确认失败：${String(error)}`
  }
})

window.gotchaGraph.onStatus(applySnapshot)

window.__gotchaGraphView = {
  count: () => lastData.nodes.length,
  select: (nodeId: number) => openNode(nodeId),
  hover: (nodeId: number | null) => {
    hoveredKey = nodeId === null ? null : String(nodeId)
    renderer?.refresh()
  },
  focus: (nodeId: number | string) => enterFocus(String(nodeId)),
  clearFocus: () => exitFocus(),
  filters: () => ({ ...visibleTypes }),
  visibleCounts: () => {
    if (!graph) return { nodes: 0, edges: 0 }
    let nodes = 0
    let edges = 0
    graph.forEachNode((key) => {
      if (!hiddenNode(key)) nodes += 1
    })
    graph.forEachEdge((_edge, _attrs, source, target) => {
      if (!hiddenNode(source) && !hiddenNode(target)) edges += 1
    })
    return { nodes, edges }
  }
}

void refresh()
