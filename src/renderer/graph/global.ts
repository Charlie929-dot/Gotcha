/**
 * 全局图谱窗口（v0.3 P3-a；docs/m2-graph-redesign.md §7 / §8）
 *
 * - 数据：`graph:global` 一次取全量（主题 + 时刻 + 归属 + embedding 边 + 位置），
 *   客户端只按日历调暗，不重新查库；
 * - 渲染：Foam 活布局（`foam-adapter` 映射），主题大点 + 时刻小点，成员边默认不画；
 * - 时间：日历 popover（单日 / 涂抹 / Ctrl 加减 / Shift 扩展 / 快捷范围），只调暗不删数据；
 * - 侧栏：主题 → 成员事件；时刻 → 原始事件 +「也属于」其它主题；
 * - 旧 sigma 按日页保留为 `graph.html`，工具栏「经典视图」互切；
 * - 沉降后把主题坐标回写 `node_positions`，下次打开作为 seed。
 */

import '../foam/foam-graph'
import type { FoamGraph } from '../foam/foam-graph'
import type { GraphApi } from '../graph-preload'
import type {
  GraphGlobalData,
  GlobalMomentDto,
  GlobalThemeDto,
  NodeEventsResult
} from '../../understand/graph-query'
import type { GraphSettingsView } from '../../main/graph-settings'
import type { InductionSnapshot } from '../../main/induction-runtime'
import type { GraphInduceResult } from '../../main/graph-ipc'
import {
  focusedIdsForDays,
  nodeIdOf,
  themeNodeId,
  timeDimmedIds,
  toFoamGraph,
  toGlobalGraphInput,
  type GlobalGraphInput
} from './foam-adapter'
import {
  dayKey,
  dayRange,
  dayStart,
  editDaySelection,
  formatDayLabel,
  monthGrid,
  monthTitle,
  parseDayKey,
  presetDays,
  shiftMonth,
  type FocusPreset
} from './calendar'
import { createGlobalPanel } from './global-panel'
import { createSettingsPanel } from './graph-settings-panel'
import { statusView } from './status-view'
import './view-hook'

declare global {
  interface Window {
    gotchaGraph: GraphApi
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`全局图谱页面缺少 #${id}`)
  return element as T
}

const graphEl = byId<FoamGraph>('graph')
const statusEl = byId<HTMLSpanElement>('status')
const statusDetailEl = byId<HTMLSpanElement>('status-detail')
const emptyEl = byId<HTMLDivElement>('empty')
const countEl = byId<HTMLDivElement>('node-count')
const consentEl = byId<HTMLElement>('consent')
const consentButton = byId<HTMLButtonElement>('consent-btn')
const metaEl = byId<HTMLElement>('meta')
const onlyThemesEl = byId<HTMLInputElement>('only-themes')
const calendarBtn = byId<HTMLButtonElement>('calendar-btn')
const dayLabelEl = byId<HTMLSpanElement>('day-label')
const calendarEl = byId<HTMLDivElement>('calendar')
const calTitleEl = byId<HTMLElement>('cal-title')
const calGridEl = byId<HTMLDivElement>('cal-grid')
const calPrevEl = byId<HTMLButtonElement>('cal-prev')
const calNextEl = byId<HTMLButtonElement>('cal-next')
const calCloseEl = byId<HTMLButtonElement>('cal-close')
const focusBarEl = byId<HTMLDivElement>('focus-bar')
const focusLabelEl = byId<HTMLElement>('focus-label')
const focusExitEl = byId<HTMLButtonElement>('focus-exit')
const panelEl = byId<HTMLElement>('panel')
const induceEl = byId<HTMLButtonElement>('induce')

