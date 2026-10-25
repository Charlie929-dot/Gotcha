/**
 * 全局图谱窗口（v0.3 P3-a；docs/m2-graph-redesign.md §7 / §8）
 *
 * - 数据：`graph:global` 一次取全量（主题 + 时刻 + 归属 + embedding 边 + 位置），
 *   客户端只按日历调暗，不重新查库；
 * - 渲染：Foam 活布局（`foam-adapter` 映射），主题大点 + 时刻小点，成员边默认不画；
 * - 时间：日历 popover（单日 / 涂抹 / Ctrl 加减 / Shift 扩展 / 快捷范围）选「哪天」，
 *   内嵌时段滚轮选「每天内的哪一段」（起止时:分，默认全天）；只调暗不删数据；
 * - 检索：输入 / app / 标题 / 时间变化只更新图谱筛选（命中时刻及其主题点亮）；
 *   点「检索」/回车才列出文字结果卡片，并把相机适配到命中节点。
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
import type { SearchHitDto, SearchResult } from '../../understand/search'
import { formatTime } from '../timeline'
import {
  focusedIdsForDays,
  nodeIdOf,
  searchDimmedIds,
  searchFocusedIds,
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
import {
  ALL_DAY,
  columnIndex,
  columnScrollTop,
  formatClock,
  formatClockRange,
  isAllDay,
  normalizeClock,
  windowSpan,
  type ClockRange
} from './time-of-day'
import { computeDayStats, dayTooltip, heatAlpha, DEFAULT_HEAT_FULL_SCALE, type DayStat } from './day-stats'
import { createGlobalPanel } from './global-panel'
import { createSettingsPanel, type SettingsChange } from './graph-settings-panel'
import type { ThemeMergeGroupView } from '../../understand/theme-merge'
import { modelWarningText, statusView } from './status-view'
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
const modelWarningEl = byId<HTMLElement>('model-warning')
const modelWarningTextEl = byId<HTMLElement>('model-warning-text')
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
const clockLabelEl = byId<HTMLElement>('clock-label')
const clockFromLabelEl = byId<HTMLElement>('clock-from')
const clockToLabelEl = byId<HTMLElement>('clock-to')
const clockAllEl = byId<HTMLButtonElement>('clock-all')
const focusBarEl = byId<HTMLDivElement>('focus-bar')
const focusLabelEl = byId<HTMLElement>('focus-label')
const focusExitEl = byId<HTMLButtonElement>('focus-exit')
const panelEl = byId<HTMLElement>('panel')
const induceEl = byId<HTMLButtonElement>('induce')
const searchForm = byId<HTMLFormElement>('search-form')
const searchInput = byId<HTMLInputElement>('search-input')
const searchAppEl = byId<HTMLSelectElement>('search-app')
const searchTitleEl = byId<HTMLInputElement>('search-title')
const searchStatusEl = byId<HTMLElement>('search-status')
const searchResultsEl = byId<HTMLDivElement>('search-results')
const searchListEl = byId<HTMLUListElement>('search-list')
const searchSummaryEl = byId<HTMLElement>('search-summary')
const searchHintEl = byId<HTMLElement>('search-hint')

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
/** 日历日格计数（事件 / 时刻 / 主题），打开时随数据一起算一次 */
let dayStats = new Map<string, DayStat>()
/** 日格热力满量（事件/天，设置抽屉可调）；当天事件占它的比例决定颜色深浅 */
let dayHeatMax = DEFAULT_HEAT_FULL_SCALE
let themeById = new Map<number, GlobalThemeDto>()
let momentById = new Map<number, GlobalMomentDto>()
let days: Set<string> | null = null
/** 每天内的时间窗；默认全天 */
let clock: ClockRange = { ...ALL_DAY }
/** 文字检索命中的时刻 id；`null`＝没按文字筛 */
let searchHits: Set<number> | null = null
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

const settingsPanel = createSettingsPanel(document.body, window.gotchaGraph, (settings, changed) => {
  void applySavedSettings(settings, changed)
})
byId('settings').addEventListener('click', () => {
  void settingsPanel.open()
  void refreshMerges()
})

