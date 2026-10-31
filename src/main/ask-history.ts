/**
 * 问记忆的对话记录（S3-lite 增补）
 *
 * 落盘：`<userData>/ask-history.jsonl`，一行一条，追加写。
 * 拍板人 2026-10-27 定「永久保留」：不自动删，窗口里给「清空记录」。
 * 渲染层 sandbox 读不了文件，读写都在主进程，经 `ask:history*` 通道进出。
 *
 * 只存「问过什么 / 答了什么 / 引用了哪几段」；截图与正文仍从段证据现读，
 * 所以段被保留期清掉之后，历史里只剩文字，引用点开可能读不到证据（如实报，不编）。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ChainAskCitation,
  ChainAskMemoryCitation,
  ChainAskRelatedSegment,
  ChainAskResult,
  ChainAskStats,
  ChainAskTrace,
  ChainAskTraceStep,
  ChainAskTraceTool
} from '../chain/agent/types'

export const ASK_HISTORY_FILE = 'ask-history.jsonl'

/** 用户随问题上传的附件（只存展示用的元信息；图片原图在 ask-shots 下，文本不落盘） */
export interface AskHistoryAttachment {
  kind: 'image' | 'file'
  /** 原始文件名（图片可能是「截图」） */
  name?: string
  /** 图片在 ask-shots 下的留存路径（30 天后清掉，界面如实降级） */
  path?: string
  /** 文本文件抽出的字符数（原文件不落盘） */
  chars?: number
}

export interface AskHistoryEntry {
  /** 渲染层列表 key（时刻 + 随机后缀） */
  id: string
  /** 所属会话（同一会话的多轮追问共用；老记录没有这个字段 = 单条会话） */
  conversationId?: string
  /**
   * 提问时所在的分支（D72 分支即模式）：上下文 / ask_history 只认同一个分支，
   * 切 `/mode ask` 后不会把 chat 的记录带过去。老记录没有这个字段 = default。
   */
  branch?: string
  /** 提问时刻（毫秒） */
  at: number
  question: string
  /**
   * `insufficient`：查到了相关段、但撑不起结论（2026-10-29 新增）。
   * 老记录里没有这个值，读的时候按 `KINDS` 跳过即可。
   */
  kind: 'answer' | 'no-evidence' | 'insufficient' | 'error' | 'clarify'
  answer?: string
  citations: ChainAskCitation[]
  /** 日记引用（个人记忆 · 第二本账）；老记录没有这个字段 */
  memories?: ChainAskMemoryCitation[]
  /** 检索到、但没进引用的段（`insufficient` / `no-evidence` 才有；只为给界面一个入口） */
  related?: ChainAskRelatedSegment[]
  /** 选区问答：随这条对话留存的截图路径（`<userData>/ask-shots/shot-*.png`；过期清掉后读不到，界面如实降级） */
  imagePath?: string
  /** 用户随这条问题上传的附件（图片路径 / 文本文件名；老记录没有这个字段） */
  attachments?: AskHistoryAttachment[]
  /** `kind=no-evidence` 时模型给的补充说明（查到了什么、为什么不足以回答）；没有就显示固定文案 */
  note?: string
  /** `kind=clarify`：模型反向向用户确认的问题 + 候选 */
  clarify?: { question: string; options: string[] }
  /** `kind=error` 时的结构化原因（`ChainAskErrorReason`） */
  reason?: string
  /** `kind=error` 时的可读消息 */
  message?: string
  /**
   * 传承那一问（M4）：界面上照常显示，但不进下一代的上下文（模型历史 / ask_history 工具都过滤）。
   * 老记录没有这个字段 = 普通问答。
   */
  conceived?: boolean
  /**
   * 交接回执（D82）：母亲生命耗尽、下一代接手时的那一行字。
   * 只用于展示；老记录没有这个字段。
   */
  receipt?: string
  /**
   * 过程（D55 ③）：每轮思考 + 工具调用摘要。
   * 老记录没有这个字段；只用于展示，不写回请求。
   */
  trace?: ChainAskTrace
  stats: ChainAskStats
}

const KINDS = new Set<AskHistoryEntry['kind']>([
  'answer',
  'no-evidence',
  'insufficient',
  'error',
  'clarify'
])

function isStats(value: unknown): value is ChainAskStats {
  if (typeof value !== 'object' || value === null) return false
  const stats = value as Record<string, unknown>
  return ['hits', 'evidence', 'cited', 'questionChars'].every(
    (key) => typeof stats[key] === 'number' && Number.isFinite(stats[key])
  )
}

