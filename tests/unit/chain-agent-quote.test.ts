/**
 * QQ 引用工具与载荷（D96 / PR1）
 *
 * 守五件事：`quote_message` 只认短号、唯一一次、取不到给最近短号；
 * 选中后真实 QQ id 挂到最终结果（replyTo）；引用 / 最近聊天进用户消息 JSON；
 * 会话回放时字节一致；截断与 missing 口径。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import type { QuoteMessageLookup } from '../../src/chain/agent/tools'
import { buildChainAskLoopMessages, askLoopToolsFor } from '../../src/understand/cloud/deepseek'
import { FakeLlmClient, type LlmClient } from '../../src/understand/cloud/llm-client'

const NOW = new Date(2026, 10, 1, 21, 0, 0, 0).getTime()

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function buildDeps(client: LlmClient, extra: Partial<ChainAskOptions> = {}): ChainAskOptions {
  return {
    db,
    outbound: createLocalAskOutbound(),
    resolveClient: () => ({ ok: true, client }),
    now: () => NOW,
    captureRunning: () => false,
    ...extra
  }
}

const TARGET = {
  id: 3,
  from: 'user' as const,
  text: '用户之前问的那句话',
  qqId: 1234567890
}

function lookupOf(target: typeof TARGET | null, recent: number[] = [1, 2, 3]): QuoteMessageLookup {
  return target === null ? { recent } : { target, recent }
}

describe('quote_message 工具（D96）', () => {
  it('按短号引用成功：工具结果回原话，最终结果带 replyTo（真实 QQ id）', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'quote_message', arguments: { id: '#3' } }] },
      { json: { answer: '我引用了那句。', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, {
        tools: ['quote_message'],
        quoteMessage: () => lookupOf(TARGET)
      }),
      '这是啥意思'
    )

    expect(result.kind).toBe('answer')
    expect(result.replyTo).toBe(1234567890)
    // 工具轮里给模型看的是短号 + 原话，不是 QQ 哈希 id
    const turn = client.askLoopRequests[1]?.turns[0]
    expect(turn?.toolCall.name).toBe('quote_message')
    expect(turn?.toolResult).toMatchObject({
      kind: 'quote_message',
      id: 3,
      from: 'user',
      text: '用户之前问的那句话',
      ok: true
    })
    // tools 参数里有这个 QQ 专属工具
    expect(client.optionCalls[0]?.toolElements).toContain('quote_message')
  })

  it('一轮只认一次：第二次引用给错误，但第一次的 replyTo 仍生效', async () => {
    const client = new FakeLlmClient([
      {
        toolCalls: [
          { name: 'quote_message', arguments: { id: '3' } },
          { name: 'quote_message', arguments: { id: '2' } }
        ]
      },
      { json: { answer: '引用了。', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, { tools: ['quote_message'], quoteMessage: () => lookupOf(TARGET) }),
      '看看'
    )
    expect(result.replyTo).toBe(1234567890)
    const second = client.askLoopRequests[1]?.turns[1]
    expect(second?.toolResult).toMatchObject({ kind: 'error' })
    expect(String((second?.toolResult as { message?: string }).message)).toContain('已经引用过')
  })

  it('短号不存在：错误里给最近可用的几个，不猜内容', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'quote_message', arguments: { id: '99' } }] },
      { json: { answer: '那条太早了。', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, { tools: ['quote_message'], quoteMessage: () => lookupOf(null) }),
      '引用 99'
    )
    expect(result.kind).toBe('answer')
    expect(result.replyTo).toBeUndefined()
    const message = String(
      (client.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message
    )
    expect(message).toContain('#1')
    expect(message).toContain('#2')
  })

  it('没注入端口：如实回「引用不了」；参数不合法也如实说', async () => {
    const noPort = new FakeLlmClient([
      { toolCalls: [{ name: 'quote_message', arguments: { id: '3' } }] },
      { json: { answer: '这边引用不了。', citations: [] } }
    ])
    await askChain(buildDeps(noPort, { tools: ['quote_message'] }), '引用一下')
    expect(String((noPort.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message)).toContain(
      '引用不了'
    )

    const badArg = new FakeLlmClient([
      { toolCalls: [{ name: 'quote_message', arguments: { id: 'abc' } }] },
      { json: { answer: '短号不对。', citations: [] } }
    ])
    await askChain(
      buildDeps(badArg, { tools: ['quote_message'], quoteMessage: () => lookupOf(TARGET) }),
      '引用一下'
    )
    expect(String((badArg.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message)).toContain(
      '消息短号'
    )
  })

  it('桌面不挂这个工具：默认工具集里没有它', () => {
    const names = askLoopToolsFor().map((tool) => tool.function.name)
    expect(names).not.toContain('quote_message')
  })
})

describe('引用载荷与消息（D96）', () => {
  it('quoted / recent 进用户消息 JSON；system 不变', async () => {
    const client = new FakeLlmClient([{ json: { answer: '嗯。', citations: [] } }])
    await askChain(
      buildDeps(client, {
        tools: ['quote_message'],
        quoted: { id: 3, from: 'user', at: NOW - 60_000, text: '被引用的原话', images: 0 },
        chatRecent: [
          { id: 3, from: 'user', at: NOW - 60_000, text: '被引用的原话' },
          { id: 4, from: 'ta', at: NOW - 30_000, text: '我上次的回答' }
        ]
      }),
      '这是啥意思'
    )
    const payload = client.askLoopRequests[0]
    expect(payload?.quoted).toMatchObject({
      id: 3,
      from: 'user',
      at: NOW - 60_000,
      text: '被引用的原话'
    })
    expect(payload?.chatRecent).toHaveLength(2)

    if (payload === undefined) throw new Error('没有载荷')
    const messages = buildChainAskLoopMessages(payload, {}, undefined, undefined, ['quote_message'])
    // user 消息 = JSON 问题 + 空行 + `<now>`：只取 JSON 那一段
    const user = JSON.parse(String(messages[1]?.content).split('\n\n')[0] ?? '{}') as Record<
      string,
      unknown
    >
    expect(user['quoted']).toMatchObject({ id: 3, text: '被引用的原话' })
    expect(user['recent']).toHaveLength(2)
  })

  it('取不到原话：只给 id + missing，不写正文', async () => {
    const client = new FakeLlmClient([{ json: { answer: '取不到。', citations: [] } }])
    await askChain(
      buildDeps(client, {
        tools: ['quote_message'],
        quoted: { id: 7, from: 'user', at: 0, text: '', missing: true }
      }),
      '引用一下'
    )
    expect(client.askLoopRequests[0]?.quoted).toEqual({
      id: 7,
      from: 'user',
      at: 0,
      text: '',
      missing: true
    })
  })

  it('原话过长截到 300 字、最近聊天单条 80 字（超出加省略号）', async () => {
    const client = new FakeLlmClient([{ json: { answer: '嗯。', citations: [] } }])
    await askChain(
      buildDeps(client, {
        tools: ['quote_message'],
        quoted: { id: 1, from: 'ta', at: NOW, text: '长'.repeat(400), images: 0 },
        chatRecent: [{ id: 1, from: 'ta', at: NOW, text: '短'.repeat(200) }]
      }),
      '看'
    )
    const payload = client.askLoopRequests[0]
    expect(Array.from(payload?.quoted?.text ?? '')).toHaveLength(300)
    expect(Array.from(payload?.chatRecent?.[0]?.text ?? '')).toHaveLength(80)
    expect(payload?.quoted?.text.endsWith('…')).toBe(true)
    expect(payload?.chatRecent?.[0]?.text.endsWith('…')).toBe(true)
  })

  it('会话回放：上一轮的 quoted 原样进消息，字节一致', () => {
    const client = new FakeLlmClient([])
    void client
    const payload = {
      question: '这一问',
      systemTime: '2026-11-01 21:00',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      history: [],
      now: '',
      conversation: [
        {
          question: '上一问',
          now: '',
          turns: [],
          answer: '上一答',
          quoted: { id: 2, from: 'user' as const, at: NOW, text: '上一轮的引用', images: 0 },
          chatRecent: [{ id: 2, from: 'user' as const, at: NOW, text: '上一轮的引用' }]
        }
      ]
    }
    const messages = buildChainAskLoopMessages(
      payload as unknown as Parameters<typeof buildChainAskLoopMessages>[0],
      {},
      undefined,
      undefined,
      ['quote_message']
    )
    const replayed = JSON.parse(String(messages[1]?.content)) as Record<string, unknown>
    expect(replayed['quoted']).toMatchObject({ id: 2, text: '上一轮的引用' })
    expect(replayed['recent']).toEqual([{ id: 2, from: 'user', at: NOW, text: '上一轮的引用' }])
  })
})
