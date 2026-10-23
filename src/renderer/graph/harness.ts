/**
 * P0 harness：用合成数据验证 Foam 全局图的活布局、碰撞、时间 dimmed 与日历原型。
 *
 * 与生产图谱页（`graph.ts`，sigma）并存，不接 IPC、不碰用户库；P1 起由
 * 真实 `graph:query` DTO + `foam-adapter` 替换数据源即可复用本页交互。
 */

import '../foam/foam-graph'
import type { FoamGraph } from '../foam/foam-graph'
import {
  DATASET_PROFILES,
  DATASET_SIZES,
  buildSyntheticGraph,
  type DatasetSize
} from './harness-data'
import {
  focusedIdsForDays,
  momentNodeId,
  themeNodeId,
  timeDimmedIds,
  toFoamGraph,
  type GlobalGraphInput,
  type MomentSeed,
  type ThemeSeed
} from './foam-adapter'
import {
  dayKey,
  dayRange,
  editDaySelection,
  formatDayLabel,
  monthGrid,
  monthTitle,
  presetDays,
  shiftMonth,
  type FocusPreset
} from './calendar'

const POSITIONS_KEY = 'gotcha.foam.harness.positions'
const DATASET_KEY = 'gotcha.foam.harness.dataset'
const DAY_MS = 24 * 60 * 60 * 1000

const graphEl = document.getElementById('graph') as FoamGraph
const statusEl = document.getElementById('status') as HTMLSpanElement
const countEl = document.getElementById('count') as HTMLDivElement
const hudEl = document.getElementById('hud') as HTMLDivElement
const emptyEl = document.getElementById('empty') as HTMLDivElement
const datasetEl = document.getElementById('dataset') as HTMLSelectElement
const onlyThemesEl = document.getElementById('only-themes') as HTMLInputElement
const calendarBtn = document.getElementById('calendar-btn') as HTMLButtonElement
const dayLabelEl = document.getElementById('day-label') as HTMLSpanElement
const calendarEl = document.getElementById('calendar') as HTMLDivElement
const calTitleEl = document.getElementById('cal-title') as HTMLElement
const calGridEl = document.getElementById('cal-grid') as HTMLDivElement
const calPrevEl = document.getElementById('cal-prev') as HTMLButtonElement
const calNextEl = document.getElementById('cal-next') as HTMLButtonElement
const focusBarEl = document.getElementById('focus-bar') as HTMLDivElement
const focusLabelEl = document.getElementById('focus-label') as HTMLElement
const focusExitEl = document.getElementById('focus-exit') as HTMLButtonElement
const panelEl = document.getElementById('panel') as HTMLElement
const panelTitleEl = document.getElementById('panel-title') as HTMLElement
const panelMetaEl = document.getElementById('panel-meta') as HTMLElement
const panelBodyEl = document.getElementById('panel-body') as HTMLElement
const panelCloseEl = document.getElementById('panel-close') as HTMLButtonElement
const fitEl = document.getElementById('fit') as HTMLButtonElement
const reheatEl = document.getElementById('reheat') as HTMLButtonElement
const resetLayoutEl = document.getElementById('reset-layout') as HTMLButtonElement

if (!graphEl) throw new Error('harness DOM 不完整：缺少 foam-graph')

let dataset: DatasetSize = readDataset()
let input: GlobalGraphInput
let themeById = new Map<number, ThemeSeed>()
let momentById = new Map<number, MomentSeed>()
let days: Set<string> | null = null
let lastClickedKey: string | null = null
let dragging: { anchor: string } | null = null
let calYear = new Date().getFullYear()
let calMonth = new Date().getMonth()
let settleMs: number | null = null
let loadStartedAt = 0
/** 布局中的实际渲染 FPS（按 Foam 渲染帧差值算；静止时保留最后一次布局值）。 */
let fps = 0
let engineIdle = true
let lastStats = { frames: 0, ticks: 0 }
let lastFpsAt = 0

