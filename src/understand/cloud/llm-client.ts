/**
 * LLM 客户端契约（M2 Phase 0 / D21）
 *
 * 业务代码只依赖这个接口；测试与 E2E 用 FakeLlmClient，绝不发真实网络。
 * 错误信息里禁止出现 prompt / 响应正文（security.md 日志红线）。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface LlmJsonRequest {
  messages: LlmMessage[]
  maxTokens?: number
  temperature?: number
}

export interface LlmJsonResult {
  json: unknown
  usage: LlmUsage
}

export interface LlmClient {
  completeJson(request: LlmJsonRequest): Promise<LlmJsonResult>
}

/** 可重试性由子类 / 连接层决定，业务层只按类型判断 */
export class LlmError extends Error {
  constructor(message: string, readonly code: 'http' | 'timeout' | 'network' | 'parse' | 'config') {
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

export type FakeLlmReply =
  | { json: unknown; usage?: Partial<LlmUsage> }
  | Error

/** 假客户端：按队列返回预置结果，记录请求供断言（测试 / E2E 专用） */
export class FakeLlmClient implements LlmClient {
  readonly requests: LlmJsonRequest[] = []
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

  async completeJson(request: LlmJsonRequest): Promise<LlmJsonResult> {
    this.requests.push(request)
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