const panel = createGlobalPanel(
  {
    panel: panelEl,
    title: byId('panel-title'),
    summary: byId('panel-summary'),
    meta: byId('panel-meta'),
    relatedTitle: byId('panel-related-title'),
    related: byId('panel-related'),
    eventsTitle: byId('panel-events-title'),
    events: byId('panel-events'),
    timelineButton: byId<HTMLButtonElement>('panel-timeline')
  },
  {
    openTimeline: (ts) => void window.gotchaGraph.openTimeline(ts),
    selectTheme: (themeId) => {
      graphEl.selectNode(themeNodeId(themeId))
      showFocus(themeNodeId(themeId))
      void openNodeKey(themeNodeId(themeId))
    }
  }
)
byId('panel-close').addEventListener('click', () => panel.hide())

let data: GraphGlobalData | null = null
let input: GlobalGraphInput | null = null
let themeById = new Map<number, GlobalThemeDto>()
let momentById = new Map<number, GlobalMomentDto>()
let days: Set<string> | null = null
let snapshot: InductionSnapshot | null = null
let statusFlashTimer: ReturnType<typeof setTimeout> | null = null
let loading = false
let loadSeq = 0
let panelSeq = 0
let onlyThemes = false
let dragging: { anchor: string } | null = null
let calYear = new Date().getFullYear()
let calMonth = new Date().getMonth()
let settleMs: number | null = null
let loadStartedAt = 0
let savingPositions = false

const settingsPanel = createSettingsPanel(document.body, window.gotchaGraph, (settings) => {
  void applySavedSettings(settings)
})
byId('settings').addEventListener('click', () => void settingsPanel.open())

/* --------------------------------- 数据加载 -------------------------------- */

async function load(): Promise<void> {
  if (loading) return
  loading = true
  const seq = ++loadSeq
  emptyEl.hidden = true
  try {
    const next = await window.gotchaGraph.global()
    if (seq !== loadSeq) return
    data = next
    input = toGlobalGraphInput(next)
    themeById = new Map(next.themes.map((theme) => [theme.id, theme]))
    momentById = new Map(next.moments.map((moment) => [moment.id, moment]))
    const view = toFoamGraph(input)
    const seeds = new Map(
      next.positions.map((position) => [themeNodeId(position.nodeId), { x: position.x, y: position.y }])
    )
    settleMs = null
    loadStartedAt = performance.now()

    // 先清空旧节点（否则同 id 节点复用旧坐标），下一帧再灌新数据。
    graphEl.graphData = null
    requestAnimationFrame(() => {
      if (seq !== loadSeq) return
      graphEl.seedPositions = seeds
      graphEl.graphData = view.data
      applyTimeFocus(false)
      updateCount()
      updateHud()
    })
  } catch (error) {
    if (seq !== loadSeq) return
    data = null
    input = null
    graphEl.graphData = null
    updateCount()
    showEmpty('error', `读取全局图失败：${String(error)}`)
  } finally {
    if (seq === loadSeq) loading = false
  }
}

/* ---------------------------------- 图配置 --------------------------------- */

graphEl.forces = { collide: 1, repel: 38, link: 60, velocityDecay: 0.35 }
graphEl.labels = { fade: 0 }
graphEl.maxFitZoom = 1.8
graphEl.linkDistanceMin = 18
graphEl.linkDistanceMax = 140
graphEl.edgeThreshold = 0.64
graphEl.showMembershipLinks = false
graphEl.linkWidthMultiplier = 2
graphEl.selection = { neighborDepth: 1, centerOnSelect: true, zoomOnSelect: false }

/* --------------------------------- 位置 seed ------------------------------- */

graphEl.addEventListener('graph-settled', (event) => {
  const positions = (event as CustomEvent<Array<{ id: string; x: number; y: number }>>).detail
  const themes = positions.filter(
    (item) => item.id.startsWith('t:') && Number.isFinite(item.x) && Number.isFinite(item.y)
  )
  graphEl.seedPositions = new Map(themes.map((item) => [item.id, { x: item.x, y: item.y }]))
  if (settleMs === null) {
    settleMs = Math.round(performance.now() - loadStartedAt)
    updateHud()
  }
  if (savingPositions || themes.length === 0) return
  savingPositions = true
  void window.gotchaGraph
    .savePositions(
      themes.map((item) => ({ nodeId: nodeIdOf(item.id), x: item.x, y: item.y }))
    )
    .catch(() => {
      // 坐标只是 seed，写失败不影响浏览；下次沉降会再试。
    })
    .finally(() => {
      savingPositions = false
    })
})