function isCitation(value: unknown): value is ChainAskCitation {
  if (typeof value !== 'object' || value === null) return false
  const citation = value as Record<string, unknown>
  return (
    typeof citation.segmentId === 'number' &&
    Number.isInteger(citation.segmentId) &&
    citation.segmentId > 0 &&
    typeof citation.at === 'number' &&
    typeof citation.app === 'string' &&
    typeof citation.title === 'string' &&
    typeof citation.why === 'string'
  )
}

/** 日记引用：itemId 指回 `mem_items`；day / snippet 只用于展示，字段缺了就整条丢 */
function isMemoryCitation(value: unknown): value is ChainAskMemoryCitation {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.itemId === 'number' &&
    Number.isInteger(item.itemId) &&
    item.itemId > 0 &&
    typeof item.day === 'string' &&
    typeof item.section === 'string' &&
    typeof item.why === 'string' &&
    typeof item.snippet === 'string'
  )
}

function isClarify(value: unknown): value is { question: string; options: string[] } {  if (typeof value !== 'object' || value === null) return false
  const clarify = value as Record<string, unknown>
  return (
    typeof clarify.question === 'string' &&
    clarify.question.trim() !== '' &&
    Array.isArray(clarify.options) &&
    clarify.options.every((option) => typeof option === 'string')
  )
}

/** 相关段（检索到、没进引用）：只要段身份与标题，字段与引用同形但不带 why */
function isRelated(value: unknown): value is ChainAskRelatedSegment {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.segmentId === 'number' &&
    Number.isInteger(item.segmentId) &&
    item.segmentId > 0 &&
    typeof item.at === 'number' &&
    typeof item.app === 'string' &&
    typeof item.title === 'string'
  )
}

/** 过程（D55 ③）：允许缺省；形状不对整行跳过（别让一条脏 trace 把整段对话读没） */
function isTraceTool(value: unknown): value is ChainAskTraceTool {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.name === 'string' &&
    item.name !== '' &&
    typeof item.arguments === 'object' &&
    item.arguments !== null &&
    !Array.isArray(item.arguments) &&
    typeof item.summary === 'string'
  )
}

function isTraceStep(value: unknown): value is ChainAskTraceStep {
  if (typeof value !== 'object' || value === null) return false
  const step = value as Record<string, unknown>
  return (
    typeof step.turn === 'number' &&
    Number.isFinite(step.turn) &&
    (step.thinking === undefined || typeof step.thinking === 'string') &&
    Array.isArray(step.tools) &&
    step.tools.every(isTraceTool)
  )
}

function isTrace(value: unknown): value is ChainAskTrace {
  if (typeof value !== 'object' || value === null) return false
  const trace = value as Record<string, unknown>
  return Array.isArray(trace.steps) && trace.steps.every(isTraceStep)
}

/** 附件元信息校验（老记录没有这个字段；坏条目只丢这一条） */
function isAttachment(value: unknown): value is AskHistoryAttachment {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (item.kind !== 'image' && item.kind !== 'file') return false
  if (item.name !== undefined && typeof item.name !== 'string') return false
  if (item.path !== undefined && typeof item.path !== 'string') return false
  if (item.chars !== undefined && typeof item.chars !== 'number') return false
  return true
}

