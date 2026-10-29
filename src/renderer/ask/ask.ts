/**
 * 问记忆窗口（多轮对话版）
 *
 * 一段对话 = 若干轮「问题 → 回答 / 没找到 / 确认 / 出错」。追问会带上同一会话
 * 之前的几轮（主进程按 conversationId 从落盘历史里取，渲染层伪造不了）。
 * 模型撑不起答案时会给一个「要确认」的问题 + 候选，点候选就当下一句发出去。
 *
 * 左栏是会话列表（同一会话的多轮折成一条）；点开还原整段对话，引用仍可点开证据。
 * 没有 UI 框架：直接建 DOM。
 */
import {
  NO_EVIDENCE_TEXT,
  type ChainAskCitation,
  type ChainAskErrorReason,
  type ChainAskMemoryCitation,
  type ChainAskRelatedSegment,
  type ChainAskResult,
  type ChainAskResumeDecision,
  type ChainAskStats,
  type ChainAskTrace
} from '../../chain/agent/types'
import type { SegmentEvidence } from '../../chain/agent/evidence'
import type { AskHistoryEntry } from '../../main/ask-history'
import type { AskApi } from '../ask-preload'
import { createSettingsPanel } from '../graph/graph-settings-panel'

declare global {
  interface Window {
    gotchaAsk?: AskApi
  }
}

const api = window.gotchaAsk

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`缺少元素 #${id}`)
  return element as T
}

const form = must<HTMLFormElement>('form')
const questionInput = must<HTMLInputElement>('question')
const submitButton = must<HTMLButtonElement>('submit')
const stopButton = must<HTMLButtonElement>('stop')
const newChatButton = must<HTMLButtonElement>('new-chat')
const resumeLastButton = must<HTMLButtonElement>('resume-last')
const settingsButton = must<HTMLButtonElement>('settings-open')
const drawerEl = must<HTMLElement>('drawer')
const statusEl = must<HTMLSpanElement>('status')
const consentBox = must<HTMLElement>('consent')
const threadEl = must<HTMLElement>('thread')
const evidenceBox = must<HTMLElement>('evidence')
const evidenceTitle = must<HTMLElement>('evidence-title')
const evidenceMeta = must<HTMLParagraphElement>('evidence-meta')
const evidenceShots = must<HTMLElement>('evidence-shots')
const evidenceText = must<HTMLPreElement>('evidence-text')
const historyList = must<HTMLUListElement>('history-list')
const historyCount = must<HTMLSpanElement>('history-count')
const historySearch = must<HTMLInputElement>('history-search')
const historyClear = must<HTMLButtonElement>('history-clear')

/** 列表一次最多画多少条会话（永久保留，记录可能很多；搜索用来缩小范围） */
const HISTORY_RENDER_LIMIT = 200
/** 线程一次最多画多少轮（超长会话只画最近这些，避免 DOM 撑爆） */
const THREAD_RENDER_LIMIT = 40

let entries: AskHistoryEntry[] = []
let activeConversationId: string | null = null
let filter = ''
let busy = false

