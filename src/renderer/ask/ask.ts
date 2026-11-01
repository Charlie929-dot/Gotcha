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
import {
  ASK_MODE_LABELS,
  type AskModeKind,
  type AskModeState
} from '../../chain/agent/mode'
import type { AskHistoryEntry } from '../../main/ask-history'
import type { MemorySettingsView } from '../../main/memory-settings'
import type { MemoryRepoSettingsView } from '../../main/memory-repo-settings'
import type { MemoryListItemView } from '../../main/memory-admin'
import type { QqSettingsView } from '../../main/qq/qq-settings'
import type { NapcatView } from '../../main/qq/napcat'
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
/* ---- 附件（图片 / 文本文件） ---- */
const attachButton = must<HTMLButtonElement>('attach')
const fileInput = must<HTMLInputElement>('file-input')
const attachmentsEl = must<HTMLElement>('attachments')
/* ---- 设置抽屉 · 个人记忆（日记目录 + 人设；保存即同步） ---- */
const memoryStatusEl = must<HTMLElement>('memory-status')
const memoryVaultInput = must<HTMLInputElement>('set-memory-vault')
const memoryNameInput = must<HTMLInputElement>('set-persona-name')
const memoryToneInput = must<HTMLInputElement>('set-persona-tone')
const memoryRedlinesInput = must<HTMLTextAreaElement>('set-persona-redlines')
const memorySaveButton = must<HTMLButtonElement>('memory-save')
const memoryMsg = must<HTMLElement>('memory-msg')
/* ---- 设置抽屉 · 记忆仓（D90：远端绑定 / 推送状态 / 定时） ---- */
const memoryRepoStatus = must<HTMLElement>('memory-repo-status')
const memoryRemoteInput = must<HTMLInputElement>('set-memory-remote')
const memoryCommitInput = must<HTMLInputElement>('set-memory-commit')
const memoryPushInput = must<HTMLInputElement>('set-memory-push')
const memoryRepoSaveButton = must<HTMLButtonElement>('memory-repo-save')
const memoryRepoPushButton = must<HTMLButtonElement>('memory-repo-push')
const memoryRepoMsg = must<HTMLElement>('memory-repo-msg')
/* ---- 设置抽屉 · 记忆条目（浏览 / 删除 / 撤销） ---- */
const memorySearchInput = must<HTMLInputElement>('memory-search')
const memoryKindSelect = must<HTMLSelectElement>('memory-kind')
const memoryListMsg = must<HTMLElement>('memory-list-msg')
const memoryItemsEl = must<HTMLUListElement>('memory-items')
const memoryMoreButton = must<HTMLButtonElement>('memory-more')
const memoryUndoButton = must<HTMLButtonElement>('memory-undo')
/* ---- 模式条（D72：ask / chat 两档；工具用 /tool 管） ---- */
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('.mode-btn')]
const modeNote = must<HTMLElement>('mode-note')
/* ---- 设置抽屉 · 人格卡（D62） ---- */
const personaCardSelect = must<HTMLSelectElement>('set-persona-card')
const personaCardPreview = must<HTMLTextAreaElement>('persona-card-preview')
const personaCardFileInput = must<HTMLInputElement>('persona-card-file')
const personaCardOpenButton = must<HTMLButtonElement>('persona-card-open')
const personaCardStatus = must<HTMLElement>('persona-card-status')
const personaCardMsg = must<HTMLElement>('persona-card-msg')
/* ---- 设置抽屉 · QQ 通道（D63） ---- */
const qqStatusEl = must<HTMLElement>('qq-status')
const qqEnabledInput = must<HTMLInputElement>('set-qq-enabled')
const qqLanInput = must<HTMLInputElement>('set-qq-lan')
const qqPortInput = must<HTMLInputElement>('set-qq-port')
const qqTokenInput = must<HTMLInputElement>('set-qq-token')
const qqAllowInput = must<HTMLTextAreaElement>('set-qq-allow')
const qqMaxCharsInput = must<HTMLInputElement>('set-qq-maxchars')
const qqSaveButton = must<HTMLButtonElement>('qq-save')
const qqMsg = must<HTMLElement>('qq-msg')
const qqNapcatStatusEl = must<HTMLElement>('qq-napcat-status')
const qqNapcatQrEl = must<HTMLImageElement>('qq-napcat-qr')
const qqNapcatInstallButton = must<HTMLButtonElement>('qq-napcat-install')
const qqNapcatDirButton = must<HTMLButtonElement>('qq-napcat-dir')
const qqNapcatStartButton = must<HTMLButtonElement>('qq-napcat-start')
const qqNapcatStopButton = must<HTMLButtonElement>('qq-napcat-stop')
const qqNapcatProgressEl = must<HTMLProgressElement>('qq-napcat-progress')
const qqNapcatAutoInput = must<HTMLInputElement>('set-qq-napcat-auto')

/** 列表一次最多画多少条会话（永久保留，记录可能很多；搜索用来缩小范围） */
const HISTORY_RENDER_LIMIT = 200
/** 线程一次最多画多少轮（超长会话只画最近这些，避免 DOM 撑爆） */
const THREAD_RENDER_LIMIT = 40

let entries: AskHistoryEntry[] = []
let activeConversationId: string | null = null
let filter = ''
let busy = false

/* ------------------------------------------------------------------ */
/* 模式（D72：分支即模式）：ask / chat 两个按钮，主进程按分支现算          */
/* ------------------------------------------------------------------ */

/** 当前模式（由主进程给；界面只显示，不决定） */
let askMode: AskModeState | null = null
/** 当前启用的人格卡文件名（设置抽屉读到后回填；只用于提示「选了卡但没启用」） */
let activePersonaCard = ''

/** 模式条 / 提示一起刷新（启动、每条结果、读设置后都走这里） */
function applyModeUI(): void {
  const kind = askMode?.kind ?? null
  for (const button of modeButtons) {
    button.classList.toggle('active', button.dataset.mode === kind)
  }
  if (askMode === null) {
    modeNote.textContent = '模式：读不到（记忆仓不可用）'
    return
  }
  const parts = [
    `分支 ${askMode.branch}`,
    askMode.tools.length === 0 ? '无工具' : `${askMode.tools.length} 个工具`
  ]
  if (askMode.kind === 'chat') {
    parts.push(activePersonaCard !== '' ? `人格卡：${activePersonaCard}` : '默认人设')
  }
  modeNote.textContent = `${ASK_MODE_LABELS[askMode.kind]} · ${parts.join(' · ')}`
}

