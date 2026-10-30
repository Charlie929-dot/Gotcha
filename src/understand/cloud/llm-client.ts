/**
 * LLM 客户端契约（M2 Phase 0 / D21）
 *
 * **唯一出口**：客户端只接收 `buildCloudPayload()` 产出的 `CloudPayload`
 * （带 nominal brand），业务代码无法直接拼 messages 把未脱敏文本发出去。
 * 测试与 E2E 用 FakeLlmClient，绝不发真实网络；错误信息不含 prompt / 响应正文。
 */

import type {
  AskSummaryPayload,
  ChainAskLoopPayload,
  ChainAskPayload,
  ChainExtractPayload,
  ChainMergePayload,
  CloudPayload,
  ThemeAssignmentPayload,
  ThemeNamingPayload
} from './redact'

/** 一次工具调用（客户端已把 JSON 参数解析成对象；id 用于把 tool 消息对回调用） */
export interface LlmToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** role=user 且带图时附在正文后（wire 层拼成 OpenAI 兼容的内容段数组） */
  imageUrl?: string
  /**
   * role=user 的多张图（用户上传的附件 / read_segment 带出的历史截图）。
   * 与 `imageUrl` 合并；DeepSeek 只允许 user 消息带图，tool 消息带图会 400。
   */
  images?: readonly string[]
  /** role=assistant 调工具时附带（content 可为空串） */
  toolCalls?: readonly LlmToolCall[]
  /** role=tool 时：对应调用的 id */
  toolCallId?: string
  /**
   * role=assistant 这一轮的思维链（DeepSeek `reasoning_content` 原样回传）。
   * 带 `tools` 的请求必须回传历史各轮的 CoT，否则网关从第 2 轮起直接 400
   * （见 gotchas「DeepSeek thinking + tools 必须回传 reasoning_content」）。
   * 非 DeepSeek 端点不发这个字段：严格网关会因未知参数 400。
   */
  reasoningContent?: string
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface LlmJsonResult {
  json: unknown
  usage: LlmUsage
}

/** `/compact` 摘要的响应（M3）：一段纯文本 + 本次用量 */
export interface LlmSummaryResult {
  summary: string
  usage: LlmUsage
}

/** 工具循环一轮的响应：要么带 toolCalls（继续循环），要么带最终答复 JSON */
export interface LlmAskLoopResult {
  toolCalls?: readonly LlmToolCall[]
  json?: unknown
  usage: LlmUsage
  /**
   * 模型这一轮的思考（DeepSeek `reasoning_content`；只有开了 thinking 才有）。
   * 只用于「过程可见」（落盘 / 界面折叠展示），不写回下一次请求。
   */
  reasoning?: string
}

export interface LlmRepairContext {
  errors: readonly string[]
}

export interface LlmCompleteOptions {
  /** 暂停 / 退出时由上层传入，中止在途请求（D18） */
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
  /**
   * 修复重试上下文：上一次输出未通过校验时的错误摘要。
   * 只允许校验器生成的固定文案（字段名 / 下标 / id / 上限）；客户端会再截断
   * （每条 ≤120 字、最多 5 条），避免业务代码借自由文本把内容注入 prompt。
   */
  repair?: LlmRepairContext
  /**
   * 该轮是否允许模型调用工具（**只对 `completeAskLoop` 生效**）。
   * `false` = 收尾轮：请求不带 tools、强制给最终 JSON，模型只能基于已看到的结果作答。
   * 缺省按 `true`（普通工具轮）。
   */
  allowTools?: boolean
  /**
   * 允许最终答复是**自由文本**（2026-10-29 拍板：不再逼模型填 JSON）。
   *
   * `true` 时收尾轮不发 `response_format`，模型直接说人话也照收（解析层从
   * `[[段 12]]` / `[[日记 7]]` 记号里取引用）；结构化 JSON 仍然兼容。
   * 只对 `completeAskLoop` 生效。
   */
  freeText?: boolean
  /**
   * 选区问答：随本轮问题一起给模型看的截图（`data:image/...;base64,...`）。
   * **不走脱敏**——这是用户在界面上自己框的图（拍板 2026-10-28），不是从记忆库里翻出来的文本；
   * 出网确认门（D24）照旧在 `askChain` 门口判定。
   */
  image?: { readonly dataUrl: string }
  /**
   * 人设提示（本地配置：名字 / 口吻 / 红线）。
   * 只拼在工具循环的 system 最前面，**不进 branded 载荷**——它不是屏幕内容，
   * 出云确认门仍按整次请求在 `askChain` 门口判定。
   */
  personaPrompt?: string
  /**
   * 工具循环发哪些工具（D72 分支工具白名单）：元素名（`search_info` / `recall_diary`…）。
   * 缺省空表 = 纯模型：不带 tools、不写「数据边界 / 工具」段。
   */
  toolElements?: readonly string[]
  /**
   * 传承（M4）：生命 ≤15% 时才带 `conceive_daughter` 这个工具（以及 system 里的一行说明）。
   * 缺省 false = 不给模型这个入口。
   */
  conceive?: boolean
  /** 母亲留下的信（`<mom_letter>`，M4）：只有女儿代才有；缺省 = 不写这一段 */
  momLetter?: string
}