/** 单行校验：坏行（旧格式 / 手改 / 写了一半）返回 null，读到就跳过、不整份作废 */
export function parseAskHistoryEntry(value: unknown): AskHistoryEntry | null {  if (typeof value !== 'object' || value === null) return null
  const data = value as Record<string, unknown>
  if (typeof data.id !== 'string' || data.id === '') return null
  if (typeof data.at !== 'number' || !Number.isFinite(data.at)) return null
  if (typeof data.question !== 'string') return null
  if (typeof data.kind !== 'string' || !KINDS.has(data.kind as AskHistoryEntry['kind'])) return null
  if (!Array.isArray(data.citations)) return null
  if (!data.citations.every(isCitation)) return null
  if (data.related !== undefined && (!Array.isArray(data.related) || !data.related.every(isRelated))) {
    return null
  }
  if (data.memories !== undefined && (!Array.isArray(data.memories) || !data.memories.every(isMemoryCitation))) {
    return null
  }
  if (!isStats(data.stats)) return null
  if ((data.kind === 'answer' || data.kind === 'insufficient') && typeof data.answer !== 'string') {
    return null
  }
  if (data.imagePath !== undefined && (typeof data.imagePath !== 'string' || data.imagePath === '')) {
    return null
  }
  if (data.attachments !== undefined) {
    if (!Array.isArray(data.attachments) || !data.attachments.every(isAttachment)) return null
  }
  if (data.answer !== undefined && typeof data.answer !== 'string') return null
  if (data.reason !== undefined && typeof data.reason !== 'string') return null
  if (data.message !== undefined && typeof data.message !== 'string') return null
  if (data.note !== undefined && typeof data.note !== 'string') return null
  if (data.conversationId !== undefined && (typeof data.conversationId !== 'string' || data.conversationId === '')) {
    return null
  }
  if (data.branch !== undefined && (typeof data.branch !== 'string' || data.branch === '')) return null
  if (data.conceived !== undefined && typeof data.conceived !== 'boolean') return null
  if (data.receipt !== undefined && typeof data.receipt !== 'string') return null
  if (data.trace !== undefined && !isTrace(data.trace)) return null
  if (data.kind === 'clarify') {
    if (!isClarify(data.clarify)) return null
  } else if (data.clarify !== undefined) {
    if (!isClarify(data.clarify)) return null
  }
  return {
    id: data.id,
    at: data.at,
    question: data.question,
    kind: data.kind as AskHistoryEntry['kind'],
    ...(typeof data.conversationId === 'string' ? { conversationId: data.conversationId } : {}),
    ...(typeof data.branch === 'string' ? { branch: data.branch } : {}),
    ...(typeof data.imagePath === 'string' ? { imagePath: data.imagePath } : {}),
    ...(Array.isArray(data.attachments) ? { attachments: data.attachments as AskHistoryAttachment[] } : {}),
    ...(typeof data.answer === 'string' ? { answer: data.answer } : {}),
    citations: data.citations,
    ...(Array.isArray(data.memories) ? { memories: data.memories as ChainAskMemoryCitation[] } : {}),
    ...(Array.isArray(data.related) ? { related: data.related as ChainAskRelatedSegment[] } : {}),
    ...(isClarify(data.clarify) ? { clarify: data.clarify } : {}),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
    ...(typeof data.note === 'string' ? { note: data.note } : {}),
    ...(typeof data.conceived === 'boolean' ? { conceived: data.conceived } : {}),
    ...(typeof data.receipt === 'string' ? { receipt: data.receipt } : {}),
    ...(isTrace(data.trace) ? { trace: data.trace } : {}),
    stats: data.stats
  }
}

/**
 * 解析结果的进程内缓存（2026-10-30 收敛）：文件是**只追加**的，每问都要拿一次时间戳。
 * 以前每问 `readFileSync` + 逐行 `JSON.parse` 整个文件（永久保留、无界增长）；
 * 现在按 `path + mtime + size` 命中缓存，自己追加/清空时顺手推进缓存，
 * 只有文件被外部改过（手工编辑 / 拷回）才重解析。
 *
 * 缓存只留一份：问答历史只有一个文件，多份缓存反而会各自过期、互相打架。
 */
interface AskHistoryCache {
  path: string
  mtimeMs: number
  size: number
  /** 最新在前（与 `readAskHistory` 的返回顺序一致） */
  entries: AskHistoryEntry[]
}

let historyCache: AskHistoryCache | null = null

/** 用当前 stat 覆盖缓存头（追加 / 清空后调用；stat 失败就当缓存不可用） */
function refreshCacheHeader(filePath: string, entries: AskHistoryEntry[]): void {
  try {
    const stat = statSync(filePath)
    historyCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, entries }
  } catch {
    historyCache = null
  }
}

/** 读全部记录（**最新在前**）；文件不存在 / 读失败 / 坏行都按「没有」处理，不抛错、不建文件 */
export function readAskHistory(filePath: string): AskHistoryEntry[] {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(filePath)
  } catch {
    historyCache = null
    return []
  }
  if (
    historyCache !== null &&
    historyCache.path === filePath &&
    historyCache.mtimeMs === stat.mtimeMs &&
    historyCache.size === stat.size
  ) {
    // 返回浅拷贝：调用方拿去做 filter / map，别让人改到缓存本体
    return historyCache.entries.slice()
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    historyCache = null
    return []
  }
  const entries: AskHistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const entry = parseAskHistoryEntry(parsed)
    if (entry) entries.push(entry)
  }
  // 文件是追加写的，天然按时间正序；列表要最新在前
  const newestFirst = entries.reverse()
  historyCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, entries: newestFirst }
  return newestFirst.slice()
}