/** 主进程切了分支（/mode、/use、/new、传承）：刷新模式条 */
function setAskMode(next: AskModeState | null): void {
  if (next !== null) askMode = next
  applyModeUI()
}

async function refreshMode(): Promise<void> {
  if (!api) return
  try {
    const next = await api.mode()
    if (next !== null) {
      setAskMode(next)
      // 分支过滤影响会话列表：模式一到就按当前分支重画（启动时历史可能先到）
      if (entries.length > 0) renderHistoryList()
    }
  } catch {
    // 读不到就保持现状；不把窗口带崩
  }
}

/** 点模式按钮 = 发一条 `/mode ask|chat`（命令不调模型，回执照常显示） */
async function requestMode(kind: AskModeKind): Promise<void> {
  if (busy) return
  if (askMode?.kind === kind) {
    setStatus('idle', `已经是${ASK_MODE_LABELS[kind]}模式`)
    return
  }
  await ask(`/mode ${kind}`)
}

/* ------------------------------------------------------------------ */
/* 附件（图片 / 文本文件）                                              */
/* ------------------------------------------------------------------ */

/** 待发送的附件：图片已压成 data URL；文本文件只留文本（原文件不落盘） */
type PendingAttachment =
  | { kind: 'image'; id: string; name: string; dataUrl: string }
  | { kind: 'file'; id: string; name: string; text: string }

const MAX_ATTACH_IMAGES = 4
const MAX_ATTACH_FILES = 4
/** 单个文本文件上限（200KB 原文件；抽出的文本再按下面总预算截） */
const MAX_ATTACH_FILE_BYTES = 200 * 1024
/** 单个文件送云文本上限；总预算在载荷层还有一道 30k */
const MAX_ATTACH_FILE_CHARS = 30_000
/** 图片长边上限：超过就缩，控制 token 与请求体 */
const MAX_ATTACH_IMAGE_EDGE = 1600

let pendingAttachments: PendingAttachment[] = []
let attachSeq = 0

function nextAttachId(): string {
  attachSeq += 1
  return `a${attachSeq}`
}

function clearAttachments(): void {
  pendingAttachments = []
  renderAttachments()
}

function renderAttachments(): void {
  attachmentsEl.replaceChildren()
  attachmentsEl.hidden = pendingAttachments.length === 0
  for (const item of pendingAttachments) {
    const chip = element('div', 'attachment')
    if (item.kind === 'image') {
      const image = element('img')
      image.src = item.dataUrl
      image.alt = item.name
      chip.append(image)
    }
    const name = element('span', 'attachment-name')
    name.textContent = item.kind === 'file' ? `${item.name}` : item.name || '截图'
    name.title = name.textContent
    const remove = element('button', 'attachment-remove')
    remove.type = 'button'
    remove.textContent = '×'
    remove.title = '移除'
    remove.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter((entry) => entry.id !== item.id)
      renderAttachments()
    })
    chip.append(name, remove)
    attachmentsEl.append(chip)
  }
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'py', 'ts', 'tsx', 'js', 'jsx', 'css', 'html',
  'htm', 'xml', 'yml', 'yaml', 'ini', 'toml', 'sql', 'sh', 'bat', 'ps1', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'env', 'gitignore', 'conf', 'cfg'
])

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json') return true
  const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : ''
  return ext !== '' && TEXT_EXTENSIONS.has(ext)
}

/** 图片 → data URL；大图缩到长边 1600（PNG 保持 PNG，截图文字不糊） */
async function readImage(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(file)
  })
  if (file.size <= 1_500_000) return raw
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const node = new Image()
    node.onload = () => resolve(node)
    node.onerror = () => reject(new Error('图片解码失败'))
    node.src = raw
  })
  const scale = Math.min(1, MAX_ATTACH_IMAGE_EDGE / Math.max(image.width, image.height))
  if (scale >= 1) return raw
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return raw
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  // 截图里的字用 PNG 才不糊；照片类用 JPEG 压体积
  const png = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')
  return canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86)
}

async function addFiles(files: readonly File[]): Promise<void> {
  for (const file of files) {
    const imageCount = pendingAttachments.filter((item) => item.kind === 'image').length
    const fileCount = pendingAttachments.filter((item) => item.kind === 'file').length
    if (isImageFile(file)) {
      if (imageCount >= MAX_ATTACH_IMAGES) {
        setStatus('error', `最多带 ${MAX_ATTACH_IMAGES} 张图片`)
        continue
      }
      if (file.size > 20 * 1024 * 1024) {
        setStatus('error', `图片太大：${file.name}`)
        continue
      }
      try {
        const dataUrl = await readImage(file)
        if (dataUrl.startsWith('data:image/')) {
          pendingAttachments.push({ kind: 'image', id: nextAttachId(), name: file.name || '截图', dataUrl })
        }
      } catch {
        setStatus('error', `读不了这张图：${file.name}`)
      }
      continue
    }
    if (!isTextFile(file)) {
      setStatus('error', `只收图片和文本文件：${file.name}`)
      continue
    }
    if (fileCount >= MAX_ATTACH_FILES) {
      setStatus('error', `最多带 ${MAX_ATTACH_FILES} 个文件`)
      continue
    }
    if (file.size > MAX_ATTACH_FILE_BYTES) {
      setStatus('error', `文件太大（上限 200KB）：${file.name}`)
      continue
    }
    try {
      const text = (await file.text()).slice(0, MAX_ATTACH_FILE_CHARS)
      if (text.trim() !== '') {
        pendingAttachments.push({ kind: 'file', id: nextAttachId(), name: file.name, text })
      }
    } catch {
      setStatus('error', `读不了这个文件：${file.name}`)
    }
  }
  renderAttachments()
}

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
  'life-ended': '这一代的生命已经结束。/use 可以回看，或 /compact 续命。',
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

