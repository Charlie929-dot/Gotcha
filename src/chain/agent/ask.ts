/**
 * 信息链 · 问记忆（S1 代理核心）
 *
 * 一次提问 = 一次回答 + 它引用的窗口段（`docs/chain-agent-plan.md` §4，P7 不做逐步解说）。
 *
 * 现在有两条出云路径，由客户端能力决定：
 *
 * 1. **工具循环（主路径，`loop.ts`）**：客户端带 `completeAskLoop` 时走。
 *    模型自己拆关键词、换算时间戳、多轮调 `search_info` / `get_freshness` /
 *    `ask_history`，最后给与单发同形的 `{answer, citations}`。
 * 2. **单发回退（本文件的 `askOnce`）**：客户端只有 `completeAsk` 时保留老管道——
 *    整句 + 向量检索一次、证据拼装一次、问一次。留作回退，不是死代码。
 *
 * 两条路径共用的门口（在 `askChain` 一次判定，循环内不再重复）：
 * 空问题 / 出云门（consent）/ 日预算（budget）/ 客户端解析。
 *
 * 这一层不抛异常给调用方：出云门、客户端、解析失败都变成结构化的 `error`，
 * 因为「问不到」是正常结果，不该把 UI 带崩。
 */
import {
  searchChainSegments,
  type ChainHit,
  type ChainSearchBatchQuery,
  type ChainSearchBatchResult
} from '../query'
import { getSegmentDetail, type ChainDb } from '../store'
import type { LlmClient, LlmUsage } from '../../understand/cloud/llm-client'
import type {
  AskLifeState,
  AskOutbound,
  AskRecentSegment,
  RedactableAskOpening,
  RedactableChainAskEvidence
} from './payload'
import { isNoEvidenceAnswer, parseChainReply, type CitationMeta } from './parse'
import { resolveLoopClient, runAskLoop, type AskLoopResumeState, type AskUsageMeta } from './loop'
import type { AskConversationPort } from './conversation'
import type { AskHistorySummary, DiaryToolDeps, GiveBirthResult, LetterToolDeps } from './tools'
import {
  EVIDENCE_TEXT_CHARS,
  type ChainAskRelatedSegment,
  type ChainAskResult,
  type ChainAskResumeDecision,
  type ChainAskStats,
  type ChainAskTurnContext
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
  /**
   * 出云载荷组装（安全边界的唯一注入点）。
   * - 远端供应商：`createCloudAskOutbound()`（脱敏墙生效）；
   * - 本机模型 / 测试：`createLocalAskOutbound()`（直通，不被安全规则卡住）。
   * 核心不再 import 脱敏实现，安全规则坏掉不影响检索与循环本身。
   */
  outbound: AskOutbound
  /** 问题向量（bge 会话）；没接或算不出来就只走关键词 */
  embedQuestion?: (question: string) => Promise<Float32Array | null> | Float32Array | null
  /** 出云门（D24 一次性确认）；默认放行。返回 false 就整次不出云 */
  canSend?: () => boolean
  /** 当日 token 预算用完了（D22）：返回 true 就整次不出云，理由报 `budget` */
  overBudget?: () => boolean
  /**
   * 记账：问一次记一次（循环路径整次结束发一次累计值）。
   * `meta.images` = 这次请求实际送出去几张图（生命记账要用它扣掉「一次性」的部分，D88）。
   */
  onUsage?: (usage: LlmUsage, meta: AskUsageMeta) => void
  /** 检索条数上限（契约 §4 取 5~10，默认 8；单发路径用，循环的 limit 由模型自己给） */
  limit?: number
  /** 每段证据的正文字符上限（默认 500；单发路径用） */
  textChars?: number
  /**
   * 关键词批量检索的执行体（主进程注入 worker 版；性能方案 §5.11）。不传 = 进程内同步查。
   * 只影响工具循环里的 `search_info`：单发路径本来只查一次、也没人同时用球。
   */
  searchBatch?: (query: ChainSearchBatchQuery) => Promise<ChainSearchBatchResult>
  /** 循环用：当前时间（默认 `Date.now`；测试注入固定钟） */
  now?: () => number
  /** 循环用：采集是否在跑（freshness 的 captureRunning） */
  captureRunning?: () => boolean
  /** 循环用：最近问答记录（ask_history 工具的数据源；默认只查本会话，`all` 才跨会话） */
  readAskHistory?: (scope: 'conversation' | 'all') => readonly AskHistorySummary[]
  /** 日记记忆（第二本账）：不传 = 没接入，三个记忆工具会如实报错 */
  diary?: DiaryToolDeps
  /**
   * 生女儿（D81）：生命 ≤15% 且模式带工具时才由组合根注入；
   * 不传 = 模型调 `give_birth` 会回「现在还不能传承」。
   */
  giveBirth?: (nickname: string) => Promise<GiveBirthResult>
  /** 信（D81）：写 / 列 / 读；不传 = 这个分支没挂写信工具 */
  letters?: LetterToolDeps
  /** 未读信数（D81）：只进 `<now>` 的一行 */
  unreadLetters?: number
  /** 母亲留下的信（`<mom_letter>`，M4）：只有女儿代才有 */
  momLetter?: string
  /**
   * read_segment 的截图读取（主进程注入）。**没开「历史截图出云」时不要传**：
   * 不传 = 读段只回 UIA 文字，截图不出云。
   */
  readShot?: (path: string) => string | null
  /**
   * 用户随本轮问题上传的图片（data URL）与文本文件（已截断）。
   * 与选区截图同口径：用户主动提供，不过脱敏墙；出云门照旧在门口判定。
   */
  attachments?: {
    readonly images?: readonly string[]
    readonly files?: readonly { readonly name: string; readonly text: string }[]
  }
  /** 人设提示（本地配置，拼在 system 最前面；不传 = 默认回忆助手口吻） */
  personaPrompt?: string
  /**
   * 这次问答给哪些工具（元素名，D72）：来自当前分支的 `/tool` 配置。
   * 不传 / 空表 = 纯模型：循环只发一次请求、不带 tools（提问 / 纯聊天）。
   */
  tools?: readonly string[]
  /**
   * 开场注入：「此刻」事实每轮刷新（由调用方现算），「想到的」日记片段只在
   * 新对话第一问出现；续查时片段从检查点沿用。没传 = 这个客户端不看这些。
   */
  opening?: RedactableAskOpening
  /** 当前节点的生命（M3）：每轮现算，进 `<now>` 的一行事实 */
  life?: AskLifeState
  /** 同一会话之前的几轮（续问）；不传 = 新对话 */
  history?: readonly ChainAskTurnContext[]
  /**
   * 提问前最后一段证据（应用 / 标题 / 时刻）：只当「这个界面 / 刚才那个」的指代线索，
   * 让新会话也能把指代词落到具体的应用上；不是证据，引用仍要经检索。
   */
  recent?: AskRecentSegment
  /**
   * 恢复上一次被暂停的循环（`continue-ask`）：
   * `continue` = 再给一轮工具预算继续查；`stop` = 按现有结果收尾。
   * 检查点在主进程内存里，带过期时间；窗口重开 / 超时后失效。
   */
  resume?: { id: string; decision: ChainAskResumeDecision }
  /** 用户点「停止」时中止在途请求 */
  signal?: AbortSignal
  /**
   * 会话存储（D64，只追加）：主进程按 conversationId 注入。
   * 不传 = 老行为（把 history 塞进 system，工具轮不参与下一次前缀）。
   */
  conversation?: AskConversationPort
  /**
   * 选区问答：随本轮问题一起给模型看的截图（data URL）。
   * 图是用户在界面上自己框的，不进脱敏（拍板 2026-10-28）；出云门照旧在门口判定。
   */
  imageDataUrl?: string
  log?: ChainAskLog
}

