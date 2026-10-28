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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChainAskCitation, ChainAskResult, ChainAskStats } from '../chain/agent/types'

export const ASK_HISTORY_FILE = 'ask-history.jsonl'

export interface AskHistoryEntry {
  /** 渲染层列表 key（时刻 + 随机后缀） */
  id: string
  /** 所属会话（同一会话的多轮追问共用；老记录没有这个字段 = 单条会话） */
  conversationId?: string
  /** 提问时刻（毫秒） */
  at: number
  question: string
  kind: 'answer' | 'no-evidence' | 'error' | 'clarify'
  answer?: string
  citations: ChainAskCitation[]
  /** `kind=no-evidence` 时模型给的补充说明（查到了什么、为什么不足以回答）；没有就显示固定文案 */
  note?: string
  /** `kind=clarify`：模型反向向用户确认的问题 + 候选 */
  clarify?: { question: string; options: string[] }
  /** `kind=error` 时的结构化原因（`ChainAskErrorReason`） */
  reason?: string
  /** `kind=error` 时的可读消息 */
  message?: string
  stats: ChainAskStats
}

const KINDS = new Set<AskHistoryEntry['kind']>(['answer', 'no-evidence', 'error', 'clarify'])

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

function isClarify(value: unknown): value is { question: string; options: string[] } {
  if (typeof value !== 'object' || value === null) return false
  const clarify = value as Record<string, unknown>
  return (
    typeof clarify.question === 'string' &&
    clarify.question.trim() !== '' &&
    Array.isArray(clarify.options) &&
    clarify.options.every((option) => typeof option === 'string')
  )
}

/** 单行校验：坏行（旧格式 / 手改 / 写了一半）返回 null，读到就跳过、不整份作废 */
export function parseAskHistoryEntry(value: unknown): AskHistoryEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const data = value as Record<string, unknown>
  if (typeof data.id !== 'string' || data.id === '') return null
  if (typeof data.at !== 'number' || !Number.isFinite(data.at)) return null
  if (typeof data.question !== 'string') return null
  if (typeof data.kind !== 'string' || !KINDS.has(data.kind as AskHistoryEntry['kind'])) return null
  if (!Array.isArray(data.citations)) return null
  if (!data.citations.every(isCitation)) return null
  if (!isStats(data.stats)) return null
  if (data.kind === 'answer' && typeof data.answer !== 'string') return null
  if (data.answer !== undefined && typeof data.answer !== 'string') return null
  if (data.reason !== undefined && typeof data.reason !== 'string') return null
  if (data.message !== undefined && typeof data.message !== 'string') return null
  if (data.note !== undefined && typeof data.note !== 'string') return null
  if (data.conversationId !== undefined && (typeof data.conversationId !== 'string' || data.conversationId === '')) {
    return null
  }
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
    ...(typeof data.answer === 'string' ? { answer: data.answer } : {}),
    citations: data.citations,
    ...(isClarify(data.clarify) ? { clarify: data.clarify } : {}),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
    ...(typeof data.note === 'string' ? { note: data.note } : {}),
    stats: data.stats
  }
}

/** 读全部记录（**最新在前**）；文件不存在 / 读失败 / 坏行都按「没有」处理，不抛错、不建文件 */
export function readAskHistory(filePath: string): AskHistoryEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
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
  return entries.reverse()
}

export function appendAskHistory(filePath: string, entry: AskHistoryEntry): void {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

/** 清空 = 截断成空文件（保留文件本身，下一条继续追加） */
export function clearAskHistory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, '', 'utf8')
}

/** 把一次问答结果折成一条记录；id 只要在同一进程内唯一即可（时刻 + 随机后缀） */
export function toHistoryEntry(
  question: string,
  result: ChainAskResult,
  at: number,
  conversationId?: string
): AskHistoryEntry {
  const base = {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    at,
    question,
    stats: result.stats,
    ...(conversationId ? { conversationId } : {})
  }
  if (result.kind === 'answer') {
    return { ...base, kind: 'answer', answer: result.answer, citations: result.citations }
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
    ...(result.note ? { note: result.note } : {})
  }
}