function statsText(stats: ChainAskStats, memoryCount = 0): string {
  const parts: string[] = []
  if (stats.turns !== undefined) parts.push(`${stats.turns} 轮`)
  if (stats.toolCalls !== undefined) parts.push(`${stats.toolCalls} 次工具调用`)
  parts.push(hitsText(stats))
  if (stats.cited > 0) parts.push(`引用 ${stats.cited} 段`)
  // 日记引用不占屏幕段：只靠日记回答时，引用数要单独说，否则一行「引用 0 段」和
  // 下面 4 张日记卡片自相矛盾（2026-10-29 验收时踩到）
  if (memoryCount > 0) parts.push(`日记引用 ${memoryCount} 条`)
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
  if (result.kind === 'command') return { kind: 'idle', text: '命令已执行' }
  const memoryCount = result.memories?.length ?? 0
  const memoryText = memoryCount > 0 ? `，日记引用 ${memoryCount} 条` : ''
  return {
    kind: 'idle',
    text: `命中 ${result.stats.hits} 段，引用 ${result.citations.length} 段${memoryText}`
  }
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
    // D72：历史按分支隔离，界面也只看当前分支（切 /mode 后不把另一档的问答混在同一条线里）
    if ((entry.branch ?? 'default') !== (askMode?.branch ?? 'default')) continue
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
  if (entry.kind === 'answer') {
    const memories = entry.memories?.length ?? 0
    return `回答 · ${entry.citations.length} 段引用${memories > 0 ? ` · ${memories} 条日记` : ''}`
  }
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

/** 附件在界面上的视图（历史记录给 path；刚发送的 pending 给 dataUrl） */
type AttachmentView = {
  kind: 'image' | 'file'
  name?: string
  path?: string
  dataUrl?: string
  text?: string
  chars?: number
}

function appendUserBubble(
  text: string,
  imagePath?: string,
  attachments?: readonly AttachmentView[]
): void {
  const wrap = element('div', 'msg user')
  const bubble = element('div', 'bubble')
  bubble.textContent = text
  if (imagePath) appendShotThumb(bubble, imagePath)
  if (attachments && attachments.length > 0) {
    const list = element('div', 'attach-list')
    for (const item of attachments) {
      if (item.kind === 'image') {
        if (item.path) {
          appendShotThumb(list, item.path)
        } else if (item.dataUrl) {
          const image = element('img', 'shot-thumb')
          image.src = item.dataUrl
          image.alt = item.name ?? '图片'
          image.loading = 'lazy'
          image.addEventListener('click', () => image.classList.toggle('zoomed'))
          list.append(image)
        }
        continue
      }
      const chip = element('span', 'attach-file')
      chip.textContent = item.name ?? '文件'
      list.append(chip)
    }
    if (list.childElementCount > 0) bubble.append(list)
  }
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

function assistantCard(
  className: string,
  label: string,
  at: number,
  stats: ChainAskStats,
  memoryCount = 0
): HTMLElement {
  const wrap = element('div', 'msg assistant')
  const card = element('div', `card ${className}`)
  const head = element('div', 'card-head')
  const tag = element('span', 'card-label')
  tag.textContent = label
  const meta = element('span', 'muted')
  meta.textContent = `${formatClock(at)} · ${statsText(stats, memoryCount)}`
  head.append(tag, meta)
  card.append(head)
  wrap.append(card)
  threadEl.append(wrap)
  return card
}

function renderTurn(entry: AskHistoryEntry): void {
  renderTurnBody(entry)
  // 交接回执（D82）：跟在出生那一问后面单独一条，与命令回执同款
  if (entry.receipt !== undefined && entry.receipt !== '') {
    threadEl.append(receiptBubble('回执', entry.receipt, entry.at))
  }
}

function renderTurnBody(entry: AskHistoryEntry): void {
  appendUserBubble(entry.question, entry.imagePath, entry.attachments)

  if (entry.kind === 'answer') {
    const card = assistantCard('answer', '回答', entry.at, entry.stats, entry.memories?.length ?? 0)
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
    const card = assistantCard('insufficient', '查到了，但不够', entry.at, entry.stats, entry.memories?.length ?? 0)
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
    const card = assistantCard('empty', '没找到', entry.at, entry.stats, entry.memories?.length ?? 0)
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
  title.textContent = '想说什么都行'
  const body = element('p', 'muted')
  body.textContent =
    '想找以前的事就直接问，比如「下午那个编译错误最后怎么解决的」；想聊两句也可以。同一段对话里能接着追问（「那上午呢」）。'
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

function appendPending(
  question: string,
  imagePath?: string,
  attachments?: readonly AttachmentView[]
): void {
  appendUserBubble(question, imagePath, attachments)
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

/**
 * 本地命令回执（`/help`、`/backup`）：不落历史，所以不能走 `renderThread()`
 * （会把刚画出来的回执一起重建掉）——只把等待卡换成一张普通回答卡。
 */
/**
 * 回执气泡：命令结果（`/git`、`/use`…）与「交接回执」（D82）共用，区别只在标题。
 * 回执不落问答历史里的「轮」，所以这里不画引用 / 过程，只画一行字。
 */
function receiptBubble(label: string, text: string, at: number = Date.now()): HTMLElement {
  const wrap = element('div', 'msg assistant')
  const card = element('div', 'card answer')
  const head = element('div', 'card-head')
  const tag = element('span', 'card-label')
  tag.textContent = label
  const meta = element('span', 'muted')
  meta.textContent = formatClock(at)
  head.append(tag, meta)
  const body = element('p', 'answer-text')
  body.textContent = text
  card.append(head, body)
  wrap.append(card)
  return wrap
}

function renderCommandResult(result: Extract<ChainAskResult, { kind: 'command' }>): void {
  const pending = threadEl.querySelector('.card.pending')?.closest('.msg') ?? null
  const wrap = receiptBubble('命令', result.text)
  if (pending) pending.replaceWith(wrap)
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
  attachButton.disabled = next
  questionInput.disabled = next
}

async function ask(
  question: string,
  imagePath?: string,
  attachments?: readonly AttachmentView[]
): Promise<void> {
  if (busy) return
  if (!api) {
    setStatus('error', '窗口没接上主进程（preload 缺失）')
    return
  }
  if (activeConversationId === null) activeConversationId = newConversationId()
  // 空会话里只摘掉空态提示：命令回执不落历史（主进程直接返回、不过 settle），
  // 这里整片 replaceChildren 会让连续几条命令只剩最后一条。
  if (currentThreadEntries.length === 0) threadEl.querySelector('.thread-empty')?.remove()

  setupBusy()
  appendPending(question, imagePath, attachments)
  questionInput.value = ''
  const conversationId = activeConversationId
  // 附件随这一次问题发送；发出去之后就不再重复带（追问不重发旧图 / 旧文件）
  const apiAttachments = (attachments ?? [])
    .map((item) =>
      item.kind === 'image' && item.dataUrl
        ? { kind: 'image' as const, name: item.name, dataUrl: item.dataUrl }
        : item.kind === 'file' && item.text
          ? { kind: 'file' as const, name: item.name, text: item.text }
          : null
    )
    .filter((item): item is NonNullable<typeof item> => item !== null)
  pendingAttachments = []
  renderAttachments()

  try {
    const result = await api.query(
      question,
      conversationId,
      imagePath,
      apiAttachments.length > 0 ? apiAttachments : undefined
    )
    if (result.kind === 'continue-ask') {
      // 这一问还没落历史：保留刚画的问题气泡，只把等待卡换成「还要继续吗」
      renderContinueCard(result)
      const status = statusOf(result)
      setStatus(status.kind, status.text)
      return
    }
    if (result.kind === 'command') {
      // `/mode` / `/use` / `/new`：先刷新模式条；切了分支就把线程换成新分支的（D72）
      const switched = result.mode !== undefined && result.mode.branch !== askMode?.branch
      if (result.mode) setAskMode(result.mode)
      else await refreshMode()
      if (switched) {
        activeConversationId = null
        currentThreadEntries = []
        await refreshHistory()
        renderThread()
      }
      // 命令回执不落历史，不能走 refreshHistory / renderThread（否则刚画的回执会被重建掉）
      renderCommandResult(result)
      setStatus('idle', '命令已执行')
      return
    }
    const status = statusOf(result)
    setStatus(status.kind, status.text)
    // 传承会切分支（D72）：回答完刷新一下模式条与分支信息
    void refreshMode()
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
  const attachments = pendingAttachments.slice()
  void ask(question, undefined, attachments)
})

/* 附件入口：点按钮选文件、直接粘贴图片、把文件拖进输入区 */
attachButton.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? [])
  fileInput.value = ''
  if (files.length > 0) void addFiles(files)
})
questionInput.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length > 0) {
    event.preventDefault()
    void addFiles(files)
  }
})
form.addEventListener('dragover', (event) => {
  event.preventDefault()
})
form.addEventListener('drop', (event) => {
  event.preventDefault()
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length > 0) void addFiles(files)
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
  clearAttachments()
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
/* 模式条（D72）：ask / chat 两个按钮，点了发 `/mode`（切分支）           */
/* ------------------------------------------------------------------ */

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    const kind = button.dataset.mode
    if (kind !== 'ask' && kind !== 'chat') return
    void requestMode(kind)
  })
}

