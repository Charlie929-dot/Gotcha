/**
 * 图谱窗口 shell（M2 Phase 2a）
 *
 * 先接数据通道与状态：日期切换、节点/边计数、节点列表、出网确认、立即归纳、打开时间线。
 * sigma 画布 / 侧栏下钻 / 设置抽屉在 Phase 2b 接入（graph-view / graph-panel / graph-settings）。
 */

import { dayRange, formatDate, formatTime, startOfDay } from '../timeline'
import type { GraphDayData, GraphNodeDto } from '../../understand/graph-query'
import type { GraphApi } from '../graph-preload'
import type { GraphInduceResult } from '../../main/graph-ipc'
import type { InductionSnapshot } from '../../main/induction-runtime'

declare global {
  interface Window {
    gotchaGraph: GraphApi
  }
}

const statusEl = document.getElementById('status')
const dateEl = document.getElementById('date')
const emptyEl = document.getElementById('empty')
const countEl = document.getElementById('node-count')
const listEl = document.getElementById('node-list')
const consentEl = document.getElementById('consent')
const consentButton = document.getElementById('consent-btn')
const metaEl = document.getElementById('meta')

if (!statusEl || !dateEl || !emptyEl || !countEl || !listEl || !consentEl || !consentButton || !metaEl) {
  throw new Error('图谱页面 DOM 不完整')
}

const els = {
  status: statusEl,
  date: dateEl,
  empty: emptyEl,
  count: countEl,
  list: listEl,
  consent: consentEl,
  consentButton,
  meta: metaEl
}

let day = startOfDay(Date.now())
let snapshot: InductionSnapshot | null = null
let lastData: GraphDayData = { nodes: [], edges: [] }

const TYPE_LABEL: Record<string, string> = {
  knowledge: '知识',
  activity: '行为',
  protected: '已保护'
}

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
  if (current.status === 'error') {
    return { kind: 'error', text: current.lastError ? '上次归纳失败' : '上次失败' }
  }
  if (current.status === 'backoff') return { kind: 'backoff', text: STATUS_LABEL[current.status] }
  if (current.status === 'running') return { kind: 'running', text: STATUS_LABEL[current.status] }
  return { kind: current.status === 'idle' ? 'ok' : 'idle', text: STATUS_LABEL[current.status] ?? current.status }
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

function renderList(data: GraphDayData): void {
  const count = data.nodes.length
  els.count.textContent =
    count === 0 ? '' : `${count} 个节点 · ${data.edges.length} 条边`
  els.list.replaceChildren()
  for (const node of data.nodes) els.list.append(renderNode(node))
}

function renderNode(node: GraphNodeDto): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'node'
  li.dataset.id = String(node.id)
  li.dataset.type = node.type

  const title = document.createElement('div')
  title.className = 'node-title'
  const titleText = document.createElement('span')
  titleText.textContent = node.title
  const type = document.createElement('span')
  type.className = 'node-type'
  type.textContent = TYPE_LABEL[node.type] ?? node.type
  title.append(titleText, type)

  const desc = document.createElement('div')
  desc.className = 'node-summary'
  desc.textContent = node.summary

  const meta = document.createElement('div')
  meta.className = 'node-meta'
  meta.textContent = `${formatTime(node.tsStart)} · ${node.sourceCount} 条来源 · 连接 ${node.degree}`

  li.append(title, desc, meta)
  return li
}

function renderMeta(): void {
  els.meta.textContent = snapshot?.consent
    ? '数据只存本地；出网内容经统一脱敏'
    : '确认出网前不会发送任何内容'
}

async function load(): Promise<void> {
  els.date.textContent = formatDate(day)
  const { from, to } = dayRange(day)
  try {
    lastData = await window.gotchaGraph.query(from, to)
    renderList(lastData)
    renderEmpty()
  } catch (error) {
    lastData = { nodes: [], edges: [] }
    renderList(lastData)
    els.empty.hidden = false
    els.empty.dataset.kind = 'error'
    els.empty.textContent = `读取失败：${String(error)}`
  }
}

function shiftDay(delta: number): void {
  const next = new Date(day)
  next.setDate(next.getDate() + delta)
  day = startOfDay(next.getTime())
  void load()
}

document.getElementById('prev')?.addEventListener('click', () => shiftDay(-1))
document.getElementById('next')?.addEventListener('click', () => shiftDay(1))
document.getElementById('today')?.addEventListener('click', () => {
  day = startOfDay(Date.now())
  void load()
})
document.getElementById('refresh')?.addEventListener('click', () => {
  void refresh()
})
document.getElementById('timeline')?.addEventListener('click', () => {
  void window.gotchaGraph.openTimeline()
})

async function refresh(): Promise<void> {
  try {
    applySnapshot(await window.gotchaGraph.status())
  } catch {
    // 状态读取失败不阻塞列表
  }
  await load()
}

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

void refresh()