/* ---------------------------------- 交互 ---------------------------------- */

graphEl.addEventListener('node-click', (event) => {
  const id = (event as CustomEvent<string>).detail
  showFocus(id)
  // §7.4：单击时刻 = 直接看侧栏（单点聚焦无意义）；主题单击只聚焦。
  if (id.startsWith('m:')) {
    void openNodeKey(id)
  } else {
    panel.hide()
  }
})

graphEl.addEventListener('node-open', (event) => {
  void openNodeKey((event as CustomEvent<string>).detail)
})

graphEl.addEventListener('canvas-background-click', () => {
  panel.hide()
  hideFocus()
})

focusExitEl.addEventListener('click', () => {
  graphEl.clearSelection()
  hideFocus()
})

byId('fit').addEventListener('click', () => graphEl.zoomToFit(400))
byId('reheat').addEventListener('click', () => graphEl.reheat())
byId('view-classic').addEventListener('click', () => {
  window.location.href = './graph.html'
})
byId('timeline').addEventListener('click', () => {
  void window.gotchaGraph.openTimeline()
})

function showFocus(id: string): void {
  focusBarEl.hidden = false
  focusLabelEl.textContent = nodeTitle(id)
}

function hideFocus(): void {
  focusBarEl.hidden = true
}

function nodeTitle(id: string): string {
  if (id.startsWith('t:')) {
    const theme = themeById.get(Number(id.slice(2)))
    return theme?.title || id
  }
  const moment = momentById.get(Number(id.slice(2)))
  return moment ? `${moment.app ?? ''} · ${moment.windowTitle || moment.ocrSummary || ''}` : id
}

function keyOf(value: number | string): string {
  if (typeof value === 'number') return themeNodeId(value)
  if (value.startsWith('t:') || value.startsWith('m:')) return value
  const numeric = Number(value)
  return Number.isFinite(numeric) ? themeNodeId(numeric) : value
}

async function openNodeKey(key: string): Promise<void> {
  const seq = ++panelSeq
  if (key.startsWith('t:')) {
    const themeId = nodeIdOf(key)
    const theme = themeById.get(themeId)
    if (!theme) return
    const result = await window.gotchaGraph.nodeEvents(themeId)
    if (seq !== panelSeq) return
    panel.showTheme(theme, result)
    return
  }
  if (key.startsWith('m:')) {
    const momentId = nodeIdOf(key)
    const moment = momentById.get(momentId)
    if (!moment) return
    const themeIds = input?.moments.find((item) => item.id === momentId)?.themeIds ?? []
    const themes = themeIds
      .map((themeId) => themeById.get(themeId))
      .filter((theme): theme is GlobalThemeDto => theme !== undefined)
    const result: NodeEventsResult = await window.gotchaGraph.momentEvents(momentId)
    if (seq !== panelSeq) return
    panel.showMoment(moment, result, themes)
  }
}

/* -------------------------------- 日历弹层 -------------------------------- */

calendarBtn.addEventListener('click', () => {
  if (!calendarEl.hidden) {
    calendarEl.hidden = true
    return
  }
  const anchor = days && days.size > 0 ? [...days].sort()[0] : dayKey(Date.now())
  const [y, m] = anchor.split('-').map(Number)
  calYear = y
  calMonth = m - 1
  calendarEl.hidden = false
  renderCalendar()
})

calCloseEl.addEventListener('click', () => {
  calendarEl.hidden = true
})

calPrevEl.addEventListener('click', () => {
  const next = shiftMonth(calYear, calMonth, -1)
  calYear = next.year
  calMonth = next.month
  renderCalendar()
})

calNextEl.addEventListener('click', () => {
  const next = shiftMonth(calYear, calMonth, 1)
  calYear = next.year
  calMonth = next.month
  renderCalendar()
})