applyModeUI()
void refreshMode()

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

/* ------------------------------------------------------------------ */
/* 设置抽屉 · 个人记忆（日记目录 + 人设）                              */
/* ------------------------------------------------------------------ */

const DIR_SOURCE_TEXT: Record<MemorySettingsView['dirSource'], string> = {
  env: '环境变量 GOTCHA_MEMORY_VAULT',
  setting: '设置里的目录',
  auto: '自动探测（日记最多的位置）',
  none: '没有找到'
}

function fillMemorySettings(view: MemorySettingsView): void {
  memoryVaultInput.value = view.vaultDir
  memoryNameInput.value = view.personaName
  memoryToneInput.value = view.personaTone
  memoryRedlinesInput.value = view.redLines.join('\n')
  const dir = view.resolvedDir ?? '（没有）'
  const stats = view.stats
  const range =
    stats.firstDay !== null && stats.lastDay !== null ? ` · ${stats.firstDay} → ${stats.lastDay}` : ''
  memoryStatusEl.textContent = `当前目录：${dir}（${DIR_SOURCE_TEXT[view.dirSource]}）· 索引 ${stats.items} 条 / ${stats.days} 天${range}`
  memoryStatusEl.dataset.source = view.dirSource

  // 人格卡（D62）：下拉 = 不使用 + 目录里的卡；启用的卡文件被删了也回显（带「文件不存在」）
  activePersonaCard = view.activeCard
  personaCardSelect.replaceChildren()
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '不使用（走上面的名字 / 口吻）'
  personaCardSelect.append(none)
  for (const card of view.cards) {
    const option = document.createElement('option')
    option.value = card.name
    option.textContent = `${card.title || card.name}（${card.chars} 字）`
    personaCardSelect.append(option)
  }
  if (view.activeCard !== '' && !view.cards.some((card) => card.name === view.activeCard)) {
    const missing = document.createElement('option')
    missing.value = view.activeCard
    missing.textContent = `${view.activeCard}（文件不存在）`
    personaCardSelect.append(missing)
  }
  personaCardSelect.value = view.activeCard
  personaCardStatus.textContent =
    view.cardDir === ''
      ? '当前环境读不到卡片目录'
      : view.cards.length > 0
        ? `卡片目录：${view.cardDir}（${view.cards.length} 张）`
        : `还没有卡片。点「导入 .md」，或把 .md 放进 ${view.cardDir}`
  personaCardPreview.value = ''
  void refreshPersonaCardPreview()
  applyModeUI()
}

/** 预览当前选中的卡（只读；读不到就是空） */
async function refreshPersonaCardPreview(): Promise<void> {
  const name = personaCardSelect.value
  if (!api || name === '') {
    personaCardPreview.value = ''
    return
  }
  try {
    personaCardPreview.value = (await api.personaCard(name)) ?? ''
  } catch {
    personaCardPreview.value = ''
  }
}

/** 读一次记忆设置并回填（开抽屉 / 保存后都走这里） */
async function refreshMemorySettings(note = ''): Promise<void> {
  if (!api) return
  memoryMsg.textContent = note
  memoryMsg.style.color = ''
  try {
    const view = await api.memorySettings()
    if ('error' in view) {
      memoryStatusEl.textContent =
        view.error === 'db-unavailable'
          ? '还没有记忆库（同步一次日记或开始采集后可用）'
          : '读取个人记忆设置失败'
      return
    }
    fillMemorySettings(view)
  } catch (error) {
    memoryStatusEl.textContent = `读取个人记忆设置失败：${String(error)}`
  }
}

/* ---- 设置抽屉 · 记忆仓（D90） ---------------------------------------- */

/** 一行状态：远端 / 分支 / 未推送 / 未提交 / 上次推送，能一眼看出「现在到底通不通」 */
function fillMemoryRepo(view: MemoryRepoSettingsView): void {
  memoryCommitInput.value = String(view.commitMinutes)
  memoryPushInput.value = String(view.pushMinutes)
  memoryRepoPushButton.disabled = view.remote === null
  if (view.remote !== null) memoryRemoteInput.value = view.remote
  if (!view.available) {
    memoryRepoStatus.textContent = '记忆仓不可用（没找到 git，或仓读不出来）'
    return
  }
  const parts: string[] = [
    view.remote === null ? '还没绑定远端（只在本机提交）' : `远端：${view.remote}`,
    `分支 ${view.branch}`
  ]
  if (view.remote !== null) {
    parts.push(
      view.ahead === null ? '还没推过' : view.ahead === 0 ? '与远端一致' : `有 ${view.ahead} 个提交没推`
    )
  }
  if (view.dirty) parts.push('有未提交的改动')
  if (view.lastPush !== null) {
    parts.push(
      view.lastPush.ok ? '上次推送成功' : `上次推送失败（${view.lastPush.reason ?? '未知'}）`
    )
  }
  memoryRepoStatus.textContent = parts.join(' · ')
}