function readDataset(): DatasetSize {
  const stored = localStorage.getItem(DATASET_KEY)
  return stored === '1k' || stored === '2k' || stored === 'base' ? stored : 'base'
}

for (const size of DATASET_SIZES) {
  const option = document.createElement('option')
  option.value = size
  option.textContent = DATASET_PROFILES[size].label
  datasetEl.appendChild(option)
}
datasetEl.value = dataset

function loadDataset(next: DatasetSize) {
  dataset = next
  localStorage.setItem(DATASET_KEY, next)
  const synthetic = buildSyntheticGraph(next, Date.now())
  input = synthetic.input
  const view = toFoamGraph(input)
  themeById = new Map(input.themes.map(theme => [theme.id, theme]))
  momentById = new Map(input.moments.map(moment => [moment.id, moment]))
  days = null
  lastClickedKey = null
  settleMs = null
  fps = 0
  lastStats = graphEl.stats()
  lastFpsAt = performance.now()
  loadStartedAt = performance.now()
  updateDatasetLabel()
  dayLabelEl.textContent = formatDayLabel(days)

  // 先清空旧节点（否则同 id 节点会复用旧坐标），下一帧再灌新数据。
  graphEl.graphData = null
  requestAnimationFrame(() => {
    graphEl.seedPositions = loadPositions(next)
    graphEl.graphData = view.data
    applyTimeFocus(false)
    updateStatus(`就绪 · ${input.themes.length} 主题 / ${input.moments.length} 时刻 / ${input.edges.length} 条相似连线`)
    updateCount()
    updateHud()
  })
}

function updateDatasetLabel() {
  datasetEl.value = dataset
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

/* ---------------------------------- 位置 seed ------------------------------ */

interface StoredPosition {
  id: string
  x: number
  y: number
}

function loadPositions(size: DatasetSize): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  try {
    const raw = localStorage.getItem(`${POSITIONS_KEY}.${size}`)
    if (!raw) return positions
    const list = JSON.parse(raw) as StoredPosition[]
    for (const item of list) {
      if (typeof item.id === 'string' && Number.isFinite(item.x) && Number.isFinite(item.y)) {
        positions.set(item.id, { x: item.x, y: item.y })
      }
    }
  } catch {
    // 位置只是 seed，损坏时退化为重新布局。
  }
  return positions
}

function savePositions(list: StoredPosition[]) {
  try {
    localStorage.setItem(`${POSITIONS_KEY}.${dataset}`, JSON.stringify(list))
  } catch {
    // localStorage 配额不足时忽略：位置不是事实源。
  }
}

graphEl.addEventListener('graph-settled', event => {
  const positions = (event as CustomEvent<StoredPosition[]>).detail
  savePositions(positions)
  // 沉降后的坐标回填成 seed：重开时刻层/切档时新节点原地重建，不再整图重排。
  graphEl.seedPositions = new Map(positions.map(item => [item.id, { x: item.x, y: item.y }]))
  if (settleMs === null) {
    settleMs = Math.round(performance.now() - loadStartedAt)
    updateHud()
  }
})

/* ---------------------------------- 交互 ---------------------------------- */

graphEl.addEventListener('node-click', event => {
  const id = (event as CustomEvent<string>).detail
  showFocus(id)
  // 方案 §7.4：单击时刻 = 直接看侧栏（聚焦对单点没有意义）；主题单击才聚焦。
  if (id.startsWith('m:')) showPanel(id)
})

graphEl.addEventListener('node-open', event => {
  const id = (event as CustomEvent<string>).detail
  showPanel(id)
})

graphEl.addEventListener('canvas-background-click', () => {
  hideFocus()
})

focusExitEl.addEventListener('click', () => {
  graphEl.clearSelection()
  hideFocus()
})

panelCloseEl.addEventListener('click', () => {
  panelEl.hidden = true
})