export interface LlmClient {
  /** 批量归纳（补历史路径）：整批时刻 → 节点 + 边 */
  completeJson(payload: CloudPayload, options?: LlmCompleteOptions): Promise<LlmJsonResult>
  /** 新主题命名（P2 在线路径；S4）：一个主题的代表时刻 → { title, summary, type } */
  completeNaming(payload: ThemeNamingPayload, options?: LlmCompleteOptions): Promise<LlmJsonResult>
  /** 模糊归属确认（P2 在线路径；S4）：时刻 + 候选主题 → { assignments } */
  completeAssignments(
    payload: ThemeAssignmentPayload,
    options?: LlmCompleteOptions
  ): Promise<LlmJsonResult>
  /** 信息链派生（v0.8 / D45）：段正文 → { tags, links } */
  completeChainExtract(
    payload: ChainExtractPayload,
    options?: LlmCompleteOptions
  ): Promise<LlmJsonResult>
  /** 信息链派生（v0.8 / D45）：模糊带「候选名 / 已有名」对 → { same: boolean[] } */
  completeChainMerge(
    payload: ChainMergePayload,
    options?: LlmCompleteOptions
  ): Promise<LlmJsonResult>
  /**
   * 问记忆（S1）：问题 + 命中证据 → `{ answer, citations:[{segmentId, why}] }`。
   * **可选**：不是每个客户端都要能答问；没有这个能力时由调用方报 `client` 错误，不静默降级。
   */
  completeAsk?(payload: ChainAskPayload, options?: LlmCompleteOptions): Promise<LlmJsonResult>
  /**
   * 问记忆 · 工具循环（toolloop）：当前 branded 循环上下文 → 本轮的 toolCalls 或最终 JSON。
   * 由 loop 驱动层迭代调用；**可选**：没有这个能力的客户端走保留的单发 `completeAsk` 回退路径。
   */
  completeAskLoop?(
    payload: ChainAskLoopPayload,
    options?: LlmCompleteOptions
  ): Promise<LlmAskLoopResult>
  /**
   * `/compact` 摘要（M3）：一段对话原文 → 一段纯文本摘要。
   * **可选**：没这个能力的客户端由调用方报 `failed`，不静默降级。
   */
  completeSummary?(
    payload: AskSummaryPayload,
    options?: LlmCompleteOptions
  ): Promise<LlmSummaryResult>
}

/** 可重试性由子类 / 连接层决定，业务层只按类型判断 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'http' | 'timeout' | 'network' | 'parse' | 'config' | 'aborted'
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

export class LlmHttpError extends LlmError {
  constructor(
    readonly status: number,
    /**
     * 网关错误正文的前若干字（只进主进程日志，**不进界面**）。
     * 用于排 400：「缺 reasoning_content」「messages 顺序不对」这类信息只在正文里。
     */
    readonly detail?: string
  ) {
    super(`LLM HTTP ${status}`, 'http')
    this.name = 'LlmHttpError'
  }
}

/** 网关错误正文留痕上限：够看清原因，又不至于把日志撑大 */
export const LLM_ERROR_DETAIL_MAX_CHARS = 300

/** 网关错误正文 → 单行摘要（截断；调用方只写日志） */
export function summarizeErrorBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, LLM_ERROR_DETAIL_MAX_CHARS)
}

export class LlmTimeoutError extends LlmError {
  constructor() {
    super('LLM 请求超时', 'timeout')
    this.name = 'LlmTimeoutError'
  }
}

export class LlmNetworkError extends LlmError {
  constructor() {
    super('LLM 网络请求失败', 'network')
    this.name = 'LlmNetworkError'
  }
}

export class LlmParseError extends LlmError {
  constructor(
    message = 'LLM 返回内容不是合法 JSON',
    /** 响应已带回的用量：解析失败同样消耗了 token，必须能交给上层记账（F03） */
    readonly usage?: LlmUsage
  ) {
    super(message, 'parse')
    this.name = 'LlmParseError'
  }
}

/** 上层主动取消（暂停 / 退出），不重试 */
export class LlmAbortError extends LlmError {
  constructor() {
    super('LLM 请求已取消', 'aborted')
    this.name = 'LlmAbortError'
  }
}

export type FakeLlmReply =
  | { json: unknown; usage?: Partial<LlmUsage>; reasoning?: string }
  /** 工具循环脚本：本轮让模型发起这些调用（arguments 缺省为空对象） */
  | {
      toolCalls: ReadonlyArray<{ id?: string; name: string; arguments?: Record<string, unknown> }>
      usage?: Partial<LlmUsage>
      reasoning?: string
    }
  | Error

