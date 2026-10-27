/**
 * 信息链 · 问记忆（S1 代理核心）
 *
 * 一次提问 = 一次回答 + 它引用的窗口段（`docs/chain-agent-plan.md` §4，P7 不做逐步解说）：
 *
 * 1. 检索：问题全文进 `text`（`despaceSearchText` 口径）+ 问题向量，双路 RRF（`query.ts`）；
 * 2. 证据：命中段 → `getSegmentDetail()` → 起止时间 / 应用 / 标题 / 命中原文 / 标签 / 双链；
 * 3. 出云：`buildChainAskPayload()`（脱敏 + 上限）→ `LlmClient.completeAsk()`；
 * 4. 解析：`parseChainAnswer()`（引用白名单硬剥，编造的整条丢）；
 * 5. 拒答：没命中 / 引用全被剥空 → `no-evidence`，**不调 LLM 编话**。
 *
 * 这一层不抛异常给调用方：出云门、客户端、解析失败都变成结构化的 `error`，
 * 因为「问不到」是正常结果，不该把 UI 带崩。
 */
import { searchChainSegments, type ChainHit } from '../query'
import { getSegmentDetail, type ChainDb } from '../store'
import type { LlmClient, LlmUsage } from '../../understand/cloud/llm-client'
import { buildChainAskPayload, type RedactableChainAskEvidence } from '../../understand/cloud/redact'
import { parseChainAnswer, type CitationMeta } from './parse'
import {
  EVIDENCE_TEXT_CHARS,
  type ChainAskResult,
  type ChainAskStats
} from './types'

/** 客户端解析结果（与 `main/index.ts` 的 `resolveClient()` 同形，便于直接接） */
export interface ChainAskClientResolution {
  ok: boolean
  client?: LlmClient
  /** missing-key / invalid-providers / unknown-provider / invalid-config */
  reason?: string
}

export type ChainAskLog = (
  level: 'info' | 'warn',
  message: string,
  data?: Record<string, unknown>
) => void

export interface ChainAskOptions {
  db: ChainDb
  resolveClient: () => ChainAskClientResolution
  /** 问题向量（bge 会话）；没接或算不出来就只走关键词 */
  embedQuestion?: (question: string) => Promise<Float32Array | null> | Float32Array | null
  /** 出云门（D24 一次性确认）；默认放行。返回 false 就整次不出云 */
  canSend?: () => boolean
  /** 当日 token 预算用完了（D22）：返回 true 就整次不出云，理由报 `budget` */
  overBudget?: () => boolean
  /** 记账：问一次记一次（复用 `induction.recordUsage`） */
  onUsage?: (usage: LlmUsage) => void
  /** 检索条数上限（契约 §4 取 5~10，默认 8） */
  limit?: number
  /** 每段证据的正文字符上限（默认 500） */
  textChars?: number
  log?: ChainAskLog
}

const DEFAULT_LIMIT = 8
const MIN_LIMIT = 1
const MAX_LIMIT = 20