for (const button of Array.from(calendarEl.querySelectorAll<HTMLButtonElement>('[data-preset]'))) {
  button.addEventListener('click', () => {
    days = presetDays(Date.now(), button.dataset.preset as FocusPreset)
    applyTimeFocus(true)
    renderCalendar()
  })
}

// 捕获阶段判断「点在外面」：此时 target 还在 DOM 里。
// 之前放在冒泡阶段，而日格的 mousedown 会重建网格，target 已被摘掉，
// `contains()` 于是误判成「点在外面」→ 一碰日期弹层就关（涂抹更无从谈起）。
document.addEventListener(
  'mousedown',
  (event) => {
    if (calendarEl.hidden) return
    const target = event.target as Node
    if (calendarEl.contains(target) || calendarBtn.contains(target)) return
    calendarEl.hidden = true
  },
  true
)

document.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = null
  applyTimeFocus(true)
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  calendarEl.hidden = true
  panel.hide()
  graphEl.clearSelection()
  hideFocus()
})

function renderCalendar(): void {
  calTitleEl.textContent = monthTitle(calYear, calMonth)
  calGridEl.textContent = ''
  for (const day of monthGrid(calYear, calMonth)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = String(Number(day.key.slice(8)))
    button.dataset.key = day.key
    button.draggable = false
    if (!day.inMonth) button.classList.add('dim')
    button.addEventListener('mousedown', (event) => onDayMouseDown(event, day.key))
    button.addEventListener('mouseenter', (event) => onDayMouseEnter(event, day.key))
    calGridEl.appendChild(button)
  }
  paintCalendar()
}

/**
 * 只重刷选中 / 今天的样式，不重建 DOM。
 * 涂抹时鼠标下的格子每次都重建的话，浏览器拿不到稳定的 hover 目标，
 * 既会掉 mouseenter，也会让 mousedown 的 target 变成游离节点。
 */
function paintCalendar(): void {
  const today = dayKey(Date.now())
  for (const button of Array.from(calGridEl.querySelectorAll<HTMLButtonElement>('button'))) {
    const key = button.dataset.key ?? ''
    button.classList.toggle('on', days !== null && days.has(key))
    button.classList.toggle('today', key === today)
  }
}

function onDayMouseDown(event: MouseEvent, key: string): void {
  if (event.button !== 0) return
  // 不让浏览器去选区 / 拖图，省得涂抹时整片文字被选蓝。
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) {
    dragging = null
    days = editDaySelection(days, key, 'toggle')
  } else if (event.shiftKey) {
    dragging = null
    const anchor = days && days.size > 0 ? [...days].sort()[0] : key
    days = dayRange(anchor, key)
  } else {
    dragging = { anchor: key }
    days = new Set([key])
  }
  applyTimeFocus(false)
  paintCalendar()
}

function onDayMouseEnter(event: MouseEvent, key: string): void {
  if (!dragging) return
  // 在窗口外松开就收不到 mouseup：用按键状态兜底，免得「松手了还在涂」。
  if ((event.buttons & 1) === 0) {
    dragging = null
    applyTimeFocus(true)
    return
  }
  days = dayRange(dragging.anchor, key)
  applyTimeFocus(false)
  paintCalendar()
}

/* ------------------------------ 时间筛选应用 ------------------------------ */

function applyTimeFocus(fitCamera: boolean): void {
  if (!input) return
  graphEl.dimmedNodeIds = timeDimmedIds(input, days)
  dayLabelEl.textContent = formatDayLabel(days)
  renderEmpty()
  updateCount()

  if (!fitCamera) return
  if (days === null) {
    graphEl.zoomToFit(500)
    return
  }
  const focused = focusedIdsForDays(input, days)
  const ids = onlyThemes ? focused.themeIds : [...focused.themeIds, ...focused.momentIds]
  if (ids.length === 0) return
  graphEl.zoomToFitNodes(ids)
}

onlyThemesEl.addEventListener('change', () => {
  onlyThemes = onlyThemesEl.checked
  graphEl.setNodeTypeVisible('moment', !onlyThemes)
  applyTimeFocus(true)
})