/** 假客户端：按队列返回预置结果，记录请求供断言（测试 / E2E 专用） */
export class FakeLlmClient implements LlmClient {
  readonly requests: CloudPayload[] = []
  /** P2 在线路径的两次调用单独留痕，避免和批量归纳的断言混在一起 */
  readonly namingRequests: ThemeNamingPayload[] = []
  readonly assignmentRequests: ThemeAssignmentPayload[] = []
  /** 信息链派生（v0.8 / D45）的两次调用单独留痕 */
  readonly chainExtractRequests: ChainExtractPayload[] = []
  readonly chainMergeRequests: ChainMergePayload[] = []
  /** 问记忆（S1）的调用留痕 */
  readonly askRequests: ChainAskPayload[] = []
  /** 问记忆工具循环（toolloop）的调用留痕（每轮一条） */
  readonly askLoopRequests: ChainAskLoopPayload[] = []
  /** 每次调用的选项（signal / repairHint 等），供暂停 / 修复重试断言 */
  readonly optionCalls: LlmCompleteOptions[] = []
  private readonly replies: FakeLlmReply[]

  constructor(replies: FakeLlmReply[] = []) {
    this.replies = [...replies]
  }

  push(reply: FakeLlmReply): void {
    this.replies.push(reply)
  }

  get pending(): number {
    return this.replies.length
  }

  /** 队列取一条预置回复（信号已取消 / 队列空 / 预置错误都如实抛出） */
  private takeReply(options: LlmCompleteOptions): Exclude<FakeLlmReply, Error> {
    this.optionCalls.push(options)
    if (options.signal?.aborted) throw new LlmAbortError()
    const reply = this.replies.shift()
    if (!reply) throw new Error('FakeLlmClient: 没有预置回复')
    if (reply instanceof Error) throw reply
    return reply
  }

  private usageOf(reply: { usage?: Partial<LlmUsage> }): LlmUsage {
    return {
      promptTokens: reply.usage?.promptTokens ?? 0,
      completionTokens: reply.usage?.completionTokens ?? 0
    }
  }

  private take(options: LlmCompleteOptions): LlmJsonResult {
    const reply = this.takeReply(options)
    if ('toolCalls' in reply) {
      // 单发路径收到了脚本化的工具调用：视为结构错误，与真客户端的解析失败同路
      throw new LlmParseError('FakeLlmClient: 工具循环回复被单发路径消费')
    }
    return {
      json: reply.json,
      usage: this.usageOf(reply),
      ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {})
    }
  }

  private takeLoop(options: LlmCompleteOptions): LlmAskLoopResult {
    const reply = this.takeReply(options)
    const reasoning = reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}
    if (!('toolCalls' in reply)) return { json: reply.json, usage: this.usageOf(reply), ...reasoning }
    return {
      toolCalls: reply.toolCalls.map((call, index) => ({
        // 没给 id 就造一个确定性的：回填 tool 消息时能对上即可
        id: call.id ?? `fake_call_${index}`,
        name: call.name,
        arguments: call.arguments ?? {}
      })),
      usage: this.usageOf(reply),
      ...reasoning
    }
  }

  async completeJson(
    payload: CloudPayload,
    options: LlmCompleteOptions = {}
  ): Promise<LlmJsonResult> {
    this.requests.push(payload)
    return this.take(options)
  }

  async completeNaming(
    payload: ThemeNamingPayload,
    options: LlmCompleteOptions = {}
  ): Promise<LlmJsonResult> {
    this.namingRequests.push(payload)
    return this.take(options)
  }

  async completeAssignments(
    payload: ThemeAssignmentPayload,
    options: LlmCompleteOptions = {}
  ): Promise<LlmJsonResult> {
    this.assignmentRequests.push(payload)
    return this.take(options)
  }

  async completeChainExtract(
    payload: ChainExtractPayload,
    options: LlmCompleteOptions = {}
  ): Promise<LlmJsonResult> {
    this.chainExtractRequests.push(payload)
    return this.take(options)
  }

  async completeChainMerge(
    payload: ChainMergePayload,
    options: LlmCompleteOptions = {}
  ): Promise<LlmJsonResult> {
    this.chainMergeRequests.push(payload)
    return this.take(options)
  }

  async completeAsk(payload: ChainAskPayload, options: LlmCompleteOptions = {}): Promise<LlmJsonResult> {
    this.askRequests.push(payload)
    return this.take(options)
  }

  async completeAskLoop(
    payload: ChainAskLoopPayload,
    options: LlmCompleteOptions = {}
  ): Promise<LlmAskLoopResult> {
    this.askLoopRequests.push(payload)
    return this.takeLoop(options)
  }
}
