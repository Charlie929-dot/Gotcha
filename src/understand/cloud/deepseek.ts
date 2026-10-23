/**
 * OpenAI 兼容 JSON 客户端（M2 Phase 0；预设 DeepSeek，但供应商可自定义，D21）
 *
 * - `POST {baseUrl}/chat/completions`，`response_format: {type:'json_object'}`；
 * - 超时 60s（可配）；429 / 5xx / 网络 / 超时指数退避重试，其余 4xx 不重试；
 * - 返回解析后的 JSON + usage；错误类型化，消息不含 prompt / 响应正文。
 */

import { LLM_DEFAULTS } from './constants'
import {
  LlmError,
  LlmHttpError,
  LlmNetworkError,
  LlmParseError,
  LlmTimeoutError,
  type LlmClient,
  type LlmJsonRequest,
  type LlmJsonResult
} from './llm-client'

export interface DeepSeekClientOptions {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs?: number
  maxRetries?: number
  retryBaseMs?: number
  fetchImpl?: typeof fetch
  /** 测试注入：避免真等退避时间 */
  sleep?: (ms: number) => Promise<void>
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function isRetryable(error: unknown): boolean {
  if (error instanceof LlmTimeoutError || error instanceof LlmNetworkError) return true
  if (error instanceof LlmHttpError) return error.status === 429 || error.status >= 500
  return false
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createDeepSeekClient(options: DeepSeekClientOptions): LlmClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? LLM_DEFAULTS.timeoutMs
  const maxRetries = options.maxRetries ?? LLM_DEFAULTS.maxRetries
  const retryBaseMs = options.retryBaseMs ?? LLM_DEFAULTS.retryBaseMs
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  if (!options.apiKey) throw new LlmError('缺少 API key', 'config')

  async function requestOnce(request: LlmJsonRequest): Promise<LlmJsonResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify({
          model: options.model,
          messages: request.messages,
          response_format: { type: 'json_object' },
          temperature: request.temperature ?? LLM_DEFAULTS.temperature,
          max_tokens: request.maxTokens ?? LLM_DEFAULTS.maxTokens,
          stream: false
        }),
        signal: controller.signal
      })
    } catch (error) {
      if (controller.signal.aborted) throw new LlmTimeoutError()
      // 不带上底层错误原文（可能含 URL / 请求细节），只给类型化错误
      void error
      throw new LlmNetworkError()
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) throw new LlmHttpError(response.status)

    let data: ChatCompletionResponse
    try {
      data = (await response.json()) as ChatCompletionResponse
    } catch {
      throw new LlmParseError('LLM 响应不是合法 JSON')
    }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      // JSON Output 官方已知可能返回空 content：按非法输出处理，交给上层修复重试
      throw new LlmParseError('LLM 返回空 content')
    }
    let json: unknown
    try {
      json = JSON.parse(content)
    } catch {
      throw new LlmParseError()
    }
    return {
      json,
      usage: {
        promptTokens: toCount(data.usage?.prompt_tokens),
        completionTokens: toCount(data.usage?.completion_tokens)
      }
    }
  }

  return {
    async completeJson(request: LlmJsonRequest): Promise<LlmJsonResult> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await requestOnce(request)
        } catch (error) {
          if (!isRetryable(error) || attempt >= maxRetries) throw error
          await sleep(retryBaseMs * 2 ** attempt)
        }
      }
    }
  }
}
