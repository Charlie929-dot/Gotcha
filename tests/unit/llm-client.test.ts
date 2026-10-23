import { describe, expect, it, vi } from 'vitest'
import { createDeepSeekClient } from '../../src/understand/cloud/deepseek'
import {
  LlmError,
  LlmHttpError,
  LlmNetworkError,
  LlmParseError,
  LlmTimeoutError,
  type LlmJsonRequest
} from '../../src/understand/cloud/llm-client'

const REQUEST: LlmJsonRequest = {
  messages: [
    { role: 'system', content: '输出 json' },
    { role: 'user', content: '{"events":[]}' }
  ]
}

function okResponse(
  content: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } = { prompt_tokens: 10, completion_tokens: 4 }
): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createDeepSeekClient>[0]> = {}
): ReturnType<typeof createDeepSeekClient> {
  return createDeepSeekClient({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'test-key',
    sleep: async () => {},
    fetchImpl,
    ...overrides
  })
}

describe('DeepSeek 客户端 · JSON Output', () => {
  it('成功：POST /chat/completions，带 json_object / 温度 / 上限 / Bearer；解析 json 与 usage', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"nodes":[{"id":"n1"}]}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.completeJson(REQUEST)

    expect(result.json).toEqual({ nodes: [{ id: 'n1' }] })
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4 })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2000,
      stream: false
    })
    expect(body.messages).toEqual(REQUEST.messages)
  })

  it('baseUrl 末尾斜杠不会拼出双斜杠', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('{}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      baseUrl: 'https://api.deepseek.com/'
    })
    await client.completeJson(REQUEST)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
  })

  it('500 后重试成功，退避按 1x 基数（注入 sleep 不真等）', async () => {
    const responses = [new Response('', { status: 500 }), okResponse('{"ok":true}')]
    const fetchImpl = vi.fn(async () => responses.shift()!)
    const sleep = vi.fn(async (_ms: number) => {})
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep })
    const result = await client.completeJson(REQUEST)
    expect(result.json).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0][0]).toBe(1_000)
  })

  it('429 可重试，第二次 1000ms、第三次 2000ms', async () => {
    const responses = [
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      okResponse('{"ok":true}')
    ]
    const fetchImpl = vi.fn(async () => responses.shift()!)
    const sleep = vi.fn(async (_ms: number) => {})
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep })
    await client.completeJson(REQUEST)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 2_000])
  })

  it('400 不重试，抛 LlmHttpError(400)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 400 }))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(client.completeJson(REQUEST)).rejects.toMatchObject({ name: 'LlmHttpError', status: 400 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('网络错误重试到上限后抛 LlmNetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED')
    })
    const sleep = vi.fn(async (_ms: number) => {})
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep, maxRetries: 1 })
    await expect(client.completeJson(REQUEST)).rejects.toBeInstanceOf(LlmNetworkError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('超时抛 LlmTimeoutError（不泄露请求内容）', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch, { timeoutMs: 5, maxRetries: 0 })
    const error = await client.completeJson(REQUEST).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LlmTimeoutError)
    expect(String((error as Error).message)).not.toContain('{"events":[]')
  })

  it('空 content / 非法 JSON / 坏响应体都按 LlmParseError 处理且不重试', async () => {
    for (const response of [
      okResponse(''),
      okResponse('not-json'),
      new Response('not-json-body', { status: 200 })
    ]) {
      const fetchImpl = vi.fn(async () => response)
      const client = makeClient(fetchImpl as unknown as typeof fetch)
      await expect(client.completeJson(REQUEST)).rejects.toBeInstanceOf(LlmParseError)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('usage 缺失时记 0', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{}', {}))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.completeJson(REQUEST)
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 })
  })

  it('缺少 apiKey 直接抛配置错误，不发请求', () => {
    const fetchImpl = vi.fn(async () => okResponse('{}'))
    expect(() =>
      createDeepSeekClient({
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKey: '',
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).toThrow(LlmError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
