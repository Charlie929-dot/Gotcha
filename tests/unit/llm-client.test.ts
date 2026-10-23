import { describe, expect, it, vi } from 'vitest'
import { buildCloudPayload } from '../../src/understand/cloud/redact'
import { createDeepSeekClient } from '../../src/understand/cloud/deepseek'
import {
  LlmAbortError,
  LlmError,
  LlmHttpError,
  LlmNetworkError,
  LlmParseError,
  LlmTimeoutError
} from '../../src/understand/cloud/llm-client'

function payload() {
  return buildCloudPayload([
    { id: 1, ts: 1_700_000_000_000, app: 'notepad.exe', windowTitle: '标题', ocrText: '正文' },
    { id: 2, ts: 1_700_000_001_000, app: 'chrome.exe', windowTitle: '页面', ocrText: '内容' }
  ]).payload
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

describe('DeepSeek 客户端 · JSON Output（只接收出云载荷）', () => {
  it('成功：POST /chat/completions，prompt 由载荷拼装，禁止重定向，解析 json 与 usage', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"nodes":[{"id":"n1"}]}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.completeJson(payload())

    expect(result.json).toEqual({ nodes: [{ id: 'n1' }] })
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4 })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.method).toBe('POST')
    // 不跟随重定向：Authorization 头不能被 302 带到别处
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')

    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
      [key: string]: unknown
    }
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2000,
      stream: false
    })
    // 调用方只能给载荷；messages 由客户端拼装，且用户消息就是脱敏后事件
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('json')
    expect(body.messages[1].role).toBe('user')
    const userContent = JSON.parse(body.messages[1].content) as {
      events: Array<{ id: number; app: string; title: string; ocr: string }>
    }
    expect(userContent.events.map((e) => e.id)).toEqual([1, 2])
    expect(userContent.events[0]).toEqual({
      id: 1,
      ts: 1_700_000_000_000,
      app: 'notepad.exe',
      title: '标题',
      ocr: '正文'
    })
  })

  it('每次调用可覆盖 maxTokens / temperature（不改变内容出口）', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('{}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await client.completeJson(payload(), { maxTokens: 500, temperature: 0.2 })
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>
    expect(body).toMatchObject({ max_tokens: 500, temperature: 0.2 })
  })

  it('baseUrl 末尾斜杠不会拼出双斜杠', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('{}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      baseUrl: 'https://api.deepseek.com/'
    })
    await client.completeJson(payload())
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
  })

  it('直接构造客户端也执行 URL 策略：远端明文 http 拒绝，本机 http 允许', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('{}'))
    expect(() => makeClient(fetchImpl as unknown as typeof fetch, { baseUrl: 'http://evil.example.com' })).toThrow(
      LlmError
    )
    expect(() =>
      makeClient(fetchImpl as unknown as typeof fetch, { baseUrl: 'https://user:pass@example.com' })
    ).toThrow(LlmError)
    expect(fetchImpl).not.toHaveBeenCalled()

    const local = makeClient(fetchImpl as unknown as typeof fetch, { baseUrl: 'http://127.0.0.1:8000/v1' })
    await local.completeJson(payload())
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8000/v1/chat/completions')
  })

  it('500 后重试成功，退避按 1x 基数（注入 sleep 不真等）', async () => {
    const responses = [new Response('', { status: 500 }), okResponse('{"ok":true}')]
    const fetchImpl = vi.fn(async () => responses.shift()!)
    const sleep = vi.fn(async (_ms: number) => {})
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep })
    const result = await client.completeJson(payload())
    expect(result.json).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0][0]).toBe(1_000)
  })

  it('429 可重试，退避 1000ms、4000ms（方案 1s/4s）', async () => {
    const responses = [
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      okResponse('{"ok":true}')
    ]
    const fetchImpl = vi.fn(async () => responses.shift()!)
    const sleep = vi.fn(async (_ms: number) => {})
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep })
    await client.completeJson(payload())
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 4_000])
  })

  it('400 不重试，抛 LlmHttpError(400)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 400 }))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(client.completeJson(payload())).rejects.toMatchObject({
      name: 'LlmHttpError',
      status: 400
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('网络错误重试到上限后抛 LlmNetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED')
    })
    const sleep = vi.fn(async (_ms: number) => {})
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep, maxRetries: 1 })
    await expect(client.completeJson(payload())).rejects.toBeInstanceOf(LlmNetworkError)
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
    const error = await client.completeJson(payload()).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LlmTimeoutError)
    expect(String((error as Error).message)).not.toContain('标题')
  })

  it('外部 AbortSignal：在途请求立即取消、不重试（D18 暂停）', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch, { maxRetries: 2 })
    const aborter = new AbortController()
    const promise = client.completeJson(payload(), { signal: aborter.signal })
    aborter.abort()
    await expect(promise).rejects.toBeInstanceOf(LlmAbortError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('外部 AbortSignal 预先已取消：不发请求', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const aborter = new AbortController()
    aborter.abort()
    await expect(client.completeJson(payload(), { signal: aborter.signal })).rejects.toBeInstanceOf(
      LlmAbortError
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('超时覆盖响应体读取：响应头已到但 body 卡住也按 LlmTimeoutError 结束', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
      } as unknown as Response
    })
    const client = makeClient(fetchImpl as unknown as typeof fetch, { timeoutMs: 5, maxRetries: 0 })
    await expect(client.completeJson(payload())).rejects.toBeInstanceOf(LlmTimeoutError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('响应体读取阶段被暂停取消：抛 LlmAbortError', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
      } as unknown as Response
    })
    const client = makeClient(fetchImpl as unknown as typeof fetch, { maxRetries: 0 })
    const aborter = new AbortController()
    const promise = client.completeJson(payload(), { signal: aborter.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    aborter.abort()
    await expect(promise).rejects.toBeInstanceOf(LlmAbortError)
  })

  it('退避等待期间暂停：立即中止、不继续重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }))
    const sleep = vi.fn(
      (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new LlmAbortError())
            return
          }
          signal?.addEventListener('abort', () => reject(new LlmAbortError()))
        })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep })
    const aborter = new AbortController()
    const promise = client.completeJson(payload(), { signal: aborter.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    aborter.abort()
    await expect(promise).rejects.toBeInstanceOf(LlmAbortError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('空 content / 非法 JSON / 坏响应体都按 LlmParseError 处理且不重试', async () => {
    for (const response of [
      okResponse(''),
      okResponse('not-json'),
      new Response('not-json-body', { status: 200 })
    ]) {
      const fetchImpl = vi.fn(async () => response)
      const client = makeClient(fetchImpl as unknown as typeof fetch)
      await expect(client.completeJson(payload())).rejects.toBeInstanceOf(LlmParseError)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('usage 缺失时记 0', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{}', {}))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.completeJson(payload())
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
