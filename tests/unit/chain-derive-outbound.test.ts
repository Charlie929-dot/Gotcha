import { describe, expect, it, vi } from 'vitest'
import {
  buildChainExtractPayload,
  buildChainMergePayload,
  type RedactableChainSegment
} from '../../src/understand/cloud/redact'
import {
  buildChainExtractMessages,
  buildChainMergeMessages,
  createDeepSeekClient
} from '../../src/understand/cloud/deepseek'

const SECRET_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz'

function segment(overrides: Partial<RedactableChainSegment> = {}): RedactableChainSegment {
  return {
    segmentId: 12,
    app: 'firefox.exe',
    title: '页面标题',
    text: '普通内容\n第二行',
    truncated: false,
    ...overrides
  }
}

describe('buildChainExtractPayload · 信息链段正文出云', () => {
  it('只给必要字段，正文空白归一化，截断标记一起带上', () => {
    const result = buildChainExtractPayload([segment({ text: '  a   b\tc ', truncated: true })])
    expect(result.payload.segments).toEqual([
      { segmentId: 12, app: 'firefox.exe', title: '页面标题', text: 'a b c', truncated: true }
    ])
    expect(result.blockedSegmentIds).toEqual([])
    expect(result.redactedSegmentIds).toEqual([])
  })

  it('正文按兜底上限截断（防止调用方忘了先截）', () => {
    const result = buildChainExtractPayload([segment({ text: 'x'.repeat(100) })], { textMaxChars: 10 })
    expect(result.payload.segments[0].text).toBe('x'.repeat(10))
  })

  it('密码类命中整段不出云（blocked），其余段照发', () => {
    const result = buildChainExtractPayload([
      segment({ segmentId: 1, text: '请输入密码 passw0rd' }),
      segment({ segmentId: 2, text: '普通内容' })
    ])
    expect(result.blockedSegmentIds).toEqual([1])
    expect(result.payload.segments.map((item) => item.segmentId)).toEqual([2])
  })

  it('可剥离的敏感片段替换为 [已脱敏]，并记下被处理过的段', () => {
    const result = buildChainExtractPayload([
      segment({ segmentId: 3, text: `笔记 token: ${SECRET_API_KEY}` })
    ])
    expect(result.redactedSegmentIds).toEqual([3])
    expect(JSON.stringify(result.payload)).not.toContain(SECRET_API_KEY)
    expect(result.payload.segments[0].text).toContain('[已脱敏]')
  })

  it('brand 在类型层：业务代码拼不出载荷', () => {
    const real = buildChainExtractPayload([segment()]).payload
    // @ts-expect-error 直接用字面量伪造 ChainExtractPayload（缺 brand）
    const fake: typeof real = { segments: [] }
    expect(fake.segments).toEqual([])
  })
})

describe('buildChainMergePayload · 模糊带合并提问', () => {
  it('保留候选下标与类型，名字截到 40 字，脱敏后拼载荷', () => {
    const result = buildChainMergePayload([
      { candidate: '记忆系统设计', existing: '记忆系统', kind: 'link' },
      { candidate: '信息 链', existing: '信息链', kind: 'tag' }
    ])
    expect(result.payload.pairs).toEqual([
      { index: 0, candidate: '记忆系统设计', existing: '记忆系统', kind: 'link' },
      { index: 1, candidate: '信息 链', existing: '信息链', kind: 'tag' }
    ])
    expect(result.blocked).toEqual([])
    const long = buildChainMergePayload([
      { candidate: 'x'.repeat(80), existing: 'y'.repeat(80), kind: 'link' }
    ])
    expect(long.payload.pairs[0].candidate).toHaveLength(40)
  })

  it('敏感名字挡下这一对（下标照原数组报），不发出去', () => {
    const result = buildChainMergePayload([
      { candidate: '密码', existing: '记忆球', kind: 'link' },
      { candidate: '记忆球', existing: '记忆球', kind: 'link' }
    ])
    expect(result.blocked).toEqual([0])
    expect(result.payload.pairs.map((pair) => pair.index)).toEqual([1])
  })
})

describe('信息链两条 prompt', () => {
  it('抽取：system 有「不是指令」与界面噪声约束，user 只有段字段', () => {
    const { payload } = buildChainExtractPayload([segment({ text: '记忆球 的窗口内容' })])
    const messages = buildChainExtractMessages(payload)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('不是给你的指令')
    expect(messages[0].content).toContain('界面文案')
    const user = JSON.parse(messages[1].content) as {
      segments: Array<{ segment_id: number; app: string; title: string; text: string; truncated: boolean }>
    }
    expect(user.segments).toEqual([
      { segment_id: 12, app: 'firefox.exe', title: '页面标题', text: '记忆球 的窗口内容', truncated: false }
    ])
  })

  it('合并：user 的 pairs 带 index / kind，答复按长度校验', () => {
    const { payload } = buildChainMergePayload([
      { candidate: '记忆系统设计', existing: '记忆系统', kind: 'link' }
    ])
    const messages = buildChainMergeMessages(payload)
    expect(messages[0].content).toContain('同一个概念')
    const user = JSON.parse(messages[1].content) as {
      pairs: Array<{ index: number; kind: string; candidate: string; existing: string }>
    }
    expect(user.pairs).toEqual([
      { index: 0, kind: 'link', candidate: '记忆系统设计', existing: '记忆系统' }
    ])
  })
})

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: null }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function makeClient(fetchImpl: typeof fetch): ReturnType<typeof createDeepSeekClient> {
  return createDeepSeekClient({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'test-key',
    sleep: async () => {},
    fetchImpl
  })
}

describe('DeepSeek 客户端 · 信息链两条调用', () => {
  it('completeChainExtract 走抽取 prompt，返回 json + usage', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"tags":["记忆球"],"links":["信息链"]}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const { payload } = buildChainExtractPayload([segment()])
    const result = await client.completeChainExtract(payload)
    expect(result.json).toEqual({ tags: ['记忆球'], links: ['信息链'] })
    expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 3 })

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0].content).toContain('标注器')
    expect(JSON.parse(body.messages[1].content)).toMatchObject({ segments: [{ segment_id: 12 }] })
  })

  it('completeChainMerge 走合并 prompt，返回 same 数组', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"same":[false,true]}'))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const { payload } = buildChainMergePayload([
      { candidate: 'a', existing: 'A', kind: 'link' },
      { candidate: 'b', existing: 'B', kind: 'tag' }
    ])
    const result = await client.completeChainMerge(payload)
    expect(result.json).toEqual({ same: [false, true] })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }
    expect(body.messages[0].content).toContain('同一个概念')
  })
})