fitEl.addEventListener('click', () => {
  graphEl.zoomToFit(400)
})

reheatEl.addEventListener('click', () => {
  graphEl.reheat()
})

resetLayoutEl.addEventListener('click', () => {
  localStorage.removeItem(`${POSITIONS_KEY}.${dataset}`)
  graphEl.seedPositions = new Map()
  const data = graphEl.graphData
  graphEl.graphData = null
  requestAnimationFrame(() => {
    graphEl.graphData = data
    updateStatus('已重置布局 seed，重新沉降中…')
  })
})

function showFocus(id: string) {
  focusBarEl.hidden = false
  focusLabelEl.textContent = nodeTitle(id)
}

function hideFocus() {
  focusBarEl.hidden = true
}

function nodeTitle(id: string): string {
  if (id.startsWith('t:')) return themeById.get(Number(id.slice(2)))?.title ?? id
  const moment = momentById.get(Number(id.slice(2)))
  return moment ? `${moment.app} · ${moment.title}` : id
}

/* -------------------------------- 日历弹层 -------------------------------- */

calendarBtn.addEventListener('click', () => {
  calendarEl.hidden = !calendarEl.hidden
  if (!calendarEl.hidden) {
    const anchor = days && days.size > 0 ? [...days].sort()[0] : dayKey(Date.now())
    const [y, m] = anchor.split('-').map(Number)
    calYear = y
    calMonth = m - 1
    renderCalendar()
  }
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
    const preset = button.dataset.preset as FocusPreset
    days = presetDays(Date.now(), preset)
    lastClickedKey = null
    applyTimeFocus(true)
    renderCalendar()
  })
}

document.addEventListener('mousedown', event => {
  if (calendarEl.hidden) return
  const target = event.target as Node
  if (calendarEl.contains(target) || calendarBtn.contains(target)) return
  calendarEl.hidden = true
})

document.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = null
  applyTimeFocus(true)
})

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  calendarEl.hidden = true
  panelEl.hidden = true
  graphEl.clearSelection()
  hideFocus()
})

function renderCalendar() {
  calTitleEl.textContent = monthTitle(calYear, calMonth)
  calGridEl.textContent = ''
  const today = dayKey(Date.now())
  for (const day of monthGrid(calYear, calMonth)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = String(Number(day.key.slice(8)))
    button.dataset.key = day.key
    if (!day.inMonth) button.classList.add('dim')
    if (days !== null && days.has(day.key)) button.classList.add('on')
    if (day.key === today) button.classList.add('today')
    button.addEventListener('mousedown', event => onDayMouseDown(event, day.key))
    button.addEventListener('mouseenter', () => onDayMouseEnter(day.key))
    calGridEl.appendChild(button)
  }
}

function onDayMouseDown(event: MouseEvent, key: string) {
  if (event.ctrlKey || event.metaKey) {
    days = editDaySelection(days, key, 'toggle')
    lastClickedKey = key
    applyTimeFocus(true)
    renderCalendar()
    return
  }
  if (event.shiftKey && lastClickedKey) {
    days = dayRange(lastClickedKey, key)
    applyTimeFocus(true)
    renderCalendar()
    return
  }
  dragging = { anchor: key }
  days = new Set([key])
  lastClickedKey = key
  applyTimeFocus(false)
  renderCalendar()
}

function onDayMouseEnter(key: string) {
  if (!dragging) return
  days = dayRange(dragging.anchor, key)
  applyTimeFocus(false)
  renderCalendar()
}

/* ------------------------------ 时间筛选应用 ------------------------------ */