function setStatus(kind: 'idle' | 'busy' | 'error', text: string): void {
  statusEl.dataset.kind = kind
  statusEl.textContent = text
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatClock(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

const ERROR_TEXT: Record<ChainAskErrorReason, string> = {
  'empty-question': '问题不能为空。',
  consent: '还没允许出云，先把上面那条确认掉。',
  budget: '今天的模型额度用完了，可在设置里调高每日额度。',
  client: '没有可用的模型：去设置里配好供应商与 API key 再来。',
  'question-blocked': '这句话里有敏感内容（密码类），没有发出去。',
  unparseable: '模型这次答得不成形（结构不对），换个问法再试。',
  failed: '这次没查明白。',
  aborted: '已停止。'
}

/**
 * 错误原因 → 给用户看的一句话。
 * `failed` 的 message 是循环层给的具体原因（工具调用数没有收敛 / 客户端报错），
 * 比笼统的「出错了」有用，优先显示；其余原因用固定文案，不把底层异常原文漏到界面。
 */
function errorTextOf(reason: string | undefined, message: string | undefined): string {
  if (reason === 'failed' && message) return message
  if (reason && reason in ERROR_TEXT) return ERROR_TEXT[reason as ChainAskErrorReason]
  return message ?? '当时出错了，细节看日志。'
}

/** 命中口径：`hits` 是各次检索累加，`evidence` 是去重后真正给模型看过的段数 */
function hitsText(stats: ChainAskStats): string {
  return stats.evidence > 0 && stats.evidence !== stats.hits
    ? `命中 ${stats.hits} 段（去重 ${stats.evidence}）`
    : `命中 ${stats.hits} 段`
}

function statsText(stats: ChainAskStats): string {
  const parts: string[] = []
  if (stats.turns !== undefined) parts.push(`${stats.turns} 轮`)
  if (stats.toolCalls !== undefined) parts.push(`${stats.toolCalls} 次工具调用`)
  parts.push(hitsText(stats))
  if (stats.cited > 0) parts.push(`引用 ${stats.cited} 段`)
  return parts.join(' · ')
}

type ContinueAskResult = Extract<ChainAskResult, { kind: 'continue-ask' }>

/** 一次结果 → 状态栏的一句话（提问与续查共用，别让两边的文案又跑偏） */
function statusOf(result: ChainAskResult): { kind: 'idle' | 'error'; text: string } {
  if (result.kind === 'error') {
    return {
      kind: result.reason === 'aborted' ? 'idle' : 'error',
      text: errorTextOf(result.reason, result.message)
    }
  }
  if (result.kind === 'clarify') return { kind: 'idle', text: '想先确认一下再答' }
  if (result.kind === 'insufficient') {
    return { kind: 'idle', text: `${hitsText(result.stats)}，但撑不起结论` }
  }
  if (result.kind === 'continue-ask') {
    return {
      kind: 'idle',
      text: `已经查了 ${result.stats.turns ?? 0} 轮，等你决定要不要接着查`
    }
  }
  if (result.kind === 'no-evidence') {
    return { kind: 'idle', text: `${hitsText(result.stats)}，但证据不足以回答` }
  }
  return { kind: 'idle', text: `命中 ${result.stats.hits} 段，引用 ${result.citations.length} 段` }
}

/* ------------------------------------------------------------------ */
/* 会话归并                                                            */
/* ------------------------------------------------------------------ */

interface ConversationView {
  id: string
  /** 按时间正序（最早 → 最新） */
  turns: AskHistoryEntry[]
  latestAt: number
  title: string
}

function conversationKey(entry: AskHistoryEntry): string {
  return entry.conversationId ?? entry.id
}

/** 把扁平的记录（最新在前）折成会话（最新在前），会话内按时间正序 */
function listConversations(): ConversationView[] {
  const grouped = new Map<string, AskHistoryEntry[]>()
  for (const entry of entries) {
    const key = conversationKey(entry)
    const list = grouped.get(key)
    if (list) list.push(entry)
    else grouped.set(key, [entry])
  }
  const conversations: ConversationView[] = []
  for (const [id, list] of grouped) {
    const turns = list.slice().reverse()
    const first = turns[0]
    conversations.push({
      id,
      turns,
      latestAt: list[0].at,
      title: first.question
    })
  }
  return conversations.sort((a, b) => b.latestAt - a.latestAt)
}

/* ------------------------------------------------------------------ */
/* 渲染：会话列表                                                      */
/* ------------------------------------------------------------------ */

function entryLabel(entry: AskHistoryEntry): string {
  if (entry.kind === 'answer') return `回答 · ${entry.citations.length} 段引用`
  if (entry.kind === 'clarify') return '向你确认'
  if (entry.kind === 'insufficient') return '查到了，但不够'
  if (entry.kind === 'no-evidence') return '没找到'
  return '出错'
}

function matchesFilter(entry: AskHistoryEntry, term: string): boolean {
  const haystack = [
    entry.question,
    entry.answer ?? '',
    entry.note ?? '',
    entry.message ?? '',
    entry.clarify?.question ?? '',
    ...(entry.clarify?.options ?? []),
    ...entry.citations.flatMap((citation) => [citation.title, citation.app, citation.why])
  ]
    .join('\n')
    .toLowerCase()
  return haystack.includes(term)
}

function renderHistoryList(): void {
  const term = filter.trim().toLowerCase()
  const all = listConversations()
  const matched =
    term === ''
      ? all
      : all.filter((conversation) => conversation.turns.some((entry) => matchesFilter(entry, term)))

  historyCount.textContent = term === '' ? `共 ${all.length} 段` : `命中 ${matched.length} 段`
  historyClear.disabled = entries.length === 0
  historyList.replaceChildren()

  if (matched.length === 0) {
    const hint = document.createElement('li')
    hint.className = 'history-empty'
    hint.textContent =
      entries.length === 0 ? '还没有记录。问一个问题就会留在这里。' : '没有匹配的记录。'
    historyList.append(hint)
    return
  }

  for (const conversation of matched.slice(0, HISTORY_RENDER_LIMIT)) {
    const last = conversation.turns[conversation.turns.length - 1]
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    if (conversation.id === activeConversationId) button.classList.add('active')
    const title = document.createElement('span')
    title.className = 'history-question'
    title.textContent = conversation.title
    const meta = document.createElement('span')
    meta.className = 'history-meta'
    meta.textContent = `${formatClock(conversation.latestAt)} · ${
      conversation.turns.length > 1 ? `${conversation.turns.length} 轮 · ` : ''
    }${entryLabel(last)}`
    button.append(title, meta)
    button.addEventListener('click', () => {
      activeConversationId = conversation.id
      renderHistoryList()
      renderThread()
    })
    item.append(button)
    historyList.append(item)
  }

  if (matched.length > HISTORY_RENDER_LIMIT) {
    const hint = document.createElement('li')
    hint.className = 'history-empty'
    hint.textContent = `只显示最近 ${HISTORY_RENDER_LIMIT} 段，用上面的搜索缩小范围。`
    historyList.append(hint)
  }

  updateResumeButton()
}

/**
 * 「继续上一段」只在没打开任何会话时出现（D55 ②：窗口打开默认新会话，
 * 不再静默接上最近一段——否则新问句会带着旧上文，容易串）。
 */
function updateResumeButton(): void {
  const latest = listConversations()[0]
  resumeLastButton.hidden = !latest || latest.id === activeConversationId
}

/* ------------------------------------------------------------------ */
/* 渲染：对话线程                                                      */
/* ------------------------------------------------------------------ */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function appendUserBubble(text: string, imagePath?: string): void {
  const wrap = element('div', 'msg user')
  const bubble = element('div', 'bubble')
  bubble.textContent = text
  if (imagePath) appendShotThumb(bubble, imagePath)
  wrap.append(bubble)
  threadEl.append(wrap)
}

/** 选区问答的截图缩略图：路径 → data URL 由主进程读（渲染层读不了文件）；读不到就整张去掉 */
function appendShotThumb(host: HTMLElement, path: string): void {
  if (!api) return
  const image = element('img', 'shot-thumb')
  image.alt = '随这次提问的截图'
  image.loading = 'lazy'
  image.addEventListener('click', () => image.classList.toggle('zoomed'))
  host.append(image)
  void api
    .image(path)
    .then((url) => {
      if (url) image.src = url
      else image.remove()
    })
    .catch(() => image.remove())
}

function citationList(citations: ChainAskCitation[]): HTMLElement {
  const list = element('ul', 'citations')
  for (const citation of citations) {
    const item = element('li')
    const button = element('button')
    button.type = 'button'
    const title = element('span', 'citation-title')
    title.textContent = citation.title || '（无标题窗口）'
    const meta = element('span', 'citation-meta')
    meta.textContent = `${citation.app || '未知应用'} · ${formatTime(citation.at)}`
    button.append(title, meta)
    if (citation.why) {
      const why = element('span', 'citation-why')
      why.textContent = citation.why
      button.append(why)
    }
    button.addEventListener('click', () => {
      void showEvidence(citation.segmentId)
    })
    item.append(button)
    list.append(item)
  }
  return list
}

/**
 * 日记引用（个人记忆 · 第二本账）：直接摆日期 + 原文片段，不做点开动作。
 * 日记没有截图、也没有「段证据」可读，把原文摊开就是最好的核对方式；
 * 用户能一眼判断「它是不是真记得我写过这句」。
 */
function memoryList(memories: ChainAskMemoryCitation[]): HTMLElement {
  const list = element('ul', 'citations memories')
  for (const memory of memories) {
    const li = element('li')
    const box = element('div', 'memory-card')
    const title = element('span', 'citation-title')
    title.textContent = `${memory.day}${memory.section ? ` · ${memory.section}` : ''}`
    const snippet = element('p', 'memory-snippet')
    snippet.textContent = memory.snippet
    box.append(title, snippet)
    if (memory.why) {
      const why = element('span', 'citation-why')
      why.textContent = memory.why
      box.append(why)
    }
    li.append(box)
    list.append(li)
  }
  return list
}

/** 日记引用小节：没有就不画（不占位、不显示「0 条」） */
function appendMemories(card: HTMLElement, memories: ChainAskMemoryCitation[] | undefined): void {
  if (!memories || memories.length === 0) return
  const title = element('h2', 'section-title')
  title.textContent = `日记引用（${memories.length} 条）`
  card.append(title, memoryList(memories))
}

/** 检索到、但没进引用的段：给一个可点开的入口，别让「命中了很多」变成一句空话 */function relatedList(related: ChainAskRelatedSegment[]): HTMLElement {
  const list = element('ul', 'citations related')
  for (const item of related) {
    const li = element('li')
    const button = element('button')
    button.type = 'button'
    const title = element('span', 'citation-title')
    title.textContent = item.title || '（无标题窗口）'
    const meta = element('span', 'citation-meta')
    meta.textContent = `${item.app || '未知应用'} · ${formatTime(item.at)}`
    button.append(title, meta)
    button.addEventListener('click', () => {
      void showEvidence(item.segmentId)
    })
    li.append(button)
    list.append(li)
  }
  return list
}

/** 相关段小节：有引用时只列引用；没引用时才把「检索到的段」铺开 */
function appendRelated(card: HTMLElement, related: ChainAskRelatedSegment[] | undefined, hasCitations: boolean): void {
  if (hasCitations || !related || related.length === 0) return
  const title = element('h2', 'section-title')
  title.textContent = `检索到的段（${related.length} 段）`
  card.append(title, relatedList(related))
}

/**
 * 过程（D55 ③）：模型思考（CoT）+ 每轮工具调用摘要，折叠展示。
 * 只展示，不参与回答；没开 thinking 的供应商就只有「查了什么」。
 */
function traceFold(trace: ChainAskTrace | undefined): HTMLElement | null {
  if (!trace || trace.steps.length === 0) return null
  const details = element('details', 'trace')
  const summary = element('summary')
  const hasThinking = trace.steps.some((step) => (step.thinking ?? '') !== '')
  summary.textContent = hasThinking
    ? `思考过程（${trace.steps.length} 轮）`
    : `查了什么（${trace.steps.length} 轮）`
  details.append(summary)
  for (const step of trace.steps) {
    const wrap = element('div', 'trace-step')
    const head = element('div', 'trace-head')
    head.textContent = `第 ${step.turn} 轮`
    wrap.append(head)
    if (step.thinking) {
      const pre = element('pre', 'trace-thinking')
      pre.textContent = step.thinking
      wrap.append(pre)
    }
    if (step.tools.length > 0) {
      const list = element('ul', 'trace-tools')
      for (const tool of step.tools) {
        const item = element('li')
        item.textContent = `${tool.name} · ${tool.summary}`
        list.append(item)
      }
      wrap.append(list)
    }
    details.append(wrap)
  }
  return details
}

function appendTrace(card: HTMLElement, trace: ChainAskTrace | undefined): void {
  const fold = traceFold(trace)
  if (fold) card.append(fold)
}

function assistantCard(className: string, label: string, at: number, stats: ChainAskStats): HTMLElement {
  const wrap = element('div', 'msg assistant')
  const card = element('div', `card ${className}`)
  const head = element('div', 'card-head')
  const tag = element('span', 'card-label')
  tag.textContent = label
  const meta = element('span', 'muted')
  meta.textContent = `${formatClock(at)} · ${statsText(stats)}`
  head.append(tag, meta)
  card.append(head)
  wrap.append(card)
  threadEl.append(wrap)
  return card
}

function renderTurn(entry: AskHistoryEntry): void {
  appendUserBubble(entry.question, entry.imagePath)

  if (entry.kind === 'answer') {
    const card = assistantCard('answer', '回答', entry.at, entry.stats)
    const text = element('p', 'answer-text')
    text.textContent = entry.answer ?? ''
    card.append(text)
    if (entry.citations.length > 0) {
      const title = element('h2', 'section-title')
      title.textContent = `引用（${entry.citations.length} 段）`
      card.append(title, citationList(entry.citations))
    }
    appendMemories(card, entry.memories)
    appendTrace(card, entry.trace)
    return
  }

  if (entry.kind === 'insufficient') {
    const card = assistantCard('insufficient', '查到了，但不够', entry.at, entry.stats)
    const text = element('p', 'answer-text muted')
    text.textContent = entry.answer ?? ''
    card.append(text)
    if (entry.citations.length > 0) {
      const title = element('h2', 'section-title')
      title.textContent = `相关证据（${entry.citations.length} 段）`
      card.append(title, citationList(entry.citations))
    }
    appendMemories(card, entry.memories)
    appendRelated(card, entry.related, entry.citations.length > 0)
    appendTrace(card, entry.trace)
    return
  }

  if (entry.kind === 'clarify') {
    const card = assistantCard('clarify', '需要确认', entry.at, entry.stats)
    const question = element('p', 'clarify-question')
    question.textContent = entry.clarify?.question ?? ''
    card.append(question)
    const options = entry.clarify?.options ?? []
    if (options.length > 0) {
      const row = element('div', 'options')
      for (const option of options) {
        const button = element('button', 'option')
        button.type = 'button'
        button.textContent = option
        button.addEventListener('click', () => {
          if (busy) return
          questionInput.value = option
          void ask(option)
        })
        row.append(button)
      }
      card.append(row)
    }
    const hint = element('p', 'muted')
    hint.textContent = '补一句再问，或直接点上面的候选。'
    card.append(hint)
    appendTrace(card, entry.trace)
    return
  }

  if (entry.kind === 'no-evidence') {
    const card = assistantCard('empty', '没找到', entry.at, entry.stats)
    const note = (entry.note ?? '').trim()
    // 模型给了「查到了什么、为什么还是答不了」的说明就显示出来；只重复固定文案时不重复画
    const hasNote =
      note !== '' && note !== NO_EVIDENCE_TEXT && note !== `${NO_EVIDENCE_TEXT}。`
    const text = element('p', 'answer-text muted')
    text.textContent = hasNote
      ? note
      : '信息链里没找到。把时间范围、应用或对象说得更具体一点再问。'
    card.append(text)
    if (entry.citations.length > 0) {
      const title = element('h2', 'section-title')
      title.textContent = `相关证据（${entry.citations.length} 段）`
      card.append(title, citationList(entry.citations))
    }
    appendMemories(card, entry.memories)
    appendRelated(card, entry.related, entry.citations.length > 0)
    appendTrace(card, entry.trace)
    return
  }

  const card = assistantCard('error', '出错', entry.at, entry.stats)
  const text = element('p', 'answer-text')
  text.textContent = errorTextOf(entry.reason, entry.message)
  card.append(text)
  appendTrace(card, entry.trace)
}

function renderEmptyThread(): void {
  threadEl.replaceChildren()
  const hint = element('div', 'thread-empty')
  const title = element('p', 'thread-empty-title')
  title.textContent = '问一件过去做过的事'
  const body = element('p', 'muted')
  body.textContent =
    '比如「下午那个编译错误最后怎么解决的」。同一段对话里可以接着追问（「那上午呢」），我会带着前面的上下文继续查。'
  hint.append(title, body)
  threadEl.append(hint)
}

function renderThread(): void {
  currentThreadEntries = []
  if (!activeConversationId) {
    renderEmptyThread()
    return
  }
  const conversation = listConversations().find((item) => item.id === activeConversationId)
  if (!conversation) {
    renderEmptyThread()
    return
  }
  threadEl.replaceChildren()
  const turns = conversation.turns.slice(-THREAD_RENDER_LIMIT)
  if (conversation.turns.length > turns.length) {
    const hint = element('p', 'muted thread-truncated')
    hint.textContent = `更早的 ${conversation.turns.length - turns.length} 轮没有展开。`
    threadEl.append(hint)
  }
  for (const entry of turns) renderTurn(entry)
  currentThreadEntries = conversation.turns
  threadEl.scrollTop = threadEl.scrollHeight
}

/** 当前线程（用于把用户刚问的一句立刻画出来，不等历史落盘） */
let currentThreadEntries: AskHistoryEntry[] = []

function appendPending(question: string, imagePath?: string): void {
  appendUserBubble(question, imagePath)
  const wrap = element('div', 'msg assistant')
  const card = element('div', 'card pending')
  const text = element('p', 'muted')
  text.textContent = '正在检索…'
  card.append(text)
  wrap.append(card)
  threadEl.append(wrap)
  threadEl.scrollTop = threadEl.scrollHeight
}

/**
 * 检索轮数用尽、模型还想继续查：把等待卡换成「还要继续吗」+ 两个按钮。
 * 这一问**还没落历史**（用户没决定前不记），所以不能走 renderThread()，
 * 否则刚画出来的问题气泡会被历史重建掉。续查完成后由 renderThread() 统一重建。
 */
function renderContinueCard(result: ContinueAskResult): void {
  const pendingMsg = threadEl.querySelector('.card.pending')?.closest('.msg') ?? null
  const previousCards = threadEl.querySelectorAll('.card.continue')
  const lastContinue =
    previousCards.length > 0 ? previousCards[previousCards.length - 1].closest('.msg') : null
  const previous = pendingMsg ?? lastContinue

  const wrap = element('div', 'msg assistant')
  const card = element('div', 'card continue')
  const head = element('div', 'card-head')
  const label = element('span', 'card-label')
  label.textContent = '还要继续吗'
  const meta = element('span', 'muted')
  meta.textContent = statsText(result.stats)
  head.append(label, meta)
  const question = element('p', 'clarify-question')
  question.textContent = result.question
  card.append(head, question)

  const options = result.options.length > 0 ? result.options : ['继续查', '先按现在的结果回答']
  const row = element('div', 'options')
  /** 同一张卡只认第一次点击：连点 / 双击不许把同一份状态恢复两次 */
  const cardState = { clicked: false }
  options.forEach((option, index) => {
    const button = element('button', 'option')
    button.type = 'button'
    button.textContent = option
    // 第一个候选 = 继续查（再给一轮预算），其余 = 按现有结果收尾
    const decision: ChainAskResumeDecision = index === 0 ? 'continue' : 'stop'
    button.addEventListener('click', () => {
      if (busy || cardState.clicked) return
      cardState.clicked = true
      row.querySelectorAll('button').forEach((item) => {
        item.disabled = true
      })
      void resumeContinue(result.resumeId, decision)
    })
    row.append(button)
  })
  card.append(row)

  if (!result.resumeId) {
    const hint = element('p', 'muted')
    hint.textContent = '这次追问已经过期，重新问一遍就好。'
    card.append(hint)
  }

  wrap.append(card)
  if (previous) previous.replaceWith(wrap)
  else threadEl.append(wrap)
  threadEl.scrollTop = threadEl.scrollHeight
}

/** 用户点了「继续查 / 按现有结果回答」：恢复主进程里暂停的循环 */
async function resumeContinue(
  resumeId: string | undefined,
  decision: ChainAskResumeDecision
): Promise<void> {
  if (busy) return
  if (!api) {
    setStatus('error', '窗口没接上主进程（preload 缺失）')
    return
  }
  if (!resumeId) {
    setStatus('error', '这次追问已经过期，重新问一遍就好')
    return
  }
  if (typeof api.resume !== 'function') {
    setStatus('error', '这个窗口不支持续查，重新问一遍就好')
    return
  }
  setupBusy()
  setStatus('busy', decision === 'continue' ? '接着检索…' : '按现有结果回答…')
  try {
    const result = await api.resume(resumeId, decision)
    if (result.kind === 'continue-ask') {
      // 又查满一轮：换一张新的「还要继续吗」
      renderContinueCard(result)
      const status = statusOf(result)
      setStatus(status.kind, status.text)
      return
    }
    const status = statusOf(result)
    setStatus(status.kind, status.text)
    // 主进程已经落了这一条（问题 + 最终结果），重建线程即可
    await refreshHistory()
    renderThread()
    renderHistoryList()
  } catch (error) {
    setStatus('error', `续查出错：${String(error)}`)
  } finally {
    setBusy(false)
    questionInput.focus()
  }
}

/* ------------------------------------------------------------------ */
/* 证据面板                                                            */
/* ------------------------------------------------------------------ */

async function showEvidence(segmentId: number): Promise<void> {
  if (!api) return
  setStatus('busy', '读取证据…')
  try {
    const evidence = await api.segment(segmentId)
    if (!evidence) {
      setStatus('error', '这段证据读不到了')
      return
    }
    renderEvidence(evidence)
    setStatus('idle', '就绪')
  } catch (error) {
    setStatus('error', `读证据失败：${String(error)}`)
  }
}

function renderEvidence(evidence: SegmentEvidence): void {
  evidenceTitle.textContent = evidence.title || '（无标题窗口）'
  const parts = [
    evidence.app || '未知应用',
    `${formatTime(evidence.startTs)} → ${formatTime(evidence.endTs)}`,
    `有效 ${formatDuration(evidence.activeMs)}`
  ]
  if (evidence.tags.length > 0) parts.push(`标签：${evidence.tags.join(' / ')}`)
  if (evidence.links.length > 0) parts.push(`双链：${evidence.links.join(' / ')}`)
  evidenceMeta.textContent = parts.join(' · ')

  evidenceShots.replaceChildren()
  for (const shot of evidence.shots) {
    if (!shot.dataUrl) continue
    const image = document.createElement('img')
    image.src = shot.dataUrl
    image.alt = `证据截图 ${formatTime(shot.ts)}`
    evidenceShots.append(image)
  }
  evidenceText.textContent =
    evidence.contents.map((content) => content.text).join('\n\n---\n\n') || '（这一段没有可读正文）'
  evidenceBox.hidden = false
}

/* ------------------------------------------------------------------ */
/* 提问                                                                */
/* ------------------------------------------------------------------ */

function newConversationId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

async function refreshHistory(): Promise<void> {
  if (!api) return
  try {
    entries = await api.history()
    renderHistoryList()
  } catch (error) {
    setStatus('error', `读记录失败：${String(error)}`)
  }
}

function setBusy(next: boolean): void {
  busy = next
  submitButton.disabled = next
  stopButton.hidden = !next
  newChatButton.disabled = next
}

async function ask(question: string, imagePath?: string): Promise<void> {
  if (busy) return
  if (!api) {
    setStatus('error', '窗口没接上主进程（preload 缺失）')
    return
  }
  if (activeConversationId === null) activeConversationId = newConversationId()
  if (currentThreadEntries.length === 0) threadEl.replaceChildren()

  setupBusy()
  appendPending(question, imagePath)
  questionInput.value = ''
  const conversationId = activeConversationId

  try {
    const result = await api.query(question, conversationId, imagePath)
    if (result.kind === 'continue-ask') {
      // 这一问还没落历史：保留刚画的问题气泡，只把等待卡换成「还要继续吗」
      renderContinueCard(result)
      const status = statusOf(result)
      setStatus(status.kind, status.text)
      return
    }
    const status = statusOf(result)
    setStatus(status.kind, status.text)
    await refreshHistory()
    activeConversationId = conversationId
    renderThread()
    renderHistoryList()
  } catch (error) {
    threadEl.querySelector('.card.pending')?.closest('.msg')?.remove()
    const wrap = element('div', 'msg assistant')
    const card = element('div', 'card error')
    const text = element('p', 'answer-text')
    text.textContent = `问记忆出错了：${String(error)}`
    card.append(text)
    wrap.append(card)
    threadEl.append(wrap)
    setStatus('error', '出错了')
  } finally {
    setBusy(false)
    questionInput.focus()
  }
}

function setupBusy(): void {
  setBusy(true)
  setStatus('busy', '在想…')
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const question = questionInput.value.trim()
  if (question === '') {
    setStatus('error', '问题不能为空')
    return
  }
  void ask(question)
})

stopButton.addEventListener('click', () => {
  if (!api || !busy) return
  setStatus('busy', '正在停止…')
  void api.cancel()
})

newChatButton.addEventListener('click', () => {
  if (busy) return
  activeConversationId = null
  currentThreadEntries = []
  renderThread()
  renderHistoryList()
  questionInput.value = ''
  questionInput.focus()
  setStatus('idle', '新对话')
})

resumeLastButton.addEventListener('click', () => {
  if (busy) return
  const latest = listConversations()[0]
  if (!latest) return
  activeConversationId = latest.id
  renderThread()
  renderHistoryList()
  setStatus('idle', '继续上一段')
  questionInput.focus()
})

historySearch.addEventListener('input', () => {
  filter = historySearch.value
  renderHistoryList()
})

historyClear.addEventListener('click', () => {
  if (!api || entries.length === 0) return
  if (!window.confirm(`清空全部 ${entries.length} 条对话记录？清空后找不回来。`)) return
  void api
    .clearHistory()
    .then((cleared) => {
      if (!cleared) {
        setStatus('error', '清空记录失败，细节看日志')
        return
      }
      entries = []
      activeConversationId = null
      currentThreadEntries = []
      renderHistoryList()
      renderThread()
      setStatus('idle', '记录已清空')
    })
    .catch((error: unknown) => setStatus('error', `清空记录失败：${String(error)}`))
})

must<HTMLButtonElement>('consent-allow').addEventListener('click', () => {
  void api
    ?.setConsent(true)
    .then((view) => {
      if (view?.consented) consentBox.hidden = true
    })
    .catch((error: unknown) => setStatus('error', `确认失败：${String(error)}`))
})

must<HTMLButtonElement>('consent-deny').addEventListener('click', () => {
  consentBox.hidden = true
  setStatus('idle', '不出网')
})

must<HTMLButtonElement>('evidence-close').addEventListener('click', () => {
  evidenceBox.hidden = true
})

/* ------------------------------------------------------------------ */
/* 设置抽屉（D53：供应商 / 密钥 / 出网确认 / 用量）                     */
/* ------------------------------------------------------------------ */

/**
 * 重新读一次出网状态：确认条与「没有可用的模型」都跟着设置走。
 * 设置里刚填好 key / 勾上确认时，不用关窗口重开。
 */
async function refreshConsent(): Promise<void> {
  if (!api) return
  try {
    const view = await api.consent()
    if (!view) return
    consentBox.hidden = view.consented
    if (!view.clientReady) {
      setStatus('error', `没有可用的模型（${view.clientReason ?? '未配置'}）`)
      return
    }
    if (view.consented && statusEl.dataset.kind === 'error') setStatus('idle', '就绪')
  } catch (error) {
    setStatus('error', `读取状态失败：${String(error)}`)
  }
}

/**
 * 面板本身与图谱页共用（同一套主进程实现、同一批设置键）；问记忆页只有
 * 供应商 / 出网 / 用量三段，缺的字段面板会自动跳过，不会写空别的页面设置。
 */
const settingsPanel = api
  ? createSettingsPanel(document.body, api, () => {
      void refreshConsent()
    })
  : null

settingsButton.addEventListener('click', () => {
  void settingsPanel?.open()
})

// 点遮罩空白处关抽屉；Esc 也关（面板自己不管关闭键）
drawerEl.addEventListener('mousedown', (event) => {
  if (event.target === drawerEl) settingsPanel?.close()
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsPanel?.isOpen()) settingsPanel.close()
})

// 托盘 / 球右键的「设置」：窗口打开即展开抽屉
api?.onOpenSettings(() => {
  void settingsPanel?.open()
})

void (async () => {
  questionInput.focus()
  renderThread()
  if (!api) {
    setStatus('error', '窗口没接上主进程（preload 缺失）')
    return
  }
  await refreshHistory()
  // 默认新会话（D55 ②）：不静默接上最近一段；要接着问就点顶部「继续上一段」或左栏记录
  await refreshConsent()
  // 选区问答的交接单：新开一条会话、带着截图直接问（不覆盖用户正在看的会话）
  api?.onPrefill((payload) => {
    if (busy) return
    activeConversationId = null
    currentThreadEntries = []
    threadEl.replaceChildren()
    void ask(payload.question, payload.imagePath)
  })
})()
