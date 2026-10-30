/**
 * 信息链 · 问记忆工具循环的驱动层（toolloop）
 *
 * 消息协议（D64）：system（固定人设 / 工具清单 / 规则）→ user（问题 + `<now>`）→
 * assistant tool_calls → tool 结果摘要 → … → 最终 assistant 自由文本。
 *
 * 上限（2026-10-30 调整）：**8 轮可以调工具、工具调用总数 ≤16**。
 * **不再有「第 9 轮强制收尾」**：模型不调工具的那一轮就是收尾；
 * 预算用尽时仍想调工具 → 先问用户（`continue-ask`），用户选收尾才发一轮不带 tools 的请求。
 * 这样所有正常请求的 messages / tools 前缀都一致，缓存不会因末轮指令失效。
 * 只有工具调用数超限、或客户端真的失败，才按 `failed` 收口。
 *
 * 2026-10-27 再调：加 `read_segment` 后模型需要多走一步「展开命中段看全文」，
 * 轮数 / 调用数放宽（模型不是笨，是之前只能看到 80 字摘要、又没有打开正文的工具）。
 *
 * 2026-10-27 续查：预算快用完、模型还想调工具时**不硬掐**——把状态交回
 * `onPause`（`ask.ts` 存成检查点），返回 `continue-ask` 让用户决定：
 * 继续 = 再给 8 轮 / 16 次（最多 3 次），收尾 = 下一轮不带 tools 直接作答。
 * 暂停前那一轮工具照常执行，用户点「继续」时结果还在，不用重查。
 *
 * 出口纪律（不可妥协）：
 * - 出云载荷由注入的 `AskOutbound` 组装（branded）；每个工具结果回填前由该端口
 *   统一处理，核心不调 `redactSensitive`（安全策略在边界，见 cloud-boundary.md）；
 * - consent / budget / 问题敏感在**循环开始前一次判定**（`askChain` 的门口 +
 *   首次构建载荷时验 questionBlocked）；
 * - 引用白名单 = search_info 返回过、且**没有被脱敏整条挡下**的段并集，
 *   编造 / 被挡的引用在 `parseChainAnswer` 里硬剥；
 * - 每轮 usage 累计、**结束时一次** `onUsage`（失败路径也记账，F03 口径）；
 * - 「answer 说没找到但 citations 非空」强转 no-evidence（根因 7）。
 */
import type {
  AskLifeState,
  AskLoopFreshness,
  AskOutbound,
  AskRecentSegment,
  ChainAskLoopPayload,
  RedactableAskLoopToolResult,
  RedactableAskLoopTurn,
  RedactableAskOpening
} from './payload'
import {
  appendAskConversationTurn,
  emptyAskConversation,
  type AskConversationPort
} from './conversation'
import {
  LlmAbortError,
  LlmHttpError,
  LlmParseError,
  type LlmClient,
  type LlmUsage
} from '../../understand/cloud/llm-client'
import type { ChainAskClientResolution, ChainAskLog } from './ask'
import { readChainFreshness } from './freshness'
import { isNoEvidenceAnswer, memorySnippet, parseChainReply, parseChainReplyText, type CitationMeta } from './parse'
import {
  type ChainAskCitation,
  type ChainAskMemoryCitation,
  type ChainAskResult,
  type ChainAskRelatedSegment,
  type ChainAskStats,
  type ChainAskTraceStep,
  type ChainAskTraceTool,
  type ChainAskTurnContext,
  MAX_CITATIONS
} from './types'
import {
  createAskToolExecutor,
  type AskHistorySummary,
  type ConceiveDaughterResult,
  type DiaryToolDeps,
  type MemoryCitationMeta
} from './tools'
import type { ChainDb } from '../store'
import type { ChainSearchBatchQuery, ChainSearchBatchResult } from '../query'

/** 允许模型调用工具的轮数上限（用户点一次「继续查」就再批这么多） */
export const ASK_LOOP_MAX_TOOL_TURNS = 8
/** assistant 调用总上限：8 轮工具 + 1 轮用户选择的收尾（不带 tools；正常流程不会自动走到） */
export const ASK_LOOP_MAX_TURNS = ASK_LOOP_MAX_TOOL_TURNS + 1
/** 工具调用总数上限（跨轮累计）：read_segment 让单轮内多开几段成为常态 */
export const ASK_LOOP_MAX_TOOL_CALLS = 16
/** 用户最多点几次「继续查」；每次 ±8 轮 / ±16 次调用，不点就不会多花 */
export const ASK_LOOP_MAX_GRANTS = 3