function applyTimeFocus(fitCamera: boolean) {
  if (!input) return
  graphEl.dimmedNodeIds = timeDimmedIds(input, days)
  const focused = focusedIdsForDays(input, days)
  const onlyThemes = onlyThemesEl.checked
  dayLabelEl.textContent = formatDayLabel(days)
  updateCount()

  if (days !== null && focused.themeIds.length === 0 && focused.momentIds.length === 0) {
    showEmpty('所选日期没有主题或时刻（数据仍在，只是被调暗）')
    return
  }
  hideEmpty()
  if (!fitCamera) return
  if (days === null) {
    graphEl.zoomToFit(500)
    return
  }
  const ids = onlyThemes ? focused.themeIds : [...focused.themeIds, ...focused.momentIds]
  graphEl.zoomToFitNodes(ids)
}

onlyThemesEl.addEventListener('change', () => {
  graphEl.setNodeTypeVisible('moment', !onlyThemesEl.checked)
  applyTimeFocus(true)
})

datasetEl.addEventListener('change', () => {
  loadDataset(datasetEl.value as DatasetSize)
})

function showEmpty(message: string) {
  emptyEl.hidden = false
  emptyEl.textContent = message
}

function hideEmpty() {
  emptyEl.hidden = true
}

/* ---------------------------------- 计数 ---------------------------------- */

function updateCount() {
  if (!input) return
  if (days === null) {
    countEl.textContent = `${input.themes.length} 主题 · ${input.moments.length} 时刻 · ${input.edges.length} 条相似连线`
    return
  }
  const onlyThemes = onlyThemesEl.checked
  const focused = focusedIdsForDays(input, days)
  const momentPart = onlyThemes ? '只看主题' : `${focused.momentIds.length}/${input.moments.length} 时刻`
  countEl.textContent = `${focused.themeIds.length}/${input.themes.length} 主题 · ${momentPart} · ${input.edges.length} 条相似连线（只在范围内的可见）`
}

function updateStatus(text: string) {
  statusEl.textContent = text
  statusEl.dataset.kind = 'ready'
}

function updateHud() {
  if (!input) return
  const nodes = Object.keys(viewNodes()).length
  const links = input.edges.length + input.moments.reduce((sum, moment) => sum + moment.themeIds.length, 0)
  const fpsText = fps > 0 ? `布局 FPS ${fps.toFixed(0)}${engineIdle ? '（静止）' : ''}` : '布局中…'
  hudEl.textContent = `${fpsText} · ${nodes} 节点 · ${links} 连线${settleMs === null ? ' · 沉降中…' : ` · 沉降 ${settleMs} ms`}`
}

function viewNodes(): Record<string, unknown> {
  return graphEl.graphData?.nodeInfo ?? {}
}

function frame(ts: number) {
  if (ts - lastFpsAt >= 500) {
    const current = graphEl.stats()
    const elapsed = ts - lastFpsAt
    const running = current.ticks !== lastStats.ticks
    engineIdle = !running
    if (running && lastFpsAt !== 0) {
      fps = ((current.frames - lastStats.frames) * 1000) / elapsed
    }
    lastStats = current
    lastFpsAt = ts
    if (input) updateHud()
  }
  requestAnimationFrame(frame)
}

/* ---------------------------------- 侧栏 ---------------------------------- */

function showPanel(id: string) {
  panelEl.hidden = false
  panelBodyEl.textContent = ''
  const moment = id.startsWith('m:') ? momentById.get(Number(id.slice(2))) : undefined
  const theme = id.startsWith('t:') ? themeById.get(Number(id.slice(2))) : undefined

  if (moment) {
    panelTitleEl.textContent = `${moment.app} · ${moment.title}`
    panelMetaEl.textContent = `${moment.dayKey} · ${formatClock(moment.ts)} · 原始事件不上画布（P1 接线）`
    const others = moment.themeIds.slice(1).map(themeId => themeById.get(themeId)).filter(Boolean) as ThemeSeed[]
    addSection('也属于', others.length === 0
      ? [hint('仅主归属（多归属时刻会在这里列出其它主题）')]
      : others.map(theme => listItem(theme.title, () => {
        graphEl.selectNode(themeNodeId(theme.id))
        showFocus(themeNodeId(theme.id))
      })))
    return
  }

  if (theme) {
    panelTitleEl.textContent = theme.title
    panelMetaEl.textContent = `${theme.type} · ${formatRange(theme.tsStart, theme.tsEnd)} · ${theme.sourceCount} 个成员事件`
    const members = input.moments
      .filter(momentItem => momentItem.themeIds.includes(theme.id))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 12)
    addSection(`成员时刻（${members.length}${members.length === 12 ? '+' : ''}）`, members.length === 0
      ? [hint('这个主题暂时没有可下钻的时刻')]
      : members.map(member => listItem(
        `${member.dayKey} · ${member.app} · ${member.title}`,
        () => {
          graphEl.selectNode(momentNodeId(member.id))
          showFocus(momentNodeId(member.id))
          showPanel(momentNodeId(member.id))
        }
      )))
    return
  }

  panelTitleEl.textContent = id
  panelMetaEl.textContent = '未知节点'
}

