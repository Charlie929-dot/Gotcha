/**
 * 信息链 · 问记忆的答复解析（照抄派生层 `derive/parse.ts` 的纪律）
 *
 * 纪律：**只信字段与上限**。结构不对整次失败，不当空结果；
 * 引用 id 必须落在本次检索命中的集合里，编造 / 重复的整条丢弃；
 * 剥完一条不剩，按「没找到证据」处理（契约 §4）。
 *
 * 2026-10-27 起支持第二种收尾形状：模型可以在证据撑不起答案 / 缺关键信息时
 * 输出 `{"ask":"...","options":[...]}` 先向用户确认——这只是「再问一句」，
 * 不是失败；确认内容同样受字段校验与长度上限约束。
 */
import {
  ANSWER_MAX_CHARS,
  CLARIFY_OPTION_MAX_CHARS,
  CLARIFY_QUESTION_MAX_CHARS,
  MAX_CITATIONS,
  MAX_CLARIFY_OPTIONS,
  NO_EVIDENCE_TEXT,
  type ChainAskCitation,
  type ChainAskMemoryCitation
} from './types'
import type { MemoryCitationMeta } from './tools'

/** 引用时要从命中段行补的事实 */
export interface CitationMeta {
  segmentId: number
  at: number
  app: string
  title: string
  /** 建议的 read_segment 起点（命中处）；解析引用本身不用，驱动层传给执行器做默认 offset */
  readOffset?: number
}

export type ParseChainReplyResult =
  | {
      ok: true
      kind: 'answer'
      answer: string
      citations: ChainAskCitation[]
      memories: ChainAskMemoryCitation[]
    }
  /**
   * 查到了相关段、但撑不起结论：说明留下，引用 0–3 条（不当结论）。
   * 2026-10-29：以前 citations 为空就把整段说明丢掉、界面只剩固定文案，
   * 拍板人明确要求「命中很多却一句话都不说」不能再出现。
   */
  | {
      ok: true
      kind: 'insufficient'
      answer: string
      citations: ChainAskCitation[]
      memories: ChainAskMemoryCitation[]
    }
  | { ok: true; kind: 'clarify'; question: string; options: string[] }
  | { ok: false; reason: 'shape' | 'no-citations'; message: string }

/** 解析选项（只在「关于对话本身」的答案上放开无引用，见下） */
export interface ParseChainReplyOptions {
  /**
   * 允许 `{"answer":"...","citations":[],"conversation":true}`：
   * 回答的是「你刚才问了什么」这类对话本身，没有屏幕段可引，不该按「没找到」处理。
   * 由循环层按「本会话有上文 / 真的查过 ask_history」决定是否放开。
   */
  allowConversationAnswer?: boolean
  /**
   * 日记引用白名单（recall_diary / read_diary 给过的条目）。
   * 不传 = 这一轮没有日记记忆可用，模型给的 memories 一律剥掉。
   */
  memoryMeta?: ReadonlyMap<number, MemoryCitationMeta>
}

const WHY_MAX_CHARS = 200

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 候选去空、去重、限量；模型给的脏东西不该把整次澄清拖成失败 */
function parseOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const options: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = truncate(item.trim(), CLARIFY_OPTION_MAX_CHARS)
    if (text === '' || options.includes(text)) continue
    options.push(text)
    if (options.length >= MAX_CLARIFY_OPTIONS) break
  }
  return options
}

/**
 * @param json   模型返回的 JSON（已 parse）
 * @param meta   本次检索命中的段（**白名单**：不在这里的 id 一律丢弃）
 */