/* ---------------------------------- 计数 ---------------------------------- */

function renderEmpty(): void {
  let kind = ''
  let text = ''
  const hasData = data !== null && (data.themes.length > 0 || data.moments.length > 0)
  if (hasData) {
    // 有图可看时状态徽标 / 同意条已足够，不再用空态盖住画布（G5 §7.4）。
    if (days !== null && input) {
      const focused = focusedIdsForDays(input, days)
      if (focused.themeIds.length === 0 && focused.momentIds.length === 0) {
        kind = 'no-range'
        text = '所选日期没有主题或时刻（数据仍在，只是被调暗）'
      }
    }
  } else if (snapshot && !snapshot.client.ok) {
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
  } else {
    kind = 'no-nodes'
    text = '还没有主题；归纳完成后这里会出现主题与时刻'
  }
  emptyEl.hidden = kind === ''
  if (kind !== '') {
    emptyEl.dataset.kind = kind
    emptyEl.textContent = text
  }
}

function showEmpty(kind: string, text: string): void {
  emptyEl.hidden = false
  emptyEl.dataset.kind = kind
  emptyEl.textContent = text
}

function visibleCounts(): { nodes: number; edges: number; themes: number; moments: number } {
  const themes = data?.themes.length ?? 0
  const moments = onlyThemes ? 0 : data?.moments.length ?? 0
  const memberships = onlyThemes
    ? 0
    : (input?.moments.reduce((sum, moment) => sum + moment.themeIds.length, 0) ?? 0)
  return {
    nodes: themes + moments,
    edges: (data?.edges.length ?? 0) + memberships,
    themes,
    moments
  }
}

function updateCount(): void {
  const counts = visibleCounts()
  countEl.dataset.nodes = String(counts.nodes)
  countEl.dataset.edges = String(counts.edges)
  countEl.dataset.themes = String(counts.themes)
  countEl.dataset.moments = String(counts.moments)
  if (!input) {
    countEl.textContent = ''
    return
  }
  const total = `${input.themes.length} 个主题 · ${onlyThemes ? '只看主题' : `${input.moments.length} 个时刻`} · ${input.edges.length} 条相似连线`
  if (days === null) {
    countEl.textContent = total
    return
  }
  const focused = focusedIdsForDays(input, days)
  const momentPart = onlyThemes ? '只看主题' : `${focused.momentIds.length}/${input.moments.length} 个时刻`
  countEl.textContent = `${focused.themeIds.length}/${input.themes.length} 个主题 · ${momentPart} · ${input.edges.length} 条相似连线（范围内）`
}

function updateHud(): void {
  if (!input) return
  const counts = visibleCounts()
  const settle = settleMs === null ? '沉降中…' : `沉降 ${settleMs} ms`
  byId('hud').textContent = `${counts.nodes} 节点 · ${counts.edges} 连线 · ${settle}`
}

/* --------------------------------- 状态 ---------------------------------- */

function applySnapshot(next: InductionSnapshot): void {
  if (statusFlashTimer !== null) {
    clearTimeout(statusFlashTimer)
    statusFlashTimer = null
  }
  snapshot = next
  const view = statusView(next)
  statusEl.dataset.kind = view.kind
  statusEl.textContent = view.text
  statusEl.title = view.detail
  statusDetailEl.textContent = view.detail
  statusDetailEl.hidden = view.detail === ''
  consentEl.hidden = !(next.client.ok && !next.consent)
  induceEl.disabled = !(next.client.ok && next.captureRunning)
  metaEl.textContent = next.consent
    ? '数据只存本地；出网内容经统一脱敏'
    : '确认出网前不会发送任何内容'
  renderEmpty()
}

function flashStatus(text: string, kind: string): void {
  if (statusFlashTimer !== null) clearTimeout(statusFlashTimer)
  statusEl.dataset.kind = kind
  statusEl.textContent = text
  statusEl.title = ''
  statusDetailEl.textContent = ''
  statusDetailEl.hidden = true
  statusFlashTimer = setTimeout(() => {
    statusFlashTimer = null
    if (snapshot) applySnapshot(snapshot)
  }, 4_000)
}