/** 暂停时交回给 `ask.ts` 的检查点（只在本进程内存里流转，不出 IPC、不落盘） */
export interface AskLoopResumeState {
  turns: readonly RedactableAskLoopTurn[]
  whitelist: ReadonlyMap<number, CitationMeta>
  toolCallCount: number
  hitsShown: number
  usedAskHistory: boolean
  /** 已经发生过的 assistant 轮数（含工具轮） */
  turnsUsed: number
  /** 已经批准过几次「继续查」 */
  grants: number
  /** 暂停时的统计（questionChars 等；最终出口会用当前值重算 turns / hits） */
  stats: ChainAskStats
  /** 暂停前已经发生的思考 / 工具步骤（恢复后继续累积） */
  steps: readonly ChainAskTraceStep[]
  /** 暂停前给模型看过的日记条目（恢复后 memories 引用仍要能过白名单） */
  memoryWhitelist?: ReadonlyMap<number, MemoryCitationMeta>
  /** 暂停前真正打开过的段（read_segment）：恢复后引用仍要自动带出 */
  readSegments?: ReadonlyMap<number, CitationMeta>
  /** 暂停前真正打开过的日记条目（read_diary）：恢复后引用仍要自动带出 */
  readMemories?: ReadonlyMap<number, MemoryCitationMeta>
  /** 暂停前已经传承过（M4）：恢复后仍不能把这一问写进女儿的分支 */
  conceived?: boolean
}

