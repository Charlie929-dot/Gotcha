/**
 * LLM 客户端契约（M2 Phase 0 / D21）
 *
 * **唯一出口**：客户端只接收 `buildCloudPayload()` 产出的 `CloudPayload`
 * （带 nominal brand），业务代码无法直接拼 messages 把未脱敏文本发出去。
 * 测试与 E2E 用 FakeLlmClient，绝不发真实网络；错误信息不含 prompt / 响应正文。
 */

import type { CloudPayload } from './redact'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface LlmJsonResult {
  json: unknown
  usage: LlmUsage
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
}

export interface LlmClient {
  completeJson(payload: CloudPayload, options?: LlmCompleteOptions): Promise<LlmJsonResult>
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
  constructor(readonly status: number) {
    super(`LLM HTTP ${status}`, 'http')
    this.name = 'LlmHttpError'
  }
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
  constructor(message = 'LLM 返回内容不是合法 JSON') {
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
  | { json: unknown; usage?: Partial<LlmUsage> }
  | Error

/** 假客户端：按队列返回预置结果，记录请求供断言（测试 / E2E 专用） */
export class FakeLlmClient implements LlmClient {
  readonly requests: CloudPayload[] = []
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

  async completeJson(
    payload: CloudPayload,
    options: LlmCompleteOptions = {}
  ): Promise<LlmJsonResult> {
    this.requests.push(payload)
    this.optionCalls.push(options)
    if (options.signal?.aborted) throw new LlmAbortError()
    const reply = this.replies.shift()
    if (!reply) throw new Error('FakeLlmClient: 没有预置回复')
    if (reply instanceof Error) throw reply
    return {
      json: reply.json,
      usage: {
        promptTokens: reply.usage?.promptTokens ?? 0,
        completionTokens: reply.usage?.completionTokens ?? 0
      }
    }
  }
}