/* ------------------------------ 合并记录（撤销） ----------------------------- */

const mergeListEl = byId<HTMLUListElement>('merge-list')
const mergeEmptyEl = byId<HTMLParagraphElement>('merge-empty')
const mergeStatusEl = byId<HTMLParagraphElement>('merge-status')

const REVERT_ERROR_TEXT: Record<string, string> = {
  'not-found': '记录不存在（可能已撤销）',
  'already-reverted': '这次合并已经撤销过',
  'bad-snapshot': '合并快照损坏，无法撤销',
  'has-newer-merges': '这两个主题后来又合并过，请先撤销较新的那次'
}

function setMergeStatus(text: string, kind: 'ok' | 'error' | 'muted' = 'muted'): void {
  mergeStatusEl.textContent = text
  mergeStatusEl.style.color = kind === 'error' ? 'var(--error)' : kind === 'ok' ? 'var(--activity)' : ''
}

function formatMergedAt(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function renderMerges(groups: ThemeMergeGroupView[]): void {
  mergeListEl.replaceChildren()
  mergeEmptyEl.hidden = groups.length > 0
  for (const group of groups) {
    const item = document.createElement('li')
    const titles = document.createElement('span')
    titles.className = 'merge-titles'
    titles.textContent = `${group.into.title} ← ${group.from.map((node) => node.title).join('、')}`
    titles.title = titles.textContent
    const time = document.createElement('time')
    time.textContent = formatMergedAt(group.mergedAt)
    const button = document.createElement('button')
    // 关键：抽屉在 <form> 里，按钮默认是 submit，会把「撤销」变成一次设置保存
    button.type = 'button'
    button.textContent = '撤销'
    button.dataset['group'] = String(group.groupId)
    button.addEventListener('click', () => void revertMerge(group, button))
    item.append(titles, time, button)
    mergeListEl.append(item)
  }
}

async function refreshMerges(): Promise<void> {
  try {
    renderMerges(await window.gotchaGraph.merges())
  } catch {
    renderMerges([])
  }
}

async function revertMerge(group: ThemeMergeGroupView, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  setMergeStatus('撤销中…')
  try {
    const result = await window.gotchaGraph.revertMerge(group.groupId)
    if (!result.ok) {
      setMergeStatus(REVERT_ERROR_TEXT[result.reason] ?? '撤销失败', 'error')
      return
    }
    setMergeStatus(`已拆开 ${result.from.length} 个主题；这一对以后不会再自动合并`, 'ok')
    await refreshMerges()
    // 撤销删掉了相关向量 / 连线：按当前阈值重算一次再拉图，画面与库保持一致
    try {
      await window.gotchaGraph.recomputeGraph()
    } catch {
      // 重算失败不影响已撤销的数据，下次打开图谱会补
    }
    await load()
  } catch (error) {
    setMergeStatus(`撤销失败：${String(error)}`, 'error')
  } finally {
    button.disabled = false
  }
}

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
    dayStats = computeDayStats(next.themes, next.dayActivity)
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
    dayStats = new Map()
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
  syncClockPickers()
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
    const preset = button.dataset.preset as FocusPreset
    days = presetDays(Date.now(), preset)
    // 「全部」＝不筛时间：把时段也复位，免得标签写着全部却还卡着 09:00–18:00
    if (preset === 'all') {
      clock = { ...ALL_DAY }
      syncClockPickers()
    }
    onFilterChanged(true)
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
  onFilterChanged(true)
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  calendarEl.hidden = true
  if (!searchResultsEl.hidden) {
    // 第一下 Esc 只收卡片，保留当前筛选；拦住 type=search 的原生「清空输入」
    event.preventDefault()
    closeCards()
  } else if (document.activeElement === searchInput) {
    event.preventDefault()
    if (searchInput.value !== '') searchInput.value = ''
    clearSearchFilter()
  }
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
    // 日格热力：当天事件 ÷ 满量 → 连续不透明度（方案 §8 日格；满量在设置抽屉可调）
    const stat = dayStats.get(day.key)
    const alpha = heatAlpha(stat?.events ?? 0, dayHeatMax)
    if (alpha > 0) button.style.setProperty('--heat-alpha', String(alpha))
    button.title = dayTooltip(day.key, stat, dayHeatMax)
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
  onFilterChanged(false)
  paintCalendar()
}