function addSection(title: string, children: HTMLElement[]) {
  const heading = document.createElement('h3')
  heading.textContent = title
  const list = document.createElement('ul')
  for (const child of children) list.appendChild(child)
  panelBodyEl.appendChild(heading)
  panelBodyEl.appendChild(list)
}

function listItem(label: string, onClick: () => void): HTMLLIElement {
  const item = document.createElement('li')
  item.textContent = label
  item.addEventListener('click', onClick)
  return item
}

function hint(text: string): HTMLLIElement {
  const item = document.createElement('li')
  item.textContent = text
  item.className = 'hint'
  item.style.cursor = 'default'
  return item
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatRange(start: number, end: number): string {
  const from = new Date(start)
  const to = new Date(end)
  const day = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
  if (end - start <= DAY_MS) return `${day} ${formatClock(start)}–${formatClock(end)}`
  return `${day} 起 ${Math.round((end - start) / DAY_MS)} 天`
}

/* --------------------------------- E2E 钩子 -------------------------------- */

declare global {
  interface Window {
    /** P0 harness 的只读/受控钩子（与生产图谱页的 `__gotchaGraphView` 分开，避免类型冲突）。 */
    __gotchaFoamHarness?: {
      count(): number
      select(nodeId: string): void
      position(nodeId: string): { x: number; y: number } | null
      visibleCounts(): { nodes: number; edges: number }
      filters(): { moment: boolean }
      focusDays(): string[] | null
      setDays(list: string[] | null): void
      dataset(): DatasetSize
      setDataset(size: DatasetSize): void
      fps(): number
      settleMs(): number | null
      stats(): { frames: number; ticks: number }
      reheat(): void
      nodeIds(): string[]
      dimmedCount(): number
    }
  }
}

window.__gotchaFoamHarness = {
  count: () => Object.keys(viewNodes()).length,
  select: nodeId => graphEl.selectNode(nodeId),
  position: nodeId => graphEl.nodePosition(nodeId),
  visibleCounts: () => {
    const onlyThemes = onlyThemesEl.checked
    const nodes = input.themes.length + (onlyThemes ? 0 : input.moments.length)
    const membership = onlyThemes
      ? 0
      : input.moments.reduce((sum, moment) => sum + moment.themeIds.length, 0)
    return { nodes, edges: input.edges.length + membership }
  },
  filters: () => ({ moment: !onlyThemesEl.checked }),
  focusDays: () => (days === null ? null : [...days].sort()),
  setDays: list => {
    days = list === null ? null : new Set(list)
    applyTimeFocus(true)
    renderCalendar()
  },
  dataset: () => dataset,
  setDataset: size => loadDataset(size),
  fps: () => fps,
  settleMs: () => settleMs,
  stats: () => graphEl.stats(),
  reheat: () => graphEl.reheat(),
  nodeIds: () => Object.keys(viewNodes()),
  dimmedCount: () => graphEl.dimmedNodeIds?.size ?? 0
}

loadDataset(dataset)
requestAnimationFrame(frame)