const DEFAULT_LIMIT = 8
const MIN_LIMIT = 1
const MAX_LIMIT = 20

function emptyStats(): ChainAskStats {
  return { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
}

/* ------------------------------------------------------------------ */
/* 续查检查点（只在主进程内存里；不落盘、不过 IPC）                      */
/* ------------------------------------------------------------------ */

/** 检查点有效期：10 分钟内没点「继续 / 收尾」就作废（窗口重开也拿不到） */
export const ASK_RESUME_TTL_MS = 10 * 60_000
/** 同时最多留几个检查点：正常一次只有一个，多开窗口也不会无限攒 */
const ASK_RESUME_MAX = 8

interface PendingAskLoop {
  question: string
  state: AskLoopResumeState
  /** 第一问的「此刻 / 想到的」：恢复后 system 不能凭空变少一段（2026-10-29 D61） */
  opening?: RedactableAskOpening
  at: number
}

const pendingAskLoops = new Map<string, PendingAskLoop>()

function newResumeId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function rememberPendingAskLoop(
  id: string,
  question: string,
  state: AskLoopResumeState,
  now: number,
  opening?: RedactableAskOpening
): void {
  for (const [key, entry] of pendingAskLoops) {
    if (now - entry.at > ASK_RESUME_TTL_MS) pendingAskLoops.delete(key)
  }
  while (pendingAskLoops.size >= ASK_RESUME_MAX) {
    const oldest = pendingAskLoops.keys().next().value
    if (oldest === undefined) break
    pendingAskLoops.delete(oldest)
  }
  pendingAskLoops.set(id, {
    question,
    state,
    ...(opening !== undefined ? { opening } : {}),
    at: now
  })
}

/** 测试用：清掉未消费的检查点，避免跨用例串状态 */
export function clearPendingAskLoops(): void {
  pendingAskLoops.clear()
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
 * 问一次记忆。门口共用的判定在这里做一次；之后按客户端能力分流：
 * 带 `completeAskLoop` → 工具循环；只有 `completeAsk` → 单发回退；都没有 → `client` 错误。
 *
 * @param question 用户原话（空白会被拒）
 */
export async function askChain(options: ChainAskOptions, question: string): Promise<ChainAskResult> {
  const stats = emptyStats()
  // 续查：问题用检查点里的原话（续查通道不再传问题，避免渲染层改词后两轮问题对不上）
  const pending = options.resume ? pendingAskLoops.get(options.resume.id) : undefined
  if (options.resume && !pending) {
    return {
      kind: 'error',
      reason: 'failed',
      message: '这次追问的上下文已经过期（窗口重开或等太久），重新问一遍就好',
      stats
    }
  }
  const asked = (pending?.question ?? question).trim()
  stats.questionChars = asked.length
  if (asked === '') {
    return { kind: 'error', reason: 'empty-question', message: '问题是空的', stats }
  }

  const log = options.log ?? (() => {})

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

  // 主路径：工具循环（模型自己检索，修七个召回根因里的前五个）
  const loopClient = resolveLoopClient(resolved)
  if (loopClient) {
    // 检查点一次性：同一份状态不能被恢复两次（否则两个窗口各跑一遍、各记一次账）
    if (pending && options.resume) pendingAskLoops.delete(options.resume.id)

    const paused: { state?: AskLoopResumeState } = {}
    const result = await runAskLoop(
      {
        db: options.db,
        client: loopClient,
        outbound: options.outbound,
        ...(options.embedQuestion ? { embedQuestion: options.embedQuestion } : {}),
        now: options.now ?? (() => Date.now()),
        captureRunning: options.captureRunning ?? (() => false),
        ...(options.readAskHistory ? { readAskHistory: options.readAskHistory } : {}),
        ...(options.diary ? { diary: options.diary } : {}),
        ...(options.giveBirth ? { giveBirth: options.giveBirth } : {}),
        ...(options.letters ? { letters: options.letters } : {}),
        ...(options.unreadLetters !== undefined ? { unreadLetters: options.unreadLetters } : {}),
        ...(options.momLetter ? { momLetter: options.momLetter } : {}),
        ...(options.readShot ? { readShot: options.readShot } : {}),
        ...(options.personaPrompt ? { personaPrompt: options.personaPrompt } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        // 开场注入：「此刻」每轮用调用方给的新值（时间会走）；第一问「想到的」从检查点续上，
        // 续查不重新联想（同一条记忆不该每轮换说法）
        ...((): { opening?: RedactableAskOpening } => {
          const remembered = pending?.opening?.remembered
          const opening: RedactableAskOpening | undefined =
            options.opening !== undefined
              ? {
                  ...options.opening,
                  ...(remembered !== undefined && remembered.length > 0 ? { remembered } : {})
                }
              : pending?.opening
          return opening !== undefined ? { opening } : {}
        })(),
        ...(options.life !== undefined ? { life: options.life } : {}),
        ...(options.searchBatch ? { searchBatch: options.searchBatch } : {}),
        ...(options.history ? { history: options.history } : {}),
        ...(options.recent ? { recent: options.recent } : {}),
        ...(pending ? { resume: pending.state } : {}),
        ...(options.resume ? { resumeDecision: options.resume.decision } : {}),
        // 轮数用尽时把状态交回来，由界面问用户「还要继续吗」
        onPause: (state) => {
          paused.state = state
        },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.imageDataUrl ? { image: { dataUrl: options.imageDataUrl } } : {}),
        ...(options.attachments ? { attachments: options.attachments } : {}),
        ...(options.conversation ? { conversation: options.conversation } : {}),
        ...(options.onUsage ? { onUsage: options.onUsage } : {}),
        log
      },
      asked
    )

    if (result.kind === 'continue-ask') {
      if (!paused.state) {
        // onPause 已经接上，正常不会走到这里；真走到也不把内部状态漏给界面
        return { kind: 'no-evidence', stats: result.stats }
      }
      const id = newResumeId()
      rememberPendingAskLoop(id, asked, paused.state, Date.now(), options.opening)
      return { ...result, resumeId: id }
    }
    return result
  }

  // 回退：单发管道（客户端没有循环能力）
  const legacy = resolved.client
  const completeAsk = legacy.completeAsk?.bind(legacy)
  if (typeof completeAsk !== 'function') {
    return { kind: 'error', reason: 'client', message: '当前客户端不支持问记忆', stats }
  }
  return askOnce(options, { ...legacy, completeAsk }, asked, stats, log)
}

/* ------------------------------------------------------------------ */
/* 单发回退路径（老管道原样保留；客户端只有 completeAsk 时使用）          */
/* ------------------------------------------------------------------ */

async function askOnce(
  options: ChainAskOptions,
  client: LlmClient & Pick<Required<LlmClient>, 'completeAsk'>,
  asked: string,
  stats: ChainAskStats,
  log: ChainAskLog
): Promise<ChainAskResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, options.limit ?? DEFAULT_LIMIT))
  const textChars = Math.max(80, options.textChars ?? EVIDENCE_TEXT_CHARS)

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

  const built = options.outbound.buildAsk(asked, evidence, {
    textMaxChars: textChars,
    ...(options.attachments ? { attachments: options.attachments } : {})
  })
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
    result = await client.completeAsk(built.payload, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.imageDataUrl ? { image: { dataUrl: options.imageDataUrl } } : {})
    })
  } catch (error) {
    if (options.signal?.aborted) {
      return { kind: 'error', reason: 'aborted', message: '已停止', stats }
    }
    log('warn', 'chain ask: 模型调用失败', { error: String(error) })
    return { kind: 'error', reason: 'failed', message: String(error), stats }
  }
  if (result.usage) {
    // 单发路径不带工具轮，图只有选区截图那一张（D88 的生命记账要看这个数）
    options.onUsage?.(result.usage, { images: options.imageDataUrl !== undefined ? 1 : 0 })
  }

  // 4. 解析（引用白名单 = 真正送出去的证据）
  const meta = new Map<number, CitationMeta>(
    built.payload.evidence.map((segment) => [
      segment.segmentId,
      { segmentId: segment.segmentId, at: segment.startTs, app: segment.app, title: segment.title }
    ])
  )
  const rawCitations = (result.json as { citations?: unknown } | null)?.citations
  stats.cited = Array.isArray(rawCitations) ? rawCitations.length : 0

  const parsed = parseChainReply(result.json, meta)
  if (!parsed.ok) {
    if (parsed.reason === 'no-citations') {
      return { kind: 'no-evidence', related: relatedFrom(meta), stats }
    }
    return { kind: 'error', reason: 'unparseable', message: parsed.message, stats }
  }
  if (parsed.kind === 'clarify') {
    return { kind: 'clarify', question: parsed.question, options: parsed.options, stats }
  }
  if (parsed.kind === 'insufficient') {
    return {
      kind: 'insufficient',
      answer: parsed.answer,
      citations: parsed.citations,
      related: relatedFrom(meta),
      stats
    }
  }
  if (isNoEvidenceAnswer(parsed.answer) && parsed.citations.length > 0) {
    // 根因 7 的归一在两条路径上一致：按「没找到」收口，但保留说明与引用（别让用户只看到空白）
    log('warn', 'chain ask: answer 声称没找到但 citations 非空，按没找到保留说明', {
      cited: parsed.citations.length
    })
    return {
      kind: 'no-evidence',
      note: parsed.answer,
      citations: parsed.citations,
      related: relatedFrom(meta),
      stats
    }
  }

  return { kind: 'answer', answer: parsed.answer, citations: parsed.citations, stats }
}

/** 检索到、但没进引用的段（最多 5 条，按证据顺序）——单发路径与循环口径一致 */
function relatedFrom(meta: ReadonlyMap<number, CitationMeta>): ChainAskRelatedSegment[] {
  return [...meta.values()].slice(0, 5).map((item) => ({
    segmentId: item.segmentId,
    at: item.at,
    app: item.app,
    title: item.title
  }))
}