function onDayMouseEnter(event: MouseEvent, key: string): void {
  if (!dragging) return
  // 在窗口外松开就收不到 mouseup：用按键状态兜底，免得「松手了还在涂」。
  if ((event.buttons & 1) === 0) {
    dragging = null
    onFilterChanged(true)
    return
  }
  days = dayRange(dragging.anchor, key)
  applyTimeFocus(false)
  paintCalendar()
}

/* -------------------------------- 时段滚轮 -------------------------------- */

/** 滚轮列每项高度（px），与 global.css 的 `--time-item-h` 必须一致 */
const CLOCK_ITEM_H = 28

interface ClockColumn {
  kind: 'hour' | 'minute'
  el: HTMLDivElement
  count: number
  /** 当前选中序号（滚轮停下后由 scrollTop 反推） */
  index: number
}

interface ClockPicker {
  hour: number
  minute: number
  columns: ClockColumn[]
}

const HOUR_VALUES = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTE_VALUES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))

function buildClockPicker(end: 'from' | 'to'): ClockPicker {
  const picker: ClockPicker = {
    hour: end === 'from' ? 0 : 23,
    minute: end === 'from' ? 0 : 59,
    columns: []
  }
  for (const kind of ['hour', 'minute'] as const) {
    const el = byId<HTMLDivElement>(`${end}-${kind}`)
    const values = kind === 'hour' ? HOUR_VALUES : MINUTE_VALUES
    const column: ClockColumn = { kind, el, count: values.length, index: 0 }
    el.replaceChildren(
      ...values.map((value, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'time-item'
        button.dataset.value = value
        button.textContent = value
        button.addEventListener('click', () => selectClockColumn(picker, column, index))
        return button
      })
    )
    // 滚轮交给原生滚动（scroll-snap 负责吸附），选中项由滚动位置反推
    el.addEventListener('scroll', () => onClockScroll(picker, column), { passive: true })
    picker.columns.push(column)
  }
  return picker
}

const fromClockPicker = buildClockPicker('from')
const toClockPicker = buildClockPicker('to')

function paintClockColumn(column: ClockColumn): void {
  const buttons = column.el.children
  for (let i = 0; i < buttons.length; i += 1) buttons[i].classList.toggle('on', i === column.index)
}

/** 程序化滚动：先写 index 再改 scrollTop，随后的 scroll 事件会被当成「没变化」跳过 */
function scrollClockColumnTo(column: ClockColumn, index: number): void {
  const clamped = Math.min(column.count - 1, Math.max(0, index))
  column.index = clamped
  column.el.scrollTop = columnScrollTop(clamped, CLOCK_ITEM_H, column.count)
  paintClockColumn(column)
}

function applyClockColumn(picker: ClockPicker, column: ClockColumn, index: number): void {
  if (column.kind === 'hour') picker.hour = index
  else picker.minute = index
}

function selectClockColumn(picker: ClockPicker, column: ClockColumn, index: number): void {
  scrollClockColumnTo(column, index)
  applyClockColumn(picker, column, index)
  commitClock(false)
}

function onClockScroll(picker: ClockPicker, column: ClockColumn): void {
  const index = columnIndex(column.el.scrollTop, CLOCK_ITEM_H, column.count)
  if (index === column.index) return
  column.index = index
  paintClockColumn(column)
  applyClockColumn(picker, column, index)
  commitClock(false)
}

function paintClockUi(): void {
  clockFromLabelEl.textContent = formatClock(clock.fromMinute)
  clockToLabelEl.textContent = formatClock(clock.toMinute)
  clockLabelEl.textContent = formatClockRange(clock)
}

