import { describe, expect, it, vi } from 'vitest'
import {
  buildCloudPayload,
  buildThemeAssignmentPayload,
  buildThemeNamingPayload
} from '../../src/understand/cloud/redact'
import { LLM_DEFAULTS } from '../../src/understand/cloud/constants'
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
  usage: { prompt_tokens?: number; completion_tokens?: number } = { prompt_tokens: 10, completion_tokens: 4 },
  finishReason: string | null = null
): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }], usage }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  )
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
      events: Array<{ event_ids: number[]; app: string; title: string; ocr: string }>
    }
    expect(userContent.events.map((e) => e.event_ids[0])).toEqual([1, 2])
    expect(userContent.events[0]).toEqual({
      event_ids: [1],
      ts: 1_700_000_000_000,
      ts_end: 1_700_000_000_000,
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

  it('DeepSeek 端点显式关闭 thinking：V4 默认 CoT 会先吃满 max_tokens，正文为空', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('{"nodes":[]}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await client.completeJson(payload())
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('非 DeepSeek 端点不发送 thinking 字段（避免严格网关因未知参数 400）', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('{"nodes":[]}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      baseUrl: 'http://127.0.0.1:8000/v1'
    })
    await client.completeJson(payload())
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('thinking')
  })

  it('finish_reason=length 的空 content 报「max_tokens 截断」并带当前上限与 usage', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse('', { prompt_tokens: 100, completion_tokens: 512 }, 'length')
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const error = await client
      .completeJson(payload(), { maxTokens: 512 })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LlmParseError)
    expect((error as Error).message).toContain('max_tokens（512）')
    expect((error as Error).message).toContain('截断')
    expect((error as LlmParseError).usage).toEqual({ promptTokens: 100, completionTokens: 512 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('finish_reason=length 的残缺 JSON 报截断，而不是笼统的「不是合法 JSON」', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"nodes":[{"title":"未写完', undefined, 'length'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const error = await client.completeJson(payload()).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LlmParseError)
    expect((error as Error).message).toContain('截断')
  })

  it('非截断的非法 JSON 报长度与 finish_reason（不泄露正文）', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse('not-json', { prompt_tokens: 7, completion_tokens: 9 }, 'stop')
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const error = await client.completeJson(payload()).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LlmParseError)
    expect((error as Error).message).toContain('长度 8')
    expect((error as Error).message).toContain('finish_reason=stop')
    expect((error as Error).message).not.toContain('not-json')
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

  it('解析失败（空 content / 非法 JSON）的 LlmParseError 携带已消耗 usage（F03：失败也要能记账）', async () => {
    for (const response of [okResponse(''), okResponse('not-json')]) {
      const fetchImpl = vi.fn(async () => response)
      const client = makeClient(fetchImpl as unknown as typeof fetch)
      const error = await client.completeJson(payload()).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(LlmParseError)
      expect((error as LlmParseError).usage).toEqual({ promptTokens: 10, completionTokens: 4 })
    }
    // 响应体本身不是 JSON（不是合法 ChatCompletionResponse）时没有可用 usage，不伪造
    const fetchImpl = vi.fn(async () => new Response('not-json-body', { status: 200 }))
    const error = await makeClient(fetchImpl as unknown as typeof fetch)
      .completeJson(payload())
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LlmParseError)
    expect((error as LlmParseError).usage).toBeUndefined()
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

describe('P2 在线路径请求 · 新主题命名 / 模糊确认（S4）', () => {
  function namingPayload() {
    return buildThemeNamingPayload([
      {
        app: 'chrome.exe',
        title: '页面',
        startTs: 1_700_000_000_000,
        endTs: 1_700_000_060_000,
        ocr: '内容',
        eventIds: [1, 2]
      }
    ]).payload
  }

  function assignmentPayload() {
    return buildThemeAssignmentPayload(
      [
        {
          momentId: 7,
          app: 'chrome.exe',
          title: '页面',
          ocr: '内容',
          candidateThemeIds: [1, 2]
        }
      ],
      [
        { id: 1, title: '主题一', summary: '摘要一' },
        { id: 2, title: '主题二', summary: '摘要二' }
      ]
    ).payload
  }

  it('命名请求：system 是命名契约，用户消息是脱敏时刻，prompt 与归纳路径不串线', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse('{"title":"Rust","summary":"学习笔记","type":"knowledge"}')
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.completeNaming(namingPayload(), {
      maxTokens: LLM_DEFAULTS.namingMaxTokens
    })

    expect(result.json).toEqual({ title: 'Rust', summary: '学习笔记', type: 'knowledge' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
      max_tokens: number
    }
    expect(body.max_tokens).toBe(LLM_DEFAULTS.namingMaxTokens)
    expect(body.messages[0].content).toContain('主题命名器')
    expect(body.messages[0].content).not.toContain('归纳器')
    const user = JSON.parse(body.messages[1].content) as {
      moments: Array<{ event_ids: number[]; app: string }>
    }
    expect(user.moments[0].event_ids).toEqual([1, 2])
    expect(user.moments[0].app).toBe('chrome.exe')
  })

  it('模糊确认请求：时刻带候选 id、主题标题摘要原样进 prompt（模型只能从候选里挑）', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"assignments":[{"moment_id":7,"theme_ids":[1]}]}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.completeAssignments(assignmentPayload(), {
      maxTokens: LLM_DEFAULTS.assignmentMaxTokens
    })

    expect(result.json).toEqual({ assignments: [{ moment_id: 7, theme_ids: [1] }] })
    const [_url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[0].content).toContain('主题归属确认器')
    const user = JSON.parse(body.messages[1].content) as {
      themes: Array<{ theme_id: number; title: string; summary: string }>
      moments: Array<{
        moment_id: number
        app: string
        title: string
        ocr: string
        candidate_theme_ids: number[]
      }>
    }
    expect(user.themes).toEqual([
      { theme_id: 1, title: '主题一', summary: '摘要一' },
      { theme_id: 2, title: '主题二', summary: '摘要二' }
    ])
    expect(user.moments[0]).toEqual({
      moment_id: 7,
      app: 'chrome.exe',
      title: '页面',
      ocr: '内容',
      candidate_theme_ids: [1, 2]
    })
  })
})
