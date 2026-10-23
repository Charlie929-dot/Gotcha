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
  edgeSize,
  maxDegree,
  neighborIds,
  nodeColor,
  nodeLabel,
  nodeSize
} from './graph-view'
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
  !drawerEl
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
  drawer: drawerEl
}

let day = startOfDay(Date.now())
let snapshot: InductionSnapshot | null = null
let lastData: GraphDayData = { nodes: [], edges: [] }
let graph: GraphInstance | null = null
let renderer: SigmaInstance | null = null
let modules: SigmaModules | null = null
let hovered: number | null = null
let loading = false

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
        ? `未检测到密钥（${snapshot.client.apiKeyEnv ?? '环境变量'}）；在 userData/.env 或环境变量中配置后重启`
        : '供应商配置不可用，请到设置检查'
  } else if (snapshot && !snapshot.consent) {
    kind = 'consent'
    text = '确认出网后才会开始归纳'
  } else if (snapshot && !snapshot.captureRunning) {
    kind = 'paused'
    text = '采集暂停中；恢复记录后继续归纳'
  } else if (lastData.nodes.length === 0) {
    kind = 'no-nodes'
    text = '这一天还没有归纳出的节点'
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
  els.count.textContent = count === 0 ? '' : `${count} 个节点 · ${data.edges.length} 条边`
  els.count.dataset.nodes = String(count)
  els.count.dataset.edges = String(data.edges.length)
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

async function renderCanvas(data: GraphDayData): Promise<void> {
  const current = await ensureModules()
  renderer?.kill()
  renderer = null
  graph = null
  hovered = null

  const maxDeg = maxDegree(data)
  const graphInstance = new current.Graph({ multi: false, type: 'undirected' })
  data.nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, data.nodes.length)
    const radius = 40 + 14 * Math.sqrt(data.nodes.length)
    graphInstance.addNode(String(node.id), {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: nodeSize(node.degree, maxDeg),
      color: nodeColor(node.type),
      label: nodeLabel(node.title)
    })
  })
  const edgeById = new Map<string, { source: number; target: number }>()
  for (const edge of data.edges) {
    if (!graphInstance.hasNode(String(edge.source)) || !graphInstance.hasNode(String(edge.target))) {
      continue
    }
    if (graphInstance.hasEdge(edge.source, edge.target)) continue
    graphInstance.addEdgeWithKey(String(edge.id), String(edge.source), String(edge.target), {
      size: edgeSize(edge.weight),
      color: EDGE_COLOR,
      weight: edge.weight
    })
    edgeById.set(String(edge.id), { source: edge.source, target: edge.target })
  }

  current.forceAtlas2.assign(graphInstance, {
    iterations: 160,
    settings: {
      ...current.forceAtlas2.inferSettings(graphInstance),
      edgeWeightInfluence: 1,
      gravity: 1,
      scalingRatio: 12,
      slowDown: 5,
      barnesHutOptimize: false
    }
  })

  graph = graphInstance
  els.container.hidden = false
  renderer = new current.Sigma(graphInstance, els.container, {
    renderLabels: true,
    labelDensity: 0.7,
    labelGridCellSize: 70,
    labelRenderedSizeThreshold: 2,
    labelColor: { color: '#c9c9d6' },
    labelSize: 12,
    labelFont: 'Segoe UI, Microsoft YaHei, sans-serif',
    defaultEdgeColor: EDGE_COLOR,
    minCameraRatio: 0.05,
    maxCameraRatio: 12,
    nodeReducer: (node: string, attrs: Record<string, unknown>) => {
      if (hovered === null) return attrs
      const keep = neighborIds(lastData.edges, hovered)
      if (!keep.has(Number(node))) return { ...attrs, color: '#2f2f3b', label: '' }
      return Number(node) === hovered
        ? { ...attrs, size: Number(attrs.size ?? 8) * 1.25 }
        : attrs
    },
    edgeReducer: (edge: string, attrs: Record<string, unknown>) => {
      if (hovered === null) return attrs
      const endpoints = edgeById.get(edge)
      if (!endpoints) return attrs
      const keep = neighborIds(lastData.edges, hovered)
      if (keep.has(endpoints.source) && keep.has(endpoints.target)) return attrs
      return { ...attrs, color: '#242430' }
    }
  })
  renderer.on('clickNode', (payload: { node: string }) => {
    void openNode(Number(payload.node))
  })
  renderer.on('enterNode', (payload: { node: string }) => {
    hovered = Number(payload.node)
    renderer?.refresh()
  })
  renderer.on('leaveNode', () => {
    hovered = null
    renderer?.refresh()
  })
  renderer.on('clickStage', () => panel.hide())
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
    if (lastData.nodes.length > 0) {
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
  count: () => graph?.order ?? 0,
  select: (nodeId: number) => openNode(nodeId),
  hover: (nodeId: number | null) => {
    hovered = nodeId
    renderer?.refresh()
  }
}

void refresh()