/** 时段状态 → 列位置（打开弹层 / 点「全天」时用） */
function syncClockPickers(): void {
  fromClockPicker.hour = Math.floor(clock.fromMinute / 60)
  fromClockPicker.minute = clock.fromMinute % 60
  toClockPicker.hour = Math.floor(clock.toMinute / 60)
  toClockPicker.minute = clock.toMinute % 60
  for (const picker of [fromClockPicker, toClockPicker]) {
    scrollClockColumnTo(picker.columns[0], picker.hour)
    scrollClockColumnTo(picker.columns[1], picker.minute)
  }
  paintClockUi()
}

/** 选择态 → 时段（起 > 止 自动交换），并同步调暗 / 计数 / 检索 */
function commitClock(fitCamera: boolean): void {
  clock = normalizeClock(
    fromClockPicker.hour * 60 + fromClockPicker.minute,
    toClockPicker.hour * 60 + toClockPicker.minute
  )
  paintClockUi()
  // 没选日期时滚时段＝从今天开始筛，避免「滚了半天图谱没反应」
  if (days === null) {
    days = new Set([dayKey(Date.now())])
    renderCalendar()
  }
  onFilterChanged(fitCamera)
}

clockAllEl.addEventListener('click', () => {
  clock = { ...ALL_DAY }
  syncClockPickers()
  onFilterChanged(false)
})

/* ------------------------------ 时间筛选应用 ------------------------------ */

/** 时间筛选 / 文字筛选 / 日历交互的统一出口：先调暗，再按需刷新检索 */
function onFilterChanged(fitCamera: boolean): void {
  // 筛选条件变了，旧的文字卡片已过期，先收起；需要时再点「检索」重列
  closeCards()
  applyTimeFocus(fitCamera)
  if (queryCharCount(searchInput.value) >= 2) scheduleSearch(0)
}

function applyTimeFocus(fitCamera: boolean): void {
  if (!input) return
  const dimmed =
    days === null ? new Set<string>() : timeDimmedIds(input, days, clock)
  if (searchHits !== null) {
    for (const id of searchDimmedIds(input, searchHits)) dimmed.add(id)
  }
  graphEl.dimmedNodeIds = dimmed
  dayLabelEl.textContent =
    days === null ? '全部' : `${formatDayLabel(days)}${isAllDay(clock) ? '' : ` · ${formatClockRange(clock)}`}`
  renderEmpty()
  updateCount()

  if (!fitCamera) return
  if (days === null && searchHits === null) {
    graphEl.zoomToFit(500)
    return
  }
  const focused = filteredNodeIds()
  const ids = onlyThemes ? focused.themeIds : [...focused.themeIds, ...focused.momentIds]
  if (ids.length === 0) return
  graphEl.zoomToFitNodes(ids)
}

/** 时间 + 文字筛选的交集（未启用的那层视为全集） */
function filteredNodeIds(): { themeIds: string[]; momentIds: string[] } {
  if (!input) return { themeIds: [], momentIds: [] }
  let themes: Set<string> | null = null
  let moments: Set<string> | null = null
  if (days !== null) {
    const focused = focusedIdsForDays(input, days, clock)
    themes = new Set(focused.themeIds)
    moments = new Set(focused.momentIds)
  }
  if (searchHits !== null) {
    const focused = searchFocusedIds(input, searchHits)
    themes = themes === null ? new Set(focused.themeIds) : intersect(themes, focused.themeIds)
    moments = moments === null ? new Set(focused.momentIds) : intersect(moments, focused.momentIds)
  }
  return {
    themeIds: themes === null ? input.themes.map((theme) => themeNodeId(theme.id)) : [...themes],
    momentIds: moments === null ? input.moments.map((moment) => `m:${moment.id}`) : [...moments]
  }
}

function intersect(base: Set<string>, next: readonly string[]): Set<string> {
  const keep = new Set(next)
  const result = new Set<string>()
  for (const id of base) if (keep.has(id)) result.add(id)
  return result
}