/** 读一次记忆仓状态（开抽屉 / 保存 / 推送后都走这里） */
async function refreshMemoryRepo(note = ''): Promise<void> {
  if (!api) return
  memoryRepoMsg.textContent = note
  memoryRepoMsg.style.color = ''
  try {
    const view = await api.memoryRepo()
    if ('error' in view) {
      memoryRepoStatus.textContent = '读取记忆仓状态失败（主进程那一侧报错）'
      return
    }
    fillMemoryRepo(view)
  } catch (error) {
    memoryRepoStatus.textContent = `读取记忆仓状态失败：${String(error)}`
  }
}

/* ---- 设置抽屉 · 折叠分组（D90） -------------------------------------- */

/** 展开状态记在渲染层本地（不进设置库：它只是界面偏好） */
const SETTINGS_OPEN_KEY = 'gotcha.settings.open'

function readOpenSections(): string[] {
  try {
    const raw = localStorage.getItem(SETTINGS_OPEN_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * 把每个 `<section>` 改造成「可点的组头 + 可折叠的内容」：默认全折叠，
 * 点开才展开；展开的是哪几组记在 localStorage，关掉窗口再开还是那几组。
 *
 * 在运行时改造而不是改 HTML：控件 id 与事件什么都不动，样式也只多一层 `.sec-body`。
 */
function setupCollapsibleSettings(): void {
  const form = document.getElementById('settings-form')
  if (form === null) return
  let open = readOpenSections()
  const sections = [...form.querySelectorAll<HTMLElement>(':scope > section')]
  sections.forEach((section, index) => {
    const title = section.querySelector('h3')
    if (!(title instanceof HTMLElement)) return
    const id = section.id !== '' ? section.id : `settings-sec-${index}`
    section.id = id
    const body = document.createElement('div')
    body.className = 'sec-body'
    // 把标题之外的内容整体搬进 body（移动节点，不是复制：事件与引用都还在）
    for (const child of [...section.childNodes]) {
      if (child !== title) body.appendChild(child)
    }
    title.remove()
    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'sec-head'
    head.textContent = title.textContent ?? ''
    const expanded = open.includes(id)
    head.setAttribute('aria-expanded', String(expanded))
    body.hidden = !expanded
    head.addEventListener('click', () => {
      const next = body.hidden
      body.hidden = !next
      head.setAttribute('aria-expanded', String(next))
      const set = new Set(open)
      if (next) set.add(id)
      else set.delete(id)
      open = [...set]
      try {
        localStorage.setItem(SETTINGS_OPEN_KEY, JSON.stringify(open))
      } catch {
        // 存不住就只在这次会话里生效，不打断使用
      }
    })
    section.append(head, body)
  })
}

function openSettingsDrawer(): void {
  void settingsPanel?.open()
  void refreshMemorySettings()
  void refreshMemoryRepo()
  void refreshQqSettings()
  startNapcatPolling()
  void loadMemoryList(true)
}

if (api) {
  memoryRepoSaveButton.addEventListener('click', async () => {
    const remote = memoryRemoteInput.value.trim()
    const commitMinutes = Number(memoryCommitInput.value)
    const pushMinutes = Number(memoryPushInput.value)
    const patch: Record<string, unknown> = { commitMinutes, pushMinutes }
    if (remote !== '') patch.remote = remote
    memoryRepoMsg.textContent = '保存中…'
    memoryRepoMsg.style.color = ''
    try {
      const result = await api.saveMemoryRepo(patch)
      if (result.view) fillMemoryRepo(result.view)
      memoryRepoMsg.textContent = result.ok ? '已保存（定时按新间隔生效）' : result.error ?? '保存失败'
      memoryRepoMsg.style.color = result.ok ? '' : 'var(--error)'
    } catch (error) {
      memoryRepoMsg.textContent = `保存失败：${String(error)}`
      memoryRepoMsg.style.color = 'var(--error)'
    }
  })

  memoryRepoPushButton.addEventListener('click', async () => {
    memoryRepoMsg.textContent = '推送中…'
    memoryRepoMsg.style.color = ''
    try {
      const result = await api.pushMemoryRepo()
      if (result.view) fillMemoryRepo(result.view)
      memoryRepoMsg.textContent = result.ok ? '推送成功' : result.error ?? '推送失败'
      memoryRepoMsg.style.color = result.ok ? '' : 'var(--error)'
    } catch (error) {
      memoryRepoMsg.textContent = `推送失败：${String(error)}`
      memoryRepoMsg.style.color = 'var(--error)'
    }
  })

  memorySaveButton.addEventListener('click', async () => {
    if (busy) {
      // 同步要开写连接（会短暂关掉只读连接），别在回答进行中动库
      memoryMsg.textContent = '等这次回答结束再保存（同步会短暂占用数据库）'
      memoryMsg.style.color = 'var(--error)'
      return
    }
    memorySaveButton.disabled = true
    memoryMsg.textContent = '保存中…'
    memoryMsg.style.color = ''
    try {
      const redLines = memoryRedlinesInput.value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
      const result = await api.saveMemorySettings({
        vaultDir: memoryVaultInput.value.trim(),
        personaName: memoryNameInput.value,
        personaTone: memoryToneInput.value,
        redLines
      })
      if (!result.ok) {
        memoryMsg.textContent = `没有保存：${result.error}`
        memoryMsg.style.color = 'var(--error)'
        return
      }
      if (result.view) fillMemorySettings(result.view)
      if (result.sync) {
        const sync = result.sync
        memoryMsg.textContent = `已保存并同步：${result.syncedDir}（${sync.scanned} 篇 / 新增 ${sync.added} / 删除 ${sync.removed} / 共 ${sync.items} 条）`
      } else if (result.syncError) {
        memoryMsg.textContent = `设置已保存，但同步失败：${result.syncError}`
        memoryMsg.style.color = 'var(--error)'
      } else {
        memoryMsg.textContent = '已保存；没有可同步的日记目录（留空 = 自动找）'
      }
      // 同步会改动条目（新增 / 删除），列表跟着重读一遍
      void loadMemoryList(true)
    } catch (error) {
      memoryMsg.textContent = `保存失败：${String(error)}`
      memoryMsg.style.color = 'var(--error)'
    } finally {
      memorySaveButton.disabled = false
    }
  })
}

if (api) {
  // 人格卡（D62）：切换 / 导入即启用；文本由渲染层读好，主进程按上限校验
  personaCardSelect.addEventListener('change', async () => {
    void refreshPersonaCardPreview()
    const name = personaCardSelect.value
    personaCardMsg.style.color = ''
    personaCardMsg.textContent = '切换中…'
    try {
      const result = await api!.saveMemorySettings({ personaCard: name })
      if (!result.ok) {
        personaCardMsg.textContent = `没有切换：${result.error}`
        personaCardMsg.style.color = 'var(--error)'
        return
      }
      personaCardMsg.textContent =
        name === '' ? '已停用（回到名字 / 口吻）' : `已启用：${name}（从下一次聊天生效）`
      if (result.view) fillMemorySettings(result.view)
    } catch (error) {
      personaCardMsg.textContent = `切换失败：${String(error)}`
      personaCardMsg.style.color = 'var(--error)'
    }
  })

  personaCardFileInput.addEventListener('change', async () => {
    const file = personaCardFileInput.files?.[0]
    // 选同一个文件两次也要触发：先把 input 清空
    personaCardFileInput.value = ''
    if (!file) return
    personaCardMsg.style.color = ''
    personaCardMsg.textContent = `导入中：${file.name}…`
    try {
      const text = await file.text()
      const result = await api!.savePersonaCard(file.name.replace(/\.md$/i, ''), text)
      if (!result.ok) {
        personaCardMsg.textContent = `没有导入：${result.error}`
        personaCardMsg.style.color = 'var(--error)'
        return
      }
      personaCardMsg.textContent = `已导入并启用：${file.name}（从下一次聊天生效）`
      if (result.view) fillMemorySettings(result.view)
    } catch (error) {
      personaCardMsg.textContent = `导入失败：${String(error)}`
      personaCardMsg.style.color = 'var(--error)'
    }
  })

  personaCardOpenButton.addEventListener('click', async () => {
    try {
      const ok = await api!.openPersonaCardDir()
      personaCardMsg.textContent = ok ? '已在文件资源管理器里打开' : '打不开卡片目录'
    } catch (error) {
      personaCardMsg.textContent = `打不开卡片目录：${String(error)}`
    }
  })
}

/* ------------------------------------------------------------------ */
/* 设置抽屉 · QQ 通道（D63：OneBot 11 反向 WS，默认关）                */
/* ------------------------------------------------------------------ */

function fillQqSettings(view: QqSettingsView): void {
  qqEnabledInput.checked = view.enabled
  qqLanInput.checked = view.allowLan
  qqPortInput.value = String(view.port)
  qqTokenInput.value = view.accessToken
  qqAllowInput.value = view.allowUsers.join(', ')
  qqMaxCharsInput.value = String(view.replyMaxChars)
  const listen = `${view.allowLan ? '0.0.0.0' : '127.0.0.1'}:${view.port}`
  qqStatusEl.textContent = view.running
    ? `运行中：${listen} · NapCat 已连 ${view.connections} 条`
    : view.enabled
      ? `已开启但没起来${view.lastError !== undefined ? `（${view.lastError}）` : ''}`
      : '未开启（不监听任何端口）'
  qqStatusEl.style.color = view.enabled && !view.running ? 'var(--error)' : ''
}

/** 读一次 QQ 通道设置并回填（开抽屉 / 保存后都走这里） */
async function refreshQqSettings(note = ''): Promise<void> {
  if (!api) return
  qqMsg.textContent = note
  qqMsg.style.color = ''
  try {
    const view = await api.qqSettings()
    if ('error' in view) {
      qqStatusEl.textContent =
        view.error === 'db-unavailable'
          ? '还没有记忆库（开始采集或同步一次日记后可用）'
          : '读取 QQ 通道设置失败'
      return
    }
    fillQqSettings(view)
  } catch (error) {
    qqStatusEl.textContent = `读取 QQ 通道设置失败：${String(error)}`
  }
}

if (api) {
  qqSaveButton.addEventListener('click', async () => {
    qqSaveButton.disabled = true
    qqMsg.style.color = ''
    qqMsg.textContent = '保存中…'
    try {
      const result = await api!.saveQqSettings({
        enabled: qqEnabledInput.checked,
        allowLan: qqLanInput.checked,
        port: Number(qqPortInput.value),
        accessToken: qqTokenInput.value,
        allowUsers: qqAllowInput.value,
        replyMaxChars: Number(qqMaxCharsInput.value),
        napcatAutoStart: qqNapcatAutoInput.checked
      })
      if (!result.ok) {
        qqMsg.textContent = `没有保存：${result.error}`
        qqMsg.style.color = 'var(--error)'
        return
      }
      fillQqSettings(result.view)
      qqNapcatAutoDirty = false
      void refreshNapcat()
      qqMsg.textContent = result.view.running
        ? '已保存并开始监听（NapCat 里填好同样的端口与 token）'
        : '已保存；未运行，原因见上面那行状态'
    } catch (error) {
      qqMsg.textContent = `保存失败：${String(error)}`
      qqMsg.style.color = 'var(--error)'
    } finally {
      qqSaveButton.disabled = false
    }
  })
}

/* ------------------------------------------------------------------ */
/* 设置抽屉 · NapCat 托管（D66）：状态 / 二维码 / 启停 / 下载安装       */
/* ------------------------------------------------------------------ */

let qqNapcatTimer: number | null = null
let qqNapcatBusy = false
/** 用户改过「自动启动」但还没保存：轮询别把复选框改回去 */
let qqNapcatAutoDirty = false

function napcatStatusText(view: NapcatView): string {
  switch (view.phase) {
    case 'downloading':
      return `NapCat：下载中… ${Math.round((view.progress ?? 0) * 100)}%`
    case 'installing':
      return 'NapCat：正在解压…'
    case 'starting':
      return 'NapCat：正在启动 QQ…'
    case 'waiting-login':
      if (view.loggedIn) return 'NapCat：QQ 已登录，正在接入 Gotcha…'
      return view.qrDataUrl !== undefined
        ? 'NapCat：用手机 QQ 扫码登录（二维码约 2 分钟有效）'
        : 'NapCat：等待二维码…（QQ 登录窗口可能已经弹出）'
    case 'connected':
      return `NapCat：已登录并连上 Gotcha${view.uin !== undefined ? `（${view.uin}）` : ''}`
    case 'error':
      return `NapCat：${view.error ?? '出错了，点「启动」重试'}`
    default:
      return view.installed
        ? `NapCat：已找到${view.shellDir !== undefined ? `（${view.shellDir}）` : ''}，点「启动」`
        : 'NapCat：没找到，点「下载并安装」，或选择已有目录'
  }
}

function renderNapcatView(view: NapcatView): void {
  qqNapcatStatusEl.textContent = napcatStatusText(view)
  qqNapcatStatusEl.style.color = view.phase === 'error' ? 'var(--error)' : ''

  const working =
    view.phase === 'downloading' || view.phase === 'installing' || view.phase === 'starting'
  qqNapcatInstallButton.hidden = view.installed
  qqNapcatInstallButton.disabled = working || qqNapcatBusy
  qqNapcatStartButton.disabled =
    !view.installed || working || view.phase === 'connected' || view.phase === 'waiting-login'
  qqNapcatStopButton.disabled =
    !view.installed || view.phase === 'idle' || view.phase === 'error' || view.phase === 'downloading'

  if (view.qrDataUrl !== undefined) {
    qqNapcatQrEl.src = view.qrDataUrl
    qqNapcatQrEl.hidden = false
  } else {
    qqNapcatQrEl.hidden = true
    qqNapcatQrEl.removeAttribute('src')
  }

  const downloading = view.phase === 'downloading'
  qqNapcatProgressEl.hidden = !downloading
  qqNapcatProgressEl.value = downloading ? (view.progress ?? 0) : 0

  qqNapcatAutoInput.checked = qqNapcatAutoDirty ? qqNapcatAutoInput.checked : view.autoStart
}

/** 只在抽屉打开时轮询（1.5s）；关掉就停，不做后台常驻 */
function startNapcatPolling(): void {
  qqNapcatAutoDirty = false
  if (qqNapcatTimer !== null) {
    void refreshNapcat()
    return
  }
  qqNapcatTimer = window.setInterval(() => {
    if (drawerEl.hidden) {
      stopNapcatPolling()
      return
    }
    void refreshNapcat()
  }, 1_500)
  void refreshNapcat()
}

function stopNapcatPolling(): void {
  if (qqNapcatTimer === null) return
  window.clearInterval(qqNapcatTimer)
  qqNapcatTimer = null
}

async function refreshNapcat(): Promise<void> {
  if (!api) return
  try {
    const view = await api.qqNapcatStatus()
    if ('error' in view) {
      qqNapcatStatusEl.textContent = 'NapCat：读取状态失败'
      return
    }
    renderNapcatView(view)
  } catch (error) {
    qqNapcatStatusEl.textContent = `NapCat：读取状态失败（${String(error)}）`
  }
}

async function runNapcatAction(action: 'start' | 'stop' | 'install' | 'dir'): Promise<void> {
  if (!api || qqNapcatBusy) return
  qqNapcatBusy = true
  qqNapcatStatusEl.style.color = ''
  qqNapcatStatusEl.textContent =
    action === 'install'
      ? 'NapCat：开始下载…'
      : action === 'start'
        ? 'NapCat：启动中…'
        : action === 'stop'
          ? 'NapCat：停止中…'
          : 'NapCat：选择目录…'
  try {
    const result =
      action === 'start'
        ? await api.qqNapcatStart()
        : action === 'stop'
          ? await api.qqNapcatStop()
          : action === 'install'
            ? await api.qqNapcatInstall()
            : await api.qqNapcatChooseDir()
    if (!result.ok && result.error !== undefined) {
      qqNapcatStatusEl.textContent = `NapCat：${result.error}`
      qqNapcatStatusEl.style.color = 'var(--error)'
    }
  } catch (error) {
    qqNapcatStatusEl.textContent = `NapCat：操作失败（${String(error)}）`
    qqNapcatStatusEl.style.color = 'var(--error)'
  } finally {
    qqNapcatBusy = false
    void refreshNapcat()
  }
}

if (api) {
  qqNapcatAutoInput.addEventListener('change', () => {
    qqNapcatAutoDirty = true
  })
  qqNapcatInstallButton.addEventListener('click', () => void runNapcatAction('install'))
  qqNapcatDirButton.addEventListener('click', () => void runNapcatAction('dir'))
  qqNapcatStartButton.addEventListener('click', () => void runNapcatAction('start'))
  qqNapcatStopButton.addEventListener('click', () => void runNapcatAction('stop'))
}

/* ------------------------------------------------------------------ */
/* 设置抽屉 · 记忆条目（浏览 / 删除 / 撤销）                            *//* ------------------------------------------------------------------ */

/** 一页多少条（主进程 `memory-admin` 的上限 50；抽屉里 20 条一屏差不多） */
const MEMORY_PAGE_SIZE = 20
const MEMORY_KIND_TEXT: Record<MemoryListItemView['kind'], string> = {
  diary: '日记',
  task: '待办',
  note: '笔记',
  quote: '摘录'
}

/** 已经画到第几条（下一页的 offset）与当前条件的总条数 */
let memoryListLoaded = 0
let memoryListTotal = 0
let memoryListLoading = false
/** 最近一次删除的 uid（回收站键）：「撤销删除」按它放回 */
let memoryLastDeletedUid: string | null = null
/** 搜索框防抖（每敲一个字都查库没必要） */
let memorySearchTimer: number | null = null

function memoryRowElement(item: MemoryListItemView): HTMLLIElement {
  const row = element('li', 'memory-item')
  row.dataset.id = String(item.id)
  const head = element('div', 'memory-item-head')
  const day = element('span', 'memory-item-day')
  const clock = item.clock !== null ? ` ${item.clock}` : ''
  const section = item.section !== '' ? ` · ${item.section}` : ''
  day.textContent = `${item.day}${clock} · ${MEMORY_KIND_TEXT[item.kind]}${section}`
  const del = element('button', 'memory-item-del')
  del.type = 'button'
  del.textContent = '删除'
  del.title = '从记忆里删掉这一条（不改日记原文；删错了可以撤销）'
  del.addEventListener('click', () => {
    void deleteMemoryEntry(item)
  })
  head.append(day, del)
  const text = element('p', 'memory-item-text')
  text.textContent = item.text
  if (item.text.length > 160) {
    // 日记一段能有两千字：先折 8 行，点一下展开 / 收起
    text.classList.add('clamped')
    text.title = '点一下展开 / 收起'
    text.addEventListener('click', () => {
      text.classList.toggle('clamped')
    })
  }
  row.append(head, text)
  const meta: string[] = []
  if (item.tags.length > 0) meta.push(item.tags.map((tag) => `#${tag}`).join(' '))
  if (item.refs.length > 0) meta.push(item.refs.map((ref) => `[[${ref}]]`).join(' '))
  if (meta.length > 0) {
    const bits = element('p', 'memory-item-meta')
    bits.textContent = meta.join(' · ')
    row.append(bits)
  }
  return row
}

function setMemoryListMsg(text: string, isError = false): void {
  memoryListMsg.textContent = text
  memoryListMsg.style.color = isError ? 'var(--error)' : ''
}

function memoryListSummary(deleted: number): string {
  return `共 ${memoryListTotal} 条${deleted > 0 ? ` · 已删除 ${deleted} 条` : ''}`
}

/** 读一页：`reset` 从头画（搜索 / 类别 / 删除后），否则接着上一页追加 */
async function loadMemoryList(reset: boolean): Promise<void> {
  if (!api || memoryListLoading) return
  memoryListLoading = true
  const offset = reset ? 0 : memoryListLoaded
  if (reset) setMemoryListMsg('正在读取…')
  try {
    const result = await api.memoryList({
      search: memorySearchInput.value.trim(),
      kind: memoryKindSelect.value,
      offset,
      limit: MEMORY_PAGE_SIZE
    })
    if (!result.ok) {
      setMemoryListMsg(
        result.error === 'db-unavailable'
          ? '还没有记忆库（同步一次日记或开始采集后可用）'
          : `读取失败：${result.error}`,
        result.error !== 'db-unavailable'
      )
      return
    }
    if (reset) {
      memoryItemsEl.replaceChildren()
      memoryListLoaded = 0
    }
    for (const item of result.items) memoryItemsEl.append(memoryRowElement(item))
    memoryListLoaded = offset + result.items.length
    memoryListTotal = result.total
    memoryMoreButton.hidden = !result.hasMore
    memoryUndoButton.hidden = memoryLastDeletedUid === null
    setMemoryListMsg(
      memoryListTotal === 0
        ? `没有匹配的条目${result.deleted > 0 ? ` · 已删除 ${result.deleted} 条` : ''}`
        : memoryListSummary(result.deleted)
    )
  } catch (error) {
    setMemoryListMsg(`读取失败：${String(error)}`, true)
  } finally {
    memoryListLoading = false
  }
}

/** 删一条：进回收站，列表重读；删错了点「撤销删除」放回 */
async function deleteMemoryEntry(item: MemoryListItemView): Promise<void> {
  if (!api) return
  if (busy) {
    // 删除要开写连接（会先关掉只读连接），和保存一样等回答结束
    setMemoryListMsg('等这次回答结束再删（删除会短暂占用数据库）', true)
    return
  }
  const label = `${item.day}${item.clock !== null ? ` ${item.clock}` : ''}「${item.text.slice(0, 18)}」`
  try {
    const result = await api.memoryDelete(item.id)
    if (!result.ok) {
      setMemoryListMsg(`没有删除：${result.error}`, true)
      return
    }
    memoryLastDeletedUid = result.item.uid
    memoryUndoButton.hidden = false
    await loadMemoryList(true)
    setMemoryListMsg(`已删除 ${label}（可撤销）`)
    // 状态行的「索引 N 条」跟着变（统计来自主进程现读）
    void refreshMemorySettings()
  } catch (error) {
    setMemoryListMsg(`删除失败：${String(error)}`, true)
  }
}

async function undoLastDelete(): Promise<void> {
  if (!api || memoryLastDeletedUid === null) return
  if (busy) {
    setMemoryListMsg('等这次回答结束再撤销（会短暂占用数据库）', true)
    return
  }
  const uid = memoryLastDeletedUid
  try {
    const result = await api.memoryRestore(uid)
    if (!result.ok) {
      setMemoryListMsg(`没有恢复：${result.error}`, true)
      return
    }
    memoryLastDeletedUid = null
    memoryUndoButton.hidden = true
    await loadMemoryList(true)
    setMemoryListMsg(`已恢复 ${result.item.day} 的那一条`)
    void refreshMemorySettings()
  } catch (error) {
    setMemoryListMsg(`撤销失败：${String(error)}`, true)
  }
}

if (api) {
  memorySearchInput.addEventListener('input', () => {
    if (memorySearchTimer !== null) window.clearTimeout(memorySearchTimer)
    memorySearchTimer = window.setTimeout(() => {
      memorySearchTimer = null
      void loadMemoryList(true)
    }, 300)
  })
  // 搜索框在 #settings-form 里：回车默认会「保存设置」，这里改成立即查一次
  memorySearchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (memorySearchTimer !== null) {
      window.clearTimeout(memorySearchTimer)
      memorySearchTimer = null
    }
    void loadMemoryList(true)
  })
  memoryKindSelect.addEventListener('change', () => {
    void loadMemoryList(true)
  })
  memoryMoreButton.addEventListener('click', () => {
    void loadMemoryList(false)
  })
  memoryUndoButton.addEventListener('click', () => {
    void undoLastDelete()
  })
}

settingsButton.addEventListener('click', openSettingsDrawer)

// 点遮罩空白处关抽屉；Esc 也关（面板自己不管关闭键）
drawerEl.addEventListener('mousedown', (event) => {
  if (event.target === drawerEl) settingsPanel?.close()
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsPanel?.isOpen()) settingsPanel.close()
})

// 托盘 / 球右键的「设置」：窗口打开即展开抽屉
api?.onOpenSettings(() => {
  openSettingsDrawer()
})

void (async () => {
  setupCollapsibleSettings()
  questionInput.focus()
  renderThread()
  if (!api) {
    setStatus('error', '窗口没接上主进程（preload 缺失）')
    return
  }
  await refreshHistory()
  // 默认新会话（D55 ②）：不静默接上最近一段；要接着问就点顶部「继续上一段」或左栏记录
  await refreshConsent()
  // 读一次人设 / 卡库：模式条的「人格卡：xx」要显示真实启用的卡（读不到就显示未选卡）
  void refreshMemorySettings()
  // 选区问答的交接单：新开一条会话、带着截图直接问（不覆盖用户正在看的会话）
  api?.onPrefill((payload) => {
    if (busy) return
    activeConversationId = null
    currentThreadEntries = []
    threadEl.replaceChildren()
    void ask(payload.question, payload.imagePath)
  })
})()
