/**
 * OpenAI 兼容 JSON 客户端（M2 Phase 0；预设 DeepSeek，但供应商可自定义，D21）
 *
 * - 只接收 `CloudPayload`（唯一出云出口产出），prompt 由本模块拼装，业务代码无法注入自由文本；
 * - `POST {baseUrl}/chat/completions`，`response_format: {type:'json_object'}`，禁止跟随重定向
 *   （避免 Authorization 头被 302 带到别处）；
 * - 超时 60s 覆盖「连接 + 响应体读取」全程；429 / 5xx / 网络 / 超时指数退避 1s·4s；
 * - 外部 AbortSignal（暂停）可中止在途请求与退避等待，取消后不重试（D18）；
 * - 返回解析后的 JSON + usage；错误类型化，消息不含 prompt / 响应正文。
 */

import { LLM_DEFAULTS } from './constants'
import { normalizeBaseUrl } from './providers'
import {
  LlmAbortError,
  LlmError,
  LlmHttpError,
  LlmNetworkError,
  LlmParseError,
  LlmTimeoutError,
  type LlmClient,
  type LlmCompleteOptions,
  type LlmJsonResult,
  type LlmMessage
} from './llm-client'
import type { CloudPayload } from './redact'

export interface DeepSeekClientOptions {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs?: number
  maxRetries?: number
  retryBaseMs?: number
  fetchImpl?: typeof fetch
  /** 测试注入：避免真等退避时间；需响应 AbortSignal（暂停时中止等待） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

const SYSTEM_PROMPT = [
  '你是「记忆球」的屏幕事件归纳器。输入是已脱敏的屏幕事件列表（json）。',
  '请只输出一个 json 对象，不要输出 json 以外的任何文字。',
  'json 结构：',
  '{"nodes":[{"title":"简短标题","summary":"一句话摘要","type":"knowledge|activity","event_ids":[1,2]}],',
  ' "edges":[{"from":0,"to":1,"weight":0.5,"evidence":"连边理由"}]}',
  'nodes 的 event_ids 必须来自输入事件 id，不得编造；edges 的 from/to 是本次输出 nodes 的下标。'
].join('\n')

/** prompt 只由已脱敏事件拼装（Phase 1 在此之上加 JSON 校验与修复重试） */
export function buildMessages(payload: CloudPayload): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ events: payload.events }) }
  ]
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function isRetryable(error: unknown): boolean {
  if (error instanceof LlmTimeoutError || error instanceof LlmNetworkError) return true
  if (error instanceof LlmHttpError) return error.status === 429 || error.status >= 500
  return false
}

/** 可被 AbortSignal 打断的等待（暂停时不必等完整退避） */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmAbortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      cleanup()
      reject(new LlmAbortError())
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createDeepSeekClient(options: DeepSeekClientOptions): LlmClient {
  // 客户端自己再校验一次 URL 策略：直接构造客户端也绕不过「仅 https / 本机 http」，
  // 避免密钥被明文发出（providers.ts 的校验只覆盖经过 settings 的路径）
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  if (!baseUrl) throw new LlmError('baseUrl 不合法（仅允许 https，或本机 http）', 'config')
  const timeoutMs = options.timeoutMs ?? LLM_DEFAULTS.timeoutMs
  const maxRetries = options.maxRetries ?? LLM_DEFAULTS.maxRetries
  const retryBaseMs = options.retryBaseMs ?? LLM_DEFAULTS.retryBaseMs
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? abortableSleep
  if (!options.apiKey) throw new LlmError('缺少 API key', 'config')

  async function requestOnce(
    payload: CloudPayload,
    callOptions: LlmCompleteOptions
  ): Promise<LlmJsonResult> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const externalSignal = callOptions.signal
    const onExternalAbort = (): void => controller.abort()
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer)
        throw new LlmAbortError()
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    const abortOrNetworkError = (): Error => {
      if (externalSignal?.aborted) return new LlmAbortError()
      if (timedOut) return new LlmTimeoutError()
      return new LlmNetworkError()
    }

    try {
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
            messages: buildMessages(payload),
            response_format: { type: 'json_object' },
            temperature: callOptions.temperature ?? LLM_DEFAULTS.temperature,
            max_tokens: callOptions.maxTokens ?? LLM_DEFAULTS.maxTokens,
            stream: false
          }),
          signal: controller.signal,
          // 不跟随重定向：避免 302 把带 Authorization 的请求带到别的地址
          redirect: 'error'
        })
      } catch (error) {
        // 不带上底层错误原文（可能含 URL / 请求细节），只给类型化错误
        void error
        throw abortOrNetworkError()
      }

      if (!response.ok) throw new LlmHttpError(response.status)

      // 超时定时器保持到响应体读完：防止响应头返回后 body 卡住、60s 超时失效
      let data: ChatCompletionResponse
      try {
        data = (await response.json()) as ChatCompletionResponse
      } catch (error) {
        void error
        if (externalSignal?.aborted) throw new LlmAbortError()
        if (timedOut) throw new LlmTimeoutError()
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
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  return {
    async completeJson(
      payload: CloudPayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmJsonResult> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await requestOnce(payload, callOptions)
        } catch (error) {
          if (error instanceof LlmAbortError) throw error
          if (!isRetryable(error) || attempt >= maxRetries) throw error
          // 退避等待也可被暂停打断（abortableSleep / 注入实现）
          await sleep(retryBaseMs * 4 ** attempt, callOptions.signal)
          if (callOptions.signal?.aborted) throw new LlmAbortError()
        }
      }
    }
  }
}