export function appendAskHistory(filePath: string, entry: AskHistoryEntry): void {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
  // 自己追加：把新条目推进缓存并刷新文件头，下一问就不用重读整个文件
  if (historyCache !== null && historyCache.path === filePath) {
    refreshCacheHeader(filePath, [entry, ...historyCache.entries])
  }
}

/** 清空 = 截断成空文件（保留文件本身，下一条继续追加） */
export function clearAskHistory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, '', 'utf8')
  refreshCacheHeader(filePath, [])
}

/**
 * 删掉某个会话的全部记录（M4 传承：女儿从空白开始）。
 * 只删**这个会话**，不动其他会话；返回删掉的条数。文件仍是追加写的 JSONL，
 * 删完重写成「旧 → 新」的行序，缓存头跟着刷新。
 */
export function removeAskHistoryConversation(filePath: string, conversationId: string): number {
  const entries = readAskHistory(filePath)
  const kept = entries.filter((entry) => (entry.conversationId ?? entry.id) !== conversationId)
  const removed = entries.length - kept.length
  if (removed === 0) return 0
  mkdirSync(dirname(filePath), { recursive: true })
  const lines = kept
    .slice()
    .reverse()
    .map((entry) => JSON.stringify(entry))
  writeFileSync(filePath, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
  // kept 已是「最新在前」，与 readAskHistory 的缓存口径一致
  refreshCacheHeader(filePath, kept)
  return removed
}

/** 把一次问答结果折成一条记录；id 只要在同一进程内唯一即可（时刻 + 随机后缀） */
export function toHistoryEntry(
  question: string,
  result: ChainAskResult,
  at: number,
  conversationId?: string,
  imagePath?: string,
  attachments?: readonly AskHistoryAttachment[],
  branch?: string
): AskHistoryEntry {
  const base = {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    at,
    question,
    stats: result.stats,
    ...(conversationId ? { conversationId } : {}),
    ...(branch ? { branch } : {}),
    ...(imagePath ? { imagePath } : {}),
    ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
    // 过程（D55 ③）：所有出口都带（暂停轮不落历史，最终结果会带完整 steps）
    ...(result.trace ? { trace: result.trace } : {}),
    // 传承那一问（M4）：只显示，不进下一代上下文
    ...(result.conceived ? { conceived: true } : {}),
    // 交接回执（D82）：跟这一问一起落盘，重开窗口还在
    ...(result.receipt !== undefined && result.receipt !== '' ? { receipt: result.receipt } : {})
  }
  if (result.kind === 'answer') {
    return {
      ...base,
      kind: 'answer',
      answer: result.answer,
      citations: result.citations,
      ...(result.memories && result.memories.length > 0 ? { memories: result.memories } : {})
    }
  }
  if (result.kind === 'insufficient') {
    return {
      ...base,
      kind: 'insufficient',
      answer: result.answer,
      citations: result.citations,
      ...(result.memories && result.memories.length > 0 ? { memories: result.memories } : {}),
      ...(result.related.length > 0 ? { related: result.related } : {})
    }
  }
  if (result.kind === 'clarify') {
    return {
      ...base,
      kind: 'clarify',
      citations: [],
      clarify: { question: result.question, options: result.options }
    }
  }
  if (result.kind === 'continue-ask') {
    // 正常路径不会记这一条（暂停轮不落历史，等用户决定后只记最终结果）；
    // 真被记下来时按「向你确认」存，至少问题和候选不丢。
    return {
      ...base,
      kind: 'clarify',
      citations: [],
      clarify: { question: result.question, options: result.options }
    }
  }
  if (result.kind === 'command') {
    // 命令回执正常不进历史（主进程直接返回，不过 settle）；真被记下来时按一条普通答复存，
    // 至少内容不丢，也不会在历史类型里多出一个只读的分支。
    return {
      ...base,
      kind: 'answer',
      answer: result.text,
      citations: []
    }
  }
  if (result.kind === 'error') {
    return {
      ...base,
      kind: 'error',
      citations: [],
      reason: result.reason,
      message: result.message
    }
  }
  return {
    ...base,
    kind: 'no-evidence',
    citations: result.citations ?? [],
    ...(result.memories && result.memories.length > 0 ? { memories: result.memories } : {}),
    ...(result.note ? { note: result.note } : {}),
    ...(result.related && result.related.length > 0 ? { related: result.related } : {})
  }
}