onlyThemesEl.addEventListener('change', () => {
  onlyThemes = onlyThemesEl.checked
  graphEl.setNodeTypeVisible('moment', !onlyThemes)
  applyTimeFocus(true)
})

/* ---------------------------------- 检索 ---------------------------------- */

let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchAppsLoaded = false

function scheduleSearch(delay = 300): void {
  if (searchTimer !== null) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch(false)
  }, delay)
}

/** 只按 code point 数（与主进程 search 模块的「≥2 字」口径一致） */
function queryCharCount(value: string): number {
  return [...value.replace(/\s+/g, '')].length
}

/** 收起文字结果卡片（不影响图谱上的筛选） */
function closeCards(): void {
  if (searchResultsEl.hidden) return
  searchResultsEl.hidden = true
  searchListEl.replaceChildren()
  searchSummaryEl.textContent = ''
  searchHintEl.textContent = ''
}

/** 清掉文字筛选（保留时间筛选）；用于清空输入 / 空查询 */
function clearSearchFilter(): void {
  searchSeq += 1
  searchHits = null
  searchStatusEl.textContent = ''
  closeCards()
  applyTimeFocus(false)
}

/**
 * 输入变化 → 只更新图谱（`showCards = false`）；
 * 点「检索」/回车 → 顺带把文字结果卡片列出来（`showCards = true`）。
 */
async function runSearch(showCards: boolean, fitCamera = false): Promise<void> {
  const query = searchInput.value
  if (queryCharCount(query) < 2) {
    clearSearchFilter()
    return
  }
  const seq = ++searchSeq
  searchStatusEl.textContent = '筛选中…'
  if (showCards) {
    searchResultsEl.hidden = false
    searchSummaryEl.textContent = '检索中…'
    searchHintEl.textContent = ''
    searchListEl.replaceChildren()
  }
  // 时间筛选是文字筛选的前置条件：日历选了哪天/哪个时段，就只在这段里搜
  const span = windowSpan(days, clock)
  try {
    const result: SearchResult = await window.gotchaGraph.search({
      query,
      app: searchAppEl.value || null,
      titleContains: searchTitleEl.value.trim() || null,
      fromTs: span?.fromTs ?? null,
      toTs: span?.toTs ?? null
    })
    if (seq !== searchSeq) return
    if (result.mode === 'empty') {
      clearSearchFilter()
      return
    }
    const hits = new Set<number>()
    for (const hit of result.hits) {
      if (hit.momentId !== null) hits.add(hit.momentId)
    }
    searchHits = hits
    const unassigned = result.hits.filter((hit) => hit.momentId === null).length
    searchStatusEl.textContent =
      result.matchedEvents === 0
        ? '没有命中（图谱全部调暗）'
        : `${result.matchedEvents} 条命中 · ${hits.size} 个时刻在图上${
            unassigned > 0 ? ` · ${unassigned} 段未成时刻` : ''
          }${result.truncated ? '（已截断，缩小时间范围更准）' : ''}`
    if (showCards) renderSearchResult(result)
    applyTimeFocus(fitCamera)
  } catch (error) {
    if (seq !== searchSeq) return
    searchStatusEl.textContent = `筛选失败：${String(error)}`
    searchHits = null
    if (showCards) {
      searchSummaryEl.textContent = '检索失败'
      searchHintEl.textContent = ''
      searchListEl.replaceChildren()
    }
    applyTimeFocus(false)
  }
}

function renderSearchResult(result: SearchResult): void {
  searchResultsEl.hidden = false
  searchSummaryEl.textContent =
    result.matchedEvents === 0
      ? '没有命中'
      : `${result.matchedEvents} 条命中 · ${result.hits.length} 个时刻`
  searchHintEl.textContent = result.truncated
    ? '结果已截断，缩小时间范围更准'
    : result.mode === 'like'
      ? '两字词走模糊匹配'
      : ''
  searchListEl.replaceChildren()
  if (result.hits.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = '没有找到这段记忆（数据仍在，只是没命中）'
    searchListEl.append(li)
    return
  }
  for (const hit of result.hits) searchListEl.append(searchCard(hit))
}

