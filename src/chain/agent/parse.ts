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
  type ChainAskCitation
} from './types'

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
  | { ok: true; kind: 'answer'; answer: string; citations: ChainAskCitation[] }
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

  const raw = json.citations
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

  if (citations.length === 0) {
    // 「关于对话本身」的答案（你刚才问过什么）没有屏幕段可引：模型显式标 conversation:true
    // 且循环层确认有对话上下文时才放行，其余仍按「引用全被剥空」处理。
    if (options.allowConversationAnswer === true && json.conversation === true) {
      return { ok: true, kind: 'answer', answer: truncate(text, ANSWER_MAX_CHARS), citations: [] }
    }
    return { ok: false, reason: 'no-citations', message: '引用全被剥空' }
  }
  return { ok: true, kind: 'answer', answer: truncate(text, ANSWER_MAX_CHARS), citations }
}

/**
 * 归一判定（根因 7）：模型嘴上说「没找到」却塞了引用——按「没找到」处理。
 * 不加裸段号正则剥离（靠提示纪律），只认这句固定文案的开头。
 */
export function isNoEvidenceAnswer(answer: string): boolean {
  return answer.trim().startsWith(NO_EVIDENCE_TEXT)
}
