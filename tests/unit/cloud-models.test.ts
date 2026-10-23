import { describe, expect, it } from 'vitest'
import { extractModelIds, fetchProviderModels } from '../../src/understand/cloud/models'

interface FetchCall {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('extractModelIds', () => {
  it('兼容 OpenAI data[].id、网关 models[] 与字符串数组，去重排序', () => {
    expect(
      extractModelIds({
        object: 'list',
        data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }]
      })
    ).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(extractModelIds({ models: ['b', 'a'] })).toEqual(['a', 'b'])
    expect(extractModelIds(['z', { model: 'm' }, { name: '' }, 42])).toEqual(['m', 'z'])
  })

  it('无法识别的载荷返回空列表（不抛错）', () => {
    expect(extractModelIds(null)).toEqual([])
    expect(extractModelIds({ data: 'nope' })).toEqual([])
    expect(extractModelIds({ data: [{}] })).toEqual([])
  })
})

describe('fetchProviderModels', () => {
  it('请求 {baseUrl}/models，带 Bearer 头、禁止重定向，返回模型清单', async () => {
    const calls: FetchCall[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] })
    }) as unknown as typeof fetch

    const result = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-secret',
      fetchImpl
    })
    expect(result).toEqual({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.deepseek.com/models')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret')
    expect(calls[0].init.redirect).toBe('error')
    // 密钥只在 Authorization 头里，不拼进 URL
    expect(calls[0].url).not.toContain('sk-secret')
  })

  it('HTTP 错误映射为可读原因，且不回显密钥', async () => {
    const make = (status: number) =>
      fetchProviderModels({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-secret',
        fetchImpl: (async () => jsonResponse({}, status)) as unknown as typeof fetch
      })

    const unauthorized = await make(401)
    expect(unauthorized).toEqual({ ok: false, error: 'API Key 无效或已过期（HTTP 401）' })
    expect((unauthorized as { error: string }).error).not.toContain('sk-secret')

    expect(await make(404)).toMatchObject({ ok: false, error: '该供应商不支持 /models（HTTP 404），可手动填写模型名' })
    expect(await make(429)).toMatchObject({ ok: false })
    expect(await make(503)).toEqual({ ok: false, error: '供应商服务异常（HTTP 503）' })
  })

  it('非法 JSON / 空模型列表给出提示', async () => {
    const invalidJson = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret',
      fetchImpl: (async () => new Response('not-json')) as unknown as typeof fetch
    })
    expect(invalidJson).toEqual({ ok: false, error: '供应商返回的不是合法 JSON' })

    const empty = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret',
      fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch
    })
    expect(empty).toEqual({ ok: false, error: '供应商没有返回可用模型，可手动填写模型名' })
  })

  it('参数前置校验：baseUrl 只允许 https / 本机 http，密钥必填', async () => {
    const noFetch = (async () => {
      throw new Error('不应发起请求')
    }) as unknown as typeof fetch
    expect(await fetchProviderModels({ baseUrl: 'http://evil.example.com', apiKey: 'k', fetchImpl: noFetch })).toEqual({
      ok: false,
      error: 'Base URL 不合法（仅 https 或本机 http）'
    })
    expect(await fetchProviderModels({ baseUrl: 'https://api.deepseek.com', apiKey: '  ', fetchImpl: noFetch })).toEqual({
      ok: false,
      error: '请先填写 API Key'
    })
  })

  it('超时与网络错误不泄露底层异常文本', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted by test')))
      })) as unknown as typeof fetch
    const timeout = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret',
      timeoutMs: 20,
      fetchImpl: hang
    })
    expect(timeout).toEqual({ ok: false, error: '请求超时（20 毫秒）' })

    const network = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    })
    expect(network).toEqual({ ok: false, error: '无法连接供应商（网络错误）' })
  })
})