export function parseChainReply(
  json: unknown,
  meta: ReadonlyMap<number, CitationMeta>,
  options: ParseChainReplyOptions = {}
): ParseChainReplyResult {
  if (!isRecord(json)) return { ok: false, reason: 'shape', message: '答复不是对象' }

  // 先看是否选择「先问一句」：只要 ask 是非空字符串就按澄清处理
  if (typeof json.ask === 'string') {
    const question = truncate(json.ask.trim(), CLARIFY_QUESTION_MAX_CHARS)
    if (question !== '') {
      return { ok: true, kind: 'clarify', question, options: parseOptions(json.options) }
    }
  }

  const answer = json.answer
  if (typeof answer !== 'string') {
    return { ok: false, reason: 'shape', message: 'answer 缺失或不是字符串' }
  }
  const text = answer.trim()
  if (text === '') return { ok: false, reason: 'shape', message: 'answer 为空' }

  const memories = parseMemoryCitations(json.memories, options.memoryMeta)
  // `citations` 可以省：只靠日记回答时模型偶尔漏掉这个键（实测 2026-10-29「我最近在想什么」
  // 答得不成形，日志是「citations 不是数组」）。缺字段按空数组，非数组仍算结构不对。
  const raw = json.citations === undefined ? [] : json.citations
  if (!Array.isArray(raw)) return { ok: false, reason: 'shape', message: 'citations 不是数组' }

  const seen = new Set<number>()
  const citations: ChainAskCitation[] = []
  for (const item of raw) {
    if (citations.length >= MAX_CITATIONS) break
    if (!isRecord(item)) continue // 坏条目单条丢弃，不连坐整次
    const id = item.segmentId
    if (typeof id !== 'number' || !Number.isInteger(id)) continue
    const known = meta.get(id)
    if (!known || seen.has(id)) continue // 编造 / 重复 → 丢
    seen.add(id)
    const why = typeof item.why === 'string' ? truncate(item.why.trim(), WHY_MAX_CHARS) : ''
    citations.push({ segmentId: id, at: known.at, app: known.app, title: known.title, why })
  }

  const hasAnyCitation = citations.length > 0 || memories.length > 0
  if (!hasAnyCitation) {
    // 「关于对话本身」的答案（你刚才问过什么）没有屏幕段可引：模型显式标 conversation:true
    // 且循环层确认有对话上下文时才放行，其余仍按「引用全被剥空」处理。
    if (options.allowConversationAnswer === true && json.conversation === true) {
      return { ok: true, kind: 'answer', answer: truncate(text, ANSWER_MAX_CHARS), citations: [], memories: [] }
    }
    // 只剩一句固定文案、什么也没说：维持「没找到」，UI 用固定文案（证据即沉默）。
    if (isBareNoEvidence(text)) {
      return { ok: false, reason: 'no-citations', message: '引用全被剥空' }
    }
    // 给了引用却全被白名单剥掉 = 编造 / 指错段：仍按「没找到」收口，不把无依据的正文放出来。
    // 只有「一条引用都没给」、且本轮**确实检索到了段**时，才把说明当成「查到了但不够」——
    // 说明不是结论，UI 会标成「相关但不足」，并列出检索到的段。
    if (raw.length === 0 && meta.size > 0) {
      return { ok: true, kind: 'insufficient', answer: truncate(text, ANSWER_MAX_CHARS), citations: [], memories: [] }
    }
    return { ok: false, reason: 'no-citations', message: '引用全被剥空' }
  }
  if (json.insufficient === true) {
    return {
      ok: true,
      kind: 'insufficient',
      answer: truncate(text, ANSWER_MAX_CHARS),
      citations,
      memories
    }
  }
  return { ok: true, kind: 'answer', answer: truncate(text, ANSWER_MAX_CHARS), citations, memories }
}

/** 一次答复最多几条日记引用（和屏幕引用一样，只留真正支撑结论的） */
const MAX_MEMORIES = 4
/** 日记引用里原文片段的上限 */
const MEMORY_QUOTE_MAX_CHARS = 160

/**
 * 日记引用：`memories:[{itemId,why}]`。itemId 必须落在本轮 recall_diary / read_diary
 * 给过的条目里（白名单），编造 / 重复 / 没接日记库时整条丢弃。
 */
function parseMemoryCitations(
  raw: unknown,
  meta: ReadonlyMap<number, MemoryCitationMeta> | undefined
): ChainAskMemoryCitation[] {
  if (!Array.isArray(raw) || meta === undefined) return []
  const out: ChainAskMemoryCitation[] = []
  const seen = new Set<number>()
  for (const item of raw) {
    if (out.length >= MAX_MEMORIES) break
    if (!isRecord(item)) continue
    const id = item.itemId
    if (typeof id !== 'number' || !Number.isInteger(id)) continue
    const known = meta.get(id)
    if (!known || seen.has(id)) continue
    seen.add(id)
    const why = typeof item.why === 'string' ? truncate(item.why.trim(), WHY_MAX_CHARS) : ''
    out.push({
      itemId: id,
      day: known.day,
      section: known.section,
      why,
      snippet: truncate(known.text.replace(/\s+/gu, ' ').trim(), MEMORY_QUOTE_MAX_CHARS)
    })
  }
  return out
}

/** 是否只有一句「信息链里没找到」（允许句末标点），没有任何补充说明 */
function isBareNoEvidence(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith(NO_EVIDENCE_TEXT)) return false
  const rest = trimmed.slice(NO_EVIDENCE_TEXT.length).replace(/[。.!！\s]+$/u, '').trim()
  return rest === ''
}

/**
 * 归一判定（根因 7）：模型嘴上说「没找到」却塞了引用——按「没找到」处理。
 * 不加裸段号正则剥离（靠提示纪律），只认这句固定文案的开头。
 */
export function isNoEvidenceAnswer(answer: string): boolean {
  return answer.trim().startsWith(NO_EVIDENCE_TEXT)
}