async function refreshStatus(): Promise<void> {
  try {
    applySnapshot(await window.gotchaGraph.status())
  } catch {
    // 状态读取失败不阻塞图
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

window.gotchaGraph.onStatus(applySnapshot)

/* --------------------------------- 归纳 ---------------------------------- */

induceEl.addEventListener('click', async () => {
  const target =
    days !== null && days.size === 1
      ? parseDayKey([...days][0])
      : dayStart(Date.now())
  induceEl.disabled = true
  try {
    let nodes = 0
    let edges = 0
    let placeholders = 0
    let more = false
    let result: GraphInduceResult | null = null
    for (let batch = 0; batch < 10; batch += 1) {
      result = await window.gotchaGraph.induceNow(target)
      if (result.status !== 'ok') break
      nodes += result.nodes
      edges += result.edges
      placeholders += result.placeholders
      more = result.more === true
      if (!more) break
    }

    if (result?.status === 'ok') {
      await load()
      flashStatus(
        nodes > 0
          ? `已归纳 ${nodes} 个节点 · ${edges} 条边${more ? '（还有剩余，可再点一次）' : ''}`
          : placeholders > 0
            ? '已生成本地保护占位'
            : '这一天已是最新',
        'ok'
      )
    } else if (result?.status === 'empty') {
      flashStatus(nodes > 0 ? `已归纳 ${nodes} 个节点 · ${edges} 条边` : '这一天已是最新', 'ok')
    } else if (result?.status === 'skipped') {
      if (result.reason === 'consent') consentEl.hidden = false
      else if (result.reason === 'paused') showEmpty('paused', '采集暂停中；恢复记录后才能归纳')
      else if (result.reason === 'in-flight') flashStatus('归纳进行中，请稍候', 'idle')
      else if (result.reason === 'not-configured') showEmpty('no-key', '未配置可用的 LLM 供应商')
      else if (result.reason === 'budget') flashStatus('今日预算已用尽', 'budget')
    } else if (result?.status === 'error') {
      showEmpty('error', `归纳失败：${result.message}`)
    }
  } finally {
    induceEl.disabled = false
    void refreshStatus()
  }
})

consentButton.addEventListener('click', async () => {
  try {
    applySnapshot(await window.gotchaGraph.setConsent(true))
    await window.gotchaGraph.induceNow(days !== null && days.size === 1 ? parseDayKey([...days][0]) : undefined)
    await load()
  } catch (error) {
    showEmpty('error', `确认失败：${String(error)}`)
  }
})

byId('refresh').addEventListener('click', () => void refresh())

/* --------------------------------- E2E 钩子 -------------------------------- */

window.__gotchaGraphView = {
  count: () => visibleCounts().nodes,
  select: (nodeId) => openNodeKey(keyOf(nodeId)),
  hover: () => {},
  focus: (nodeId) => {
    const key = keyOf(nodeId)
    graphEl.selectNode(key)
    showFocus(key)
  },
  clearFocus: () => {
    graphEl.clearSelection()
    hideFocus()
  },
  position: (nodeId) => graphEl.nodePosition(keyOf(nodeId)),
  filters: () => ({ moment: !onlyThemes }),
  visibleCounts,
  dimmedCount: () => graphEl.dimmedNodeIds?.size ?? 0,
  focusDays: () => (days === null ? null : [...days].sort()),
  setDays: (list) => {
    days = list === null ? null : new Set(list)
    applyTimeFocus(true)
    renderCalendar()
  },
  onlyThemes: () => onlyThemes,
  setOnlyThemes: (value) => {
    onlyThemesEl.checked = value
    onlyThemes = value
    graphEl.setNodeTypeVisible('moment', !value)
    applyTimeFocus(true)
  },
  nodeIds: () => Object.keys(graphEl.graphData?.nodeInfo ?? {})
}

void refresh()