function searchCard(hit: SearchHitDto): HTMLLIElement {
  const li = document.createElement('li')
  li.dataset.momentId = hit.momentId === null ? '' : String(hit.momentId)
  li.dataset.startTs = String(hit.startTs)

  const head = document.createElement('div')
  head.className = 'hit-head'
  const time = document.createElement('span')
  const startLabel = formatTime(hit.startTs)
  const endLabel = formatTime(hit.endTs)
  time.textContent = `${hit.dayKey.slice(5)} ${
    endLabel !== startLabel ? `${startLabel}–${endLabel}` : startLabel
  }`
  const app = document.createElement('span')
  app.textContent = hit.app || '未知应用'
  head.append(time, app)

  const title = document.createElement('div')
  title.className = 'hit-title'
  title.textContent = hit.windowTitle || '（无窗口标题）'

  const snippet = document.createElement('div')
  snippet.className = 'hit-snippet'
  snippet.textContent = hit.snippet

  const meta = document.createElement('div')
  meta.className = 'hit-meta'
  meta.textContent = `${hit.matchedEvents} 条命中${
    hit.momentId === null ? ' · 未成时刻（仍可下钻原文）' : ''
  }`

  li.append(head, title, snippet, meta)
  li.addEventListener('click', () => void openSearchHit(hit))
  return li
}

/** 点结果卡片 = 回到那一刻：有时刻走时刻面板（含「也属于」），否则按窗口现取原文 */
async function openSearchHit(hit: SearchHitDto): Promise<void> {
  const seq = ++panelSeq
  try {
    const result = await window.gotchaGraph.searchHitEvents({
      momentId: hit.momentId,
      app: hit.app,
      windowTitle: hit.windowTitle,
      startTs: hit.startTs,
      endTs: hit.endTs
    })
    if (seq !== panelSeq) return
    const themeIds =
      hit.momentId === null
        ? []
        : input?.moments.find((moment) => moment.id === hit.momentId)?.themeIds ?? []
    const themes = themeIds
      .map((themeId) => themeById.get(themeId))
      .filter((theme): theme is GlobalThemeDto => theme !== undefined)
    panel.showMoment(
      {
        id: hit.momentId ?? 0,
        startTs: hit.startTs,
        endTs: hit.endTs,
        dayKey: hit.dayKey,
        app: hit.app,
        windowTitle: hit.windowTitle,
        ocrSummary: hit.ocrSummary ?? hit.snippet,
        eventIds: hit.eventIds,
        assigned: themes.length > 0
      },
      result,
      themes
    )
    if (hit.momentId !== null && momentById.has(hit.momentId)) {
      const key = `m:${hit.momentId}`
      graphEl.selectNode(key)
      showFocus(key)
    }
  } catch (error) {
    showEmpty('error', `打开时刻失败：${String(error)}`)
  }
}

/** app 过滤器候选项（一次加载；刷新时重取） */
async function loadSearchApps(): Promise<void> {
  try {
    const apps = await window.gotchaGraph.searchApps()
    const current = searchAppEl.value
    const options: HTMLOptionElement[] = []
    const all = document.createElement('option')
    all.value = ''
    all.textContent = '全部应用'
    options.push(all)
    for (const app of apps) {
      const option = document.createElement('option')
      option.value = app
      option.textContent = app
      options.push(option)
    }
    searchAppEl.replaceChildren(...options)
    searchAppEl.value = apps.includes(current) ? current : ''
    searchAppsLoaded = true
  } catch {
    searchAppsLoaded = false
  }
}

// 输入即筛（300ms 防抖，只改图谱、不弹卡片）；点「检索」/回车才列出文字卡片
searchForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  void runSearch(true, true)
})

