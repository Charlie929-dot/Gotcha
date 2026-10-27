/**
 * 信息链 · 问记忆的答复解析（照抄派生层 `derive/parse.ts` 的纪律）
 *
 * 纪律：**只信字段与上限**。结构不对整次失败，不当空结果；
 * 引用 id 必须落在本次检索命中的集合里，编造 / 重复的整条丢弃；
 * 剥完一条不剩，按「没找到证据」处理（契约 §4）。
 */
import {
  ANSWER_MAX_CHARS,
  MAX_CITATIONS,
  type ChainAskCitation
} from './types'

/** 引用时要从命中段行补的事实 */
export interface CitationMeta {
  segmentId: number
  at: number
  app: string
  title: string
}

export type ParseChainAnswerResult =
  | { ok: true; answer: string; citations: ChainAskCitation[] }
  | { ok: false; reason: 'shape' | 'no-citations'; message: string }

const WHY_MAX_CHARS = 200

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param json   模型返回的 JSON（已 parse）
 * @param meta   本次检索命中的段（**白名单**：不在这里的 id 一律丢弃）
 */
export function parseChainAnswer(
  json: unknown,
  meta: ReadonlyMap<number, CitationMeta>
): ParseChainAnswerResult {
  if (!isRecord(json)) return { ok: false, reason: 'shape', message: '答复不是对象' }

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
    return { ok: false, reason: 'no-citations', message: '引用全被剥空' }
  }
  return { ok: true, answer: truncate(text, ANSWER_MAX_CHARS), citations }
}