export interface AskLoopContext {
  db: ChainDb
  /** 已验过 `completeAskLoop` 存在的客户端 */
  client: LlmClient & Pick<Required<LlmClient>, 'completeAskLoop'>
  /** 出云载荷组装（组合根注入；核心不依赖具体脱敏实现） */
  outbound: AskOutbound
  /** 语义检索向量（bge 会话；没接就只走关键词） */
  embedQuestion?: (question: string) => Promise<Float32Array | null> | Float32Array | null
  /** 固定钟（测试注入） */
  now: () => number
  /** 采集是否在跑 */
  captureRunning: () => boolean
  /** 最近问答记录（ask_history 工具的数据源；默认只查本会话，`all` 才跨会话） */
  readAskHistory?: (scope: 'conversation' | 'all') => readonly AskHistorySummary[]
  /** 关键词批量检索的执行体（主进程注入 worker 版；不传 = 进程内同步查） */
  searchBatch?: (query: ChainSearchBatchQuery) => Promise<ChainSearchBatchResult>
  /** 日记记忆（第二本账）；不传 = 没有接入，三个记忆工具会如实报错 */
  diary?: DiaryToolDeps
  /**
   * 传承（M4）：只有在生命 ≤15% 且模式带工具时由组合根注入；
   * 不传 = 模型调 `conceive_daughter` 会回「现在还不能传承」。
   */
  conceive?: (nickname: string, letter?: string) => Promise<ConceiveDaughterResult>
  /** 母亲留下的信（`<mom_letter>`，M4）：只有女儿代才有；不传 = 不写这一段 */
  momLetter?: string
  /**
   * read_segment 的截图读取（主进程注入）。**没开「历史截图出云」时不要传**：
   * 核心拿不到图，读段就只回 UIA 文字。
   */
  readShot?: (path: string) => string | null
  /** 人设提示（本地配置，拼在 system 最前面；不传 = 用默认的回忆助手口吻） */
  personaPrompt?: string
  /**
   * 这次给哪些工具组（D62 模式）。不传 = 两组都开。
   * 两组都关 = 单轮请求：不跑工具预算、不带 tools、不产生收尾轮。
   */
  tools?: { screen: boolean; diary: boolean }
  /**
   * 开场注入：「此刻」事实（每轮现算）+ 第一问的「想到的」日记片段。
   * 由组合根给出；载荷层统一过策略后再送云。
   */
  opening?: RedactableAskOpening
  /** 当前节点的生命（M3）：每轮现算，拼进 `<now>`；不传 = 不显示 */
  life?: AskLifeState
  /** 同一会话之前的几轮（续问）；没有就是新对话 */
  history?: readonly ChainAskTurnContext[]
  /** 提问前最后一段证据（指代线索；不是证据） */
  recent?: AskRecentSegment
  /** 用户点「停止」时中止在途请求 */
  signal?: AbortSignal
  /**
   * 会话存储（D64，只追加）：主进程按 conversationId 注入；不传 = 老行为
   * （只把 `history` 塞进 system）。
   */
  conversation?: AskConversationPort
  /** 选区问答：随本轮问题一起给模型看的截图（data URL；不脱敏，D51 之后的新入口） */
  image?: { readonly dataUrl: string }
  /** 用户随本轮问题上传的图片 / 文本文件（用户主动提供，不过脱敏墙） */
  attachments?: {
    readonly images?: readonly string[]
    readonly files?: readonly { readonly name: string; readonly text: string }[]
  }
  /** 记账：整次循环结束后一次（含失败路径已消耗的量） */
  onUsage?: (usage: LlmUsage) => void
  /** 从暂停点恢复（`ask.ts` 按检查点回填）；暂停轮的 turns / 白名单 / 计数都在里面 */
  resume?: AskLoopResumeState
  /** 恢复后用户的选择：continue=继续检索，stop=按现有结果收尾 */
  resumeDecision?: 'continue' | 'stop'
  /** 预算用尽、模型还想查时把状态交回调用方，由它问用户要不要继续（不传=旧行为：直接收尾） */
  onPause?: (state: AskLoopResumeState) => void
  log?: ChainAskLog
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 毫秒时间戳 → 'yyyy-mm-dd HH:mm 周X'（注入 system，模型据此换算相对时间） */
export function formatSystemTime(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())} 周${WEEKDAY_NAMES[date.getDay()]}`
}

function emptyStats(): ChainAskStats {
  return { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
}

/**
 * 检索到、但没进引用的段（最多 5 条，按 search_info 的返回顺序）。
 * 「查到了但不够」时给界面一个入口——命中很多却什么都不说，用户无从判断是没查到还是没查对。
 */
function relatedFromWhitelist(
  whitelist: ReadonlyMap<number, CitationMeta>,
  limit = 5
): ChainAskRelatedSegment[] {
  return [...whitelist.values()].slice(0, limit).map((meta) => ({
    segmentId: meta.segmentId,
    at: meta.at,
    app: meta.app,
    title: meta.title
  }))
}

/** 自动引用的展示上限：段沿用 MAX_CITATIONS，日记沿用旧口径 4 条（多的在过程里看） */
const AUTO_MEMORY_CAP = 4

/** 「已读 → 引用」：read_segment 真正打开过的段（不再看模型正文里的记号） */
function citationsFromRead(reads: ReadonlyMap<number, CitationMeta>): ChainAskCitation[] {
  return [...reads.values()].slice(0, MAX_CITATIONS).map((meta) => ({
    segmentId: meta.segmentId,
    at: meta.at,
    app: meta.app,
    title: meta.title,
    why: ''
  }))
}

/** 「已读 → 日记引用」：read_diary 真正打开过的条目 */
function memoriesFromRead(reads: ReadonlyMap<number, MemoryCitationMeta>): ChainAskMemoryCitation[] {
  return [...reads.values()].slice(0, AUTO_MEMORY_CAP).map((meta) => ({
    itemId: meta.itemId,
    day: meta.day,
    section: meta.section,
    why: '',
    snippet: memorySnippet(meta.text)
  }))
}

/** 每轮思考落盘上限：CoT 可能很长，全存会把历史文件撑大 */
const MAX_TRACE_THINKING_CHARS = 4_000
/** 每轮最多记几条工具调用（异常网关可能一口气给很多） */
const MAX_TRACE_TOOLS = 8

function clipThinking(text: string): string {
  return text.length <= MAX_TRACE_THINKING_CHARS
    ? text
    : `${text.slice(0, MAX_TRACE_THINKING_CHARS)}…`
}

/** 工具结果的一句话摘要（过程展示用；不搬正文） */
function summarizeToolOutcome(
  result: RedactableAskLoopToolResult,
  segments: number
): string {
  switch (result.kind) {
    case 'search_info':
      return `检索命中 ${segments} 段（${result.stats.mode}）`
    case 'ask_history':
      return `问答记录 ${result.entries.length} 条`
    case 'get_freshness':
      return '查了数据边界'
    case 'read_segment':
      return `打开段 ${result.segmentId}${result.shotCount ? '（含截图）' : ''}`
    case 'recall_diary':
      return `日记命中 ${result.hits.length} 条`
    case 'read_diary':
      return `打开 ${result.day} 的日记`
    case 'memory_profile':
      return '看了「关于我」的统计'
    default:
      return `失败：${result.message}`
  }
}

/**
 * 跑一次工具循环。调用方（`askChain`）已经把空问题 / consent / budget / 客户端
 * 解析都判过了；这里只负责循环本身，返回结构化 `ChainAskResult`，不向调用方抛异常。
 */
export async function runAskLoop(ctx: AskLoopContext, question: string): Promise<ChainAskResult> {
  const log = ctx.log ?? (() => {})
  const resume = ctx.resume
  const stats: ChainAskStats = resume ? { ...resume.stats } : emptyStats()
  stats.questionChars = question.length

  /// 引用白名单：search_info 返回过、且脱敏后仍然给模型看过的段（read_segment 的越权门）
  const whitelist = new Map<number, CitationMeta>(resume?.whitelist ?? [])
  /// 日记引用白名单：recall_diary / read_diary 给过的条目（memories 的越权门）
  const memoryWhitelist = new Map<number, MemoryCitationMeta>(resume?.memoryWhitelist ?? [])
  /// 已读（DSH 式自动引用）：read_segment / read_diary 真正打开过的段与日记条目。
  /// 最终 citations 只从这里来——模型在正文里写不写记号都不影响。
  const readSegments = new Map<number, CitationMeta>(resume?.readSegments ?? [])
  const readMemories = new Map<number, MemoryCitationMeta>(resume?.readMemories ?? [])

  /** 过程（D55 ③）：每轮思考 + 工具调用摘要；恢复时先继承暂停前的步骤 */
  const steps: ChainAskTraceStep[] = resume ? [...resume.steps] : []
  /** 这一问里传承成功（M4）：答复只显示，不写会话；下一问从空白开始 */
  let conceived = resume?.conceived === true
  const withTrace = (result: ChainAskResult): ChainAskResult => ({
    ...result,
    ...(conceived ? { conceived: true as const } : {}),
    ...(steps.length > 0 ? { trace: { steps } } : {})
  })

  const executor = createAskToolExecutor({
    db: ctx.db,
    now: ctx.now,
    captureRunning: ctx.captureRunning,
    ...(ctx.embedQuestion ? { embed: ctx.embedQuestion } : {}),
    ...(ctx.readAskHistory ? { readAskHistory: ctx.readAskHistory } : {}),
    ...(ctx.searchBatch ? { searchBatch: ctx.searchBatch } : {}),
    ...(ctx.diary ? { diary: ctx.diary } : {}),
    ...(ctx.conceive ? { conceive: ctx.conceive } : {}),
    ...(ctx.readShot ? { readShot: ctx.readShot } : {}),
    // 只能展开本轮已经给模型看过的段（引用白名单）；模型不能按段号扫库
    canReadSegment: (segmentId) => whitelist.has(segmentId)
  })

  const now = ctx.now()
  const freshness: AskLoopFreshness = {
    latestEvidenceTs: readChainFreshness(ctx.db, now).latestEvidenceTs,
    captureRunning: ctx.captureRunning()
  }
  const systemTime = formatSystemTime(now)
  const systemTimeMs = now
  /** 工具组（D62）：两组都关 = 单轮请求，不跑预算、不等待续查 */
  const toolGroups = ctx.tools ?? { screen: true, diary: true }
  const toolsAvailable = toolGroups.screen || toolGroups.diary
  /** 会话里之前的轮次（只追加的基底）；没有存储时为空 */
  const priorConversation = ctx.conversation?.load() ?? emptyAskConversation()

  // 问题敏感：循环开始前一次判定（与单发路径同口径——宁可答「没找到」，不发敏感问题）
  const probe = ctx.outbound.buildLoop({
    question,
    systemTime,
    systemTimeMs,
    tools: toolGroups,
    freshness,
    turns: [],
    ...(priorConversation.turns.length > 0 || priorConversation.digest !== ''
      ? {
          conversation: priorConversation.turns,
          digest: priorConversation.digest
        }
      : {}),
    ...(ctx.history ? { history: ctx.history } : {}),
    ...(ctx.recent ? { recent: ctx.recent } : {}),
    ...(ctx.life ? { life: ctx.life } : {}),
    ...(ctx.attachments ? { attachments: ctx.attachments } : {})
  })
  if (probe.questionBlocked) {
    return { kind: 'error', reason: 'question-blocked', message: '问题里含敏感内容，未出云', stats }
  }

  const turns: RedactableAskLoopTurn[] = resume ? [...resume.turns] : []
  let hitsShown = resume?.hitsShown ?? 0
  let toolCallCount = resume?.toolCallCount ?? 0
  let assistantTurns = resume?.turnsUsed ?? 0
  /** 已经发生过的 assistant 轮数（恢复时先继承，出参 / 预算都按全局轮次算） */
  let turnsUsed = resume?.turnsUsed ?? 0
  /** 已经批过的「继续查」次数：每次把轮数 / 调用数预算翻一倍窗口 */
  let grants =
    resume && ctx.resumeDecision === 'continue' ? resume.grants + 1 : resume?.grants ?? 0
  /** 本轮（含恢复前）还能调工具的全局轮数 / 调用次数 */
  const toolTurnBudget = toolsAvailable ? ASK_LOOP_MAX_TOOL_TURNS * (1 + grants) : 0
  const toolCallBudget = toolsAvailable ? ASK_LOOP_MAX_TOOL_CALLS * (1 + grants) : 0
  /** 本地循环上限：只给工具预算本身，不再多一发「强制收尾轮」（没有 tool call 就是收尾） */
  const localTurnLimit = toolsAvailable ? Math.max(1, toolTurnBudget - turnsUsed) : 1
  /** 本轮是否查过问答记录：决定「关于对话本身」的答案能否不带屏幕引用 */
  let usedAskHistory = resume?.usedAskHistory ?? false

  /**
   * 成功收口时把这一问追加进会话（失败 / 中止 / 等待续查都不写）。
   * 只存云端视图：问题、<now>、工具轮、最终答复——下次请求原样重放。
   */
  const persistConversation = (payload: ChainAskLoopPayload, answer: string): void => {
    if (!ctx.conversation) return
    // 传承那一问不落会话：母亲最后的答复不进女儿的分支（M4）
    if (conceived) return
    const text = answer.trim()
    if (text === '') return
    // 图片（选区截图 / 用户附件 / QQ 图片 / 工具截图）一律原样存：少一张，这条 user 消息的
    // 字节就变了，后面的前缀缓存全断。只有压缩（appendAskConversationTurn）才允许删图。
    const images = [
      ...(ctx.image !== undefined ? [ctx.image.dataUrl] : []),
      ...(payload.attachments?.images ?? [])
    ]
    const files = payload.attachments?.files ?? []
    const attachments =
      images.length > 0 || files.length > 0 ? { images, files } : undefined
    try {
      ctx.conversation.save(
        appendAskConversationTurn(
          { digest: payload.digest ?? '', turns: payload.conversation ?? [] },
          {
            question: payload.question,
            now: payload.now,
            turns: payload.turns,
            answer: text,
            ...(attachments !== undefined ? { attachments } : {})
          }
        )
      )
    } catch (error) {
      // 会话存储只是缓存 / 上下文，写不进去不该让这一问失败
      log('warn', 'chain ask loop: 会话写入失败', { error: String(error) })
    }
  }

  /**
   * 统计口径（诊断用）：hits / evidence 取**当前已发生**的量——失败收口（客户端抛错 /
   * 超轮超调用）也要留下「其实查到了几段」，事后排查看得见。
   */
  const withLoopDiag = (turnsUsed: number, toolCalls: number): ChainAskStats => ({
    ...stats,
    hits: hitsShown,
    evidence: whitelist.size,
    turns: turnsUsed,
    toolCalls
  })

  // usage 累计：所有出口（成功 / 失败 / 拒答）都只在这里发一次 onUsage
  let usageTotal: LlmUsage = { promptTokens: 0, completionTokens: 0 }
  let usageSettled = false
  const settleUsage = (): void => {
    if (usageSettled) return
    usageSettled = true
    ctx.onUsage?.(usageTotal)
  }
  const accumulate = (usage: LlmUsage | undefined): void => {
    if (!usage) return
    usageTotal = {
      promptTokens: usageTotal.promptTokens + usage.promptTokens,
      completionTokens: usageTotal.completionTokens + usage.completionTokens
    }
  }

  for (let turn = 1; turn <= localTurnLimit; turn++) {
    /** 全局轮次：恢复前已经用掉的 + 本轮；预算、诊断、暂停判断都按全局算 */
    const globalTurn = turnsUsed + turn
    if (ctx.signal?.aborted) {
      log('info', 'chain ask loop: 用户停止', { turn: globalTurn })
      settleUsage()
      return withTrace({ kind: 'error', reason: 'aborted', message: '已停止', stats: withLoopDiag(turnsUsed + turn - 1, toolCallCount) })
    }
    // 用户选「先按现在的结果回答」时，恢复后的第一轮不带工具；其余轮都给 tools。
    // 无工具模式（D62）一开始就没有工具，也不该走「轮数用尽」的收尾语义。
    // 工具预算内都给 tools；只有用户明确选「先按现在的结果回答」时才不带工具。
    // 没有单独的「收尾轮」：模型不再调工具的那一轮就是收尾（缓存前缀不额外断一次）。
    const allowTools =
      toolsAvailable && globalTurn <= toolTurnBudget && !(turn === 1 && ctx.resumeDecision === 'stop')
    const built = ctx.outbound.buildLoop({
      question,
      systemTime,
      systemTimeMs,
      tools: toolGroups,
      freshness,
      turns,
      ...(priorConversation.turns.length > 0 || priorConversation.digest !== ''
        ? {
            conversation: priorConversation.turns,
            digest: priorConversation.digest
          }
        : {}),
      ...(ctx.history ? { history: ctx.history } : {}),
      ...(ctx.recent ? { recent: ctx.recent } : {}),
      ...(ctx.opening ? { opening: ctx.opening } : {}),
      ...(ctx.life ? { life: ctx.life } : {}),
      ...(ctx.attachments ? { attachments: ctx.attachments } : {})
    })
    // 白名单收缩到「本轮载荷里模型实际能看到的段」：脱敏整条挡下的段自然不在里面；
    // 用可见集合而不是「累加后删除被挡 id」，是避免粘性误删——同一段后续轮次
    // 以干净摘要重新展示时，模型见过它，就该能引用（先挡后见的假阴性）。
    const visible = new Set<number>()
    for (const seen of built.payload.turns) {
      const view = seen.toolResult as { kind?: string; hits?: Array<{ segmentId: number }> }
      if (view.kind !== 'search_info') continue
      for (const hit of view.hits ?? []) visible.add(hit.segmentId)
    }
    for (const segmentId of [...whitelist.keys()]) {
      if (!visible.has(segmentId)) whitelist.delete(segmentId)
    }

    let response: Awaited<ReturnType<AskLoopContext['client']['completeAskLoop']>>
    try {
      response = await ctx.client.completeAskLoop(built.payload, {
        allowTools,
        // 最终答复允许自由文本（2026-10-29 拍板：不再逼模型填 JSON）；工具轮仍走协议
        ...(allowTools ? {} : { freeText: true }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.image ? { image: ctx.image } : {}),
        ...(ctx.personaPrompt ? { personaPrompt: ctx.personaPrompt } : {}),
        // 工具组必须每轮都传：两组都关时客户端要据此摘掉「数据边界 / 工具」段
        toolGroups,
        // 传承（M4）：生命 ≤15% 才把 conceive_daughter 放进 tools + 工具清单
        ...(ctx.conceive ? { conceive: true } : {}),
        // 母亲的信：只有女儿代才有；放进 system 的 <mom_letter>
        ...(ctx.momLetter ? { momLetter: ctx.momLetter } : {})
      })
    } catch (error) {
      // 用户点「停止」：不算失败，如实回 aborted
      if (error instanceof LlmAbortError) {
        log('info', 'chain ask loop: 请求已停止', { turn: globalTurn })
        settleUsage()
        return withTrace({ kind: 'error', reason: 'aborted', message: '已停止', stats: withLoopDiag(globalTurn, toolCallCount) })
      }
      log('warn', 'chain ask loop: 模型调用失败', {
        error: String(error),
        // 网关错误正文（400 的真实原因）只进日志，不进界面
        ...(error instanceof LlmHttpError && error.detail !== undefined
          ? { detail: error.detail }
          : {}),
        turn: globalTurn
      })
      // 解析失败也消耗了 token（LlmParseError.usage）：先入账再返回失败
      if (error instanceof LlmParseError) accumulate(error.usage)
      settleUsage()
      return withTrace({
        kind: 'error',
        reason: 'failed',
        message: String(error),
        stats: withLoopDiag(globalTurn, toolCallCount)
      })
    }
    assistantTurns = globalTurn
    accumulate(response.usage)

    // 收尾轮即便客户端还回了 tool_calls（假客户端 / 网关异常）也不执行：
    // 直接按「最终答复」解析，宁可报不成形，也不无限延长循环
    const toolCalls = allowTools ? response.toolCalls ?? [] : []
    const thinking =
      response.reasoning !== undefined ? clipThinking(response.reasoning) : undefined
    if (!allowTools && (response.toolCalls?.length ?? 0) > 0) {
      log('warn', 'chain ask loop: 收尾轮仍返回 tool_calls，已忽略', {
        turn: globalTurn,
        incoming: response.toolCalls?.length ?? 0
      })
    }
    if (toolCalls.length > 0) {
      if (toolCallCount + toolCalls.length > toolCallBudget) {
        log('warn', 'chain ask loop: 工具调用数超限', {
          turn: globalTurn,
          toolCallCount,
          incoming: toolCalls.length
        })
        steps.push({ turn: globalTurn, ...(thinking ? { thinking } : {}), tools: [] })
        settleUsage()
        return withTrace({
          kind: 'error',
          reason: 'failed',
          message: `模型在 ${toolCallBudget} 次工具调用内没有收敛（也可能是这一问确实没有记录）`,
          stats: withLoopDiag(globalTurn, toolCallCount)
        })
      }
      const traceTools: ChainAskTraceTool[] = []
      for (const call of toolCalls) {
        toolCallCount += 1
        if (call.name === 'ask_history') usedAskHistory = true
        const toolStartedAt = Date.now()
        const outcome = await executor.execute({ name: call.name, arguments: call.arguments })
        if (outcome.result.kind === 'conceive_daughter') conceived = true
        const toolMs = Date.now() - toolStartedAt
        turns.push({
          toolCall: { name: call.name, arguments: call.arguments },
          toolResult: outcome.result,
          ...(outcome.images && outcome.images.length > 0 ? { images: outcome.images } : {}),
          // 同一轮的 CoT 挂在轮内每条 turn 上：载荷重建时要把它原样回传，
          // 否则 DeepSeek 带 tools 的第 2 轮起直接 400（trace 里那份是裁剪过的，不能拿来回传）
          ...(response.reasoning !== undefined && response.reasoning !== ''
            ? { reasoning: response.reasoning }
            : {})
        })
        hitsShown += outcome.segments.length
        traceTools.push({
          name: call.name,
          arguments: call.arguments,
          summary: summarizeToolOutcome(outcome.result, outcome.segments.length)
        })
        for (const meta of outcome.segments) {
          whitelist.set(meta.segmentId, meta)
        }
        for (const meta of outcome.memories ?? []) {
          memoryWhitelist.set(meta.itemId, meta)
        }
        // 自动引用：只有「真的打开过」才算（read_segment / read_diary），检索命中不算
        for (const meta of outcome.read ?? []) {
          readSegments.set(meta.segmentId, meta)
        }
        if (call.name === 'read_diary') {
          for (const meta of outcome.memories ?? []) readMemories.set(meta.itemId, meta)
        }
        // 检索是主进程同步执行的，耗时直接等于「点下去没反应」的时长。
        // 慢的才记一条（性能方案 §4.4 的 search_ms 观测点），别给每次工具调用刷日志。
        if (outcome.result.kind === 'search_info' && toolMs >= 100) {
          log('info', 'chain ask loop: 检索较慢', {
            ms: toolMs,
            keywordRows: outcome.result.stats.keywordRows
          })
        }
        if (outcome.result.kind === 'error') {
          // 错误摘要也进日志：只记工具名时，事后分不清是「参数不合法」还是「执行抛错」
          log('warn', 'chain ask loop: 工具执行失败', {
            tool: call.name,
            message: outcome.result.message
          })
        }
      }
      steps.push({
        turn: globalTurn,
        ...(thinking ? { thinking } : {}),
        tools: traceTools.slice(0, MAX_TRACE_TOOLS)
      })
      // 预算正好在最后一轮用完、模型还想继续查：**不硬掐**。把状态交回调用方，
      // 由它问用户「还要继续吗」；用户同意就再给一轮预算，不同意就按现有结果收尾。
      // 暂停前的工具已经执行完并留在 turns 里，恢复时不用重查。
      if (ctx.onPause && globalTurn >= toolTurnBudget && grants < ASK_LOOP_MAX_GRANTS) {
        ctx.onPause({
          turns: [...turns],
          whitelist: new Map(whitelist),
          toolCallCount,
          hitsShown,
          usedAskHistory,
          turnsUsed: globalTurn,
          grants,
          stats: { ...stats, hits: hitsShown, evidence: whitelist.size, turns: globalTurn, toolCalls: toolCallCount },
          steps: [...steps],
          memoryWhitelist: new Map(memoryWhitelist),
          readSegments: new Map(readSegments),
          readMemories: new Map(readMemories),
          ...(conceived ? { conceived: true } : {})
        })
        log('info', 'chain ask loop: 轮数用尽，等用户决定是否继续', {
          turns: globalTurn,
          toolCalls: toolCallCount,
          grants
        })
        settleUsage()
        return withTrace({
          kind: 'continue-ask',
          question: `已经查了 ${globalTurn} 轮，还要接着查吗？`,
          options: [`继续查（再给 ${ASK_LOOP_MAX_TOOL_TURNS} 轮）`, '先按现在的结果回答'],
          stats: withLoopDiag(globalTurn, toolCallCount)
        })
      }
      continue
    }

    // 最终答复轮：引用由「已读」自动带出（2026-10-29 晚，DSH 式）
    steps.push({ turn: globalTurn, ...(thinking ? { thinking } : {}), tools: [] })
    const autoCitations = citationsFromRead(readSegments)
    const autoMemories = memoriesFromRead(readMemories)

    /**
     * 2026-10-29 晚拍板（DSH 式）：模型直接说话，不用写 `[[段 N]]`，也不用在 JSON 里填 citations。
     * 引用 = 这一轮真正打开过的段 / 日记条目（read_segment / read_diary），由驱动层自动带出；
     * JSON 只保留 `answer` / `ask` 的兼容，不再按「有没有引用」判成败。
     */
    const parseOptions = {
      allowNoCitations: true,
      allowConversationAnswer: (ctx.history?.length ?? 0) > 0 || usedAskHistory,
      memoryMeta: memoryWhitelist
    }
    const parsed =
      typeof response.json === 'string'
        ? parseChainReplyText(response.json)
        : parseChainReply(response.json, whitelist, parseOptions)
    if (!parsed.ok) {
      // 不成形的具体原因（空答复 / 结构不对）只进日志：界面只有固定文案，事后没法复盘
      log('warn', 'chain ask loop: 答复不成形', {
        reason: parsed.reason,
        message: parsed.message,
        turn: globalTurn
      })
      settleUsage()
      if (parsed.reason === 'no-citations') {
        return withTrace({
          kind: 'no-evidence',
          related: relatedFromWhitelist(whitelist),
          stats: withLoopDiag(globalTurn, toolCallCount)
        })
      }
      return withTrace({
        kind: 'error',
        reason: 'unparseable',
        message: parsed.message,
        stats: withLoopDiag(globalTurn, toolCallCount)
      })
    }
    if (parsed.kind === 'clarify') {
      // 模型选择先问一句：这是正常出口，不是失败；选项已在上限内去重
      log('info', 'chain ask loop: 模型要求确认', { options: parsed.options.length })
      settleUsage()
      // 澄清也进会话：下一问模型要看到自己问过什么
      persistConversation(built.payload, [parsed.question, ...parsed.options].join('\n'))
      return withTrace({
        kind: 'clarify',
        question: parsed.question,
        options: parsed.options,
        stats: withLoopDiag(globalTurn, toolCallCount)
      })
    }
    settleUsage()
    // 引用只算「真的打开过」的：模型在正文 / JSON 里说引了哪段都不再采信
    stats.cited = autoCitations.length
    if (parsed.kind === 'insufficient') {
      // 查到了相关段但撑不起结论：保留模型说明，引用 = 已读；再把检索到的段列出来
      persistConversation(built.payload, parsed.answer)
      return withTrace({
        kind: 'insufficient',
        answer: parsed.answer,
        citations: autoCitations,
        ...(autoMemories.length > 0 ? { memories: autoMemories } : {}),
        related: relatedFromWhitelist(whitelist),
        stats: withLoopDiag(globalTurn, toolCallCount)
      })
    }
    if (isNoEvidenceAnswer(parsed.answer) && autoCitations.length > 0) {
      // 根因 7：嘴上说没找到、但确实打开过段。保留说明与已读引用，日志留 mismatch 供排查。
      log('warn', 'chain ask loop: answer 声称没找到但打开过段，按没找到保留说明', {
        cited: autoCitations.length
      })
      persistConversation(built.payload, parsed.answer)
      return withTrace({
        kind: 'no-evidence',
        note: parsed.answer,
        citations: autoCitations,
        related: relatedFromWhitelist(whitelist),
        stats: withLoopDiag(globalTurn, toolCallCount)
      })
    }
    if (isNoEvidenceAnswer(parsed.answer)) {
      // 无引用且自称没找到：维持「没找到」，不把固定文案当回答
      persistConversation(built.payload, parsed.answer)
      return withTrace({
        kind: 'no-evidence',
        related: relatedFromWhitelist(whitelist),
        stats: withLoopDiag(globalTurn, toolCallCount)
      })
    }
    persistConversation(built.payload, parsed.answer)
    return withTrace({
      kind: 'answer',
      answer: parsed.answer,
      citations: autoCitations,
      ...(autoMemories.length > 0 ? { memories: autoMemories } : {}),
      stats: withLoopDiag(globalTurn, toolCallCount)
    })
  }

  // 循环出口全覆盖（上限路径在循环内返回），到这里是防御性兜底
  settleUsage()
  return withTrace({
    kind: 'error',
    reason: 'failed',
    message: '工具循环异常结束',
    stats: withLoopDiag(assistantTurns, toolCallCount)
  })
}

/** 供 `askChain` 判定走循环还是回退单发：客户端带 `completeAskLoop` 就走循环 */
export function resolveLoopClient(
  resolution: ChainAskClientResolution
): (LlmClient & Pick<Required<LlmClient>, 'completeAskLoop'>) | null {
  const client = resolution.ok ? resolution.client : undefined
  if (!client || typeof client.completeAskLoop !== 'function') return null
  return client as LlmClient & Pick<Required<LlmClient>, 'completeAskLoop'>
}