searchInput.addEventListener('input', () => {
  closeCards()
  scheduleSearch()
})
searchTitleEl.addEventListener('input', () => {
  closeCards()
  scheduleSearch()
})
searchAppEl.addEventListener('change', () => {
  closeCards()
  if (queryCharCount(searchInput.value) >= 2) scheduleSearch(0)
})
byId('search-close').addEventListener('click', () => closeCards())

// 结果卡片：捕获阶段判断「点在外面」，此时被点的节点还在 DOM 里
document.addEventListener(
  'mousedown',
  (event) => {
    if (searchResultsEl.hidden) return
    const target = event.target as Node
    if (searchResultsEl.contains(target) || searchForm.contains(target)) return
    closeCards()
  },
  true
)

// Ctrl+F：聚焦检索框（Electron 窗口没有浏览器自带查找）
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  }
})

/* ---------------------------------- 计数 ---------------------------------- */

function renderEmpty(): void {
  let kind = ''
  let text = ''
  const hasData = data !== null && (data.themes.length > 0 || data.moments.length > 0)
  if (hasData) {
    // 有图可看时状态徽标 / 同意条已足够，不再用空态盖住画布（G5 §7.4）。
    if ((days !== null || searchHits !== null) && input) {
      const focused = filteredNodeIds()
      if (focused.themeIds.length === 0 && focused.momentIds.length === 0) {
        kind = 'no-range'
        text =
          searchHits !== null
            ? days !== null
              ? '当前时间范围内没有命中文字的时刻（数据仍在，只是被调暗）'
              : searchHits.size === 0
                ? '没有找到这段记忆（数据仍在，只是没命中）'
                : '命中事件还没有对应时刻，图谱里暂无可点亮节点'
            : '所选时间范围没有主题或时刻（数据仍在，只是被调暗）'
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
  if (days === null && searchHits === null) {
    countEl.textContent = total
    return
  }
  const focused = filteredNodeIds()
  const momentPart = onlyThemes ? '只看主题' : `${focused.momentIds.length}/${input.moments.length} 个时刻`
  countEl.textContent = `${focused.themeIds.length}/${input.themes.length} 个主题 · ${momentPart} · ${input.edges.length} 条相似连线（筛选后）`
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
  // 模型缺失只是「新主题算不出来」，图照画：顶部黄条提示，不清空画布
  const modelWarning = modelWarningText(next)
  modelWarningEl.hidden = modelWarning === null
  modelWarningTextEl.textContent = modelWarning ?? ''
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
  if (!searchAppsLoaded) void loadSearchApps()
}

/** 应用设置里的日格满量；非法值保持当前值（主进程已校验，这里只防意外） */
function applyDayHeatMax(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return
  if (value === dayHeatMax) return
  dayHeatMax = value
  // 颜色是逐格算的，满量变了要重建格子（日历没开就不用动）
  if (!calendarEl.hidden) renderCalendar()
}

/** 启动时读一次满量：读不到就用默认 4000，不因为没有设置而卡住图谱 */
async function loadDayHeatMax(): Promise<void> {
  try {
    applyDayHeatMax((await window.gotchaGraph.settings()).dayHeatMax)
  } catch {
    // 设置读取失败不影响图谱浏览
  }
}

async function applySavedSettings(
  settings: GraphSettingsView,
  changed: SettingsChange
): Promise<void> {
  applyDayHeatMax(settings.dayHeatMax)
  await refreshStatus()
  // 阈值变了：主进程已按新阈值重算过连线，重新拉一次图（否则连线还是旧的）
  if (changed.thresholds) await load()
  else if (settings.outboundConsent) await load()
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
    onFilterChanged(true)
    renderCalendar()
  },
  clock: () => ({ ...clock }),
  setClock: (fromMinute, toMinute) => {
    clock = normalizeClock(fromMinute, toMinute)
    syncClockPickers()
    onFilterChanged(true)
  },
  /** 文字筛选命中的时刻 id；null＝没按文字筛 */
  searchHits: () => (searchHits === null ? null : [...searchHits].sort((a, b) => a - b)),
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
void loadSearchApps()
void loadDayHeatMax()