function emptyStats(): ChainAskStats {
  return { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
}

/** 段里选哪段正文当证据：优先模型实际命中的那条内容，其次最长的一条 */
function pickEvidenceText(
  db: ChainDb,
  hit: ChainHit,
  textChars: number
): { text: string; truncated: boolean } {
  const detail = getSegmentDetail(db, hit.segment.id)
  const contents = detail?.contents ?? []
  const matched = contents.find((row) => hit.contentIds.includes(row.id))
  const longest = contents.reduce<typeof contents[number] | null>(
    (best, row) => (best === null || row.text.length > best.text.length ? row : best),
    null
  )
  const source = matched?.text ?? longest?.text ?? hit.snippet ?? ''
  const text = source.trim()
  return { text: text.slice(0, textChars), truncated: text.length > textChars }
}

function titleOf(hit: ChainHit): string {
  return hit.segment.title_last ?? hit.segment.title_first ?? ''
}

/**
 * 问一次记忆。
 *
 * @param question 用户原话（空白会被拒）
 */
export async function askChain(options: ChainAskOptions, question: string): Promise<ChainAskResult> {
  const stats = emptyStats()
  const asked = question.trim()
  stats.questionChars = asked.length
  if (asked === '') {
    return { kind: 'error', reason: 'empty-question', message: '问题是空的', stats }
  }

  const log = options.log ?? (() => {})
  const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, options.limit ?? DEFAULT_LIMIT))
  const textChars = Math.max(80, options.textChars ?? EVIDENCE_TEXT_CHARS)

  if (options.canSend && !options.canSend()) {
    return { kind: 'error', reason: 'consent', message: '还没确认出云，先不提问', stats }
  }
  if (options.overBudget && options.overBudget()) {
    return { kind: 'error', reason: 'budget', message: '今天的模型额度用完了', stats }
  }

  const resolved = options.resolveClient()
  if (!resolved.ok || !resolved.client) {
    return {
      kind: 'error',
      reason: 'client',
      message: `没有可用的模型客户端（${resolved.reason ?? 'unknown'}）`,
      stats
    }
  }
  const client = resolved.client
  if (typeof client.completeAsk !== 'function') {
    return { kind: 'error', reason: 'client', message: '当前客户端不支持问记忆', stats }
  }

  // 1. 检索：向量算不出来就只走关键词，不因此失败
  let vector: Float32Array | null = null
  if (options.embedQuestion) {
    try {
      vector = (await options.embedQuestion(asked)) ?? null
    } catch (error) {
      log('warn', 'chain ask: 问题向量计算失败，退回关键词检索', { error: String(error) })
      vector = null
    }
  }

  const found = searchChainSegments(options.db, {
    text: asked,
    ...(vector ? { vector } : {}),
    limit
  })
  stats.hits = found.hits.length
  if (found.hits.length === 0) {
    return { kind: 'no-evidence', stats }
  }

  // 2. 证据（送云前还要过脱敏）
  const evidence: RedactableChainAskEvidence[] = found.hits.map((hit) => {
    const picked = pickEvidenceText(options.db, hit, textChars)
    return {
      segmentId: hit.segment.id,
      app: hit.segment.app ?? '',
      title: titleOf(hit),
      startTs: hit.segment.start_ts,
      endTs: hit.segment.end_ts,
      text: picked.text,
      truncated: picked.truncated,
      tags: hit.tags,
      links: hit.links
    }
  })

  const built = buildChainAskPayload(asked, evidence, { textMaxChars: textChars })
  if (built.questionBlocked) {
    return { kind: 'error', reason: 'question-blocked', message: '问题里含敏感内容，未出云', stats }
  }
  stats.evidence = built.payload.evidence.length
  if (built.payload.evidence.length === 0) {
    return { kind: 'no-evidence', stats }
  }

  // 3. 出云
  let result
  try {
    result = await client.completeAsk(built.payload)
  } catch (error) {
    log('warn', 'chain ask: 模型调用失败', { error: String(error) })
    return { kind: 'error', reason: 'failed', message: String(error), stats }
  }
  if (result.usage) options.onUsage?.(result.usage)

  // 4. 解析（引用白名单 = 真正送出去的证据）
  const meta = new Map<number, CitationMeta>(
    built.payload.evidence.map((segment) => [
      segment.segmentId,
      { segmentId: segment.segmentId, at: segment.startTs, app: segment.app, title: segment.title }
    ])
  )
  const rawCitations = (result.json as { citations?: unknown } | null)?.citations
  stats.cited = Array.isArray(rawCitations) ? rawCitations.length : 0

  const parsed = parseChainAnswer(result.json, meta)
  if (!parsed.ok) {
    if (parsed.reason === 'no-citations') return { kind: 'no-evidence', stats }
    return { kind: 'error', reason: 'unparseable', message: parsed.message, stats }
  }

  return { kind: 'answer', answer: parsed.answer, citations: parsed.citations, stats }
}
