/**
 * 问记忆 · 会话只追加（D64）
 *
 * 守四件事：
 * 1. 同一会话第二问的消息序列 = 第一问 + 追加，前面逐字节不变（前缀缓存的前提）；
 * 2. 工具轮（assistant tool_calls / tool 结果 / reasoning）也进会话，下一问原样重放；
 * 3. system 不随时间 / 数据边界变化（动态事实在 <now> 里）；
 * 4. 超预算时只裁最旧的轮次，压成 digest，最新几轮保留全文。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import {
  appendAskConversationTurn,
  emptyAskConversation,
  type CloudAskConversationTurn
} from '../../src/chain/agent/conversation'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import { createAskConversationStore } from '../../src/main/ask-conversation'
import { buildChainAskLoopMessages } from '../../src/understand/cloud/deepseek'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'

const NOW = new Date(2026, 9, 30, 14, 0, 0, 0).getTime()

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

/** 两问之间只换问题（同一个 db / store） */
async function ask(store: ReturnType<typeof createAskConversationStore>, client: FakeLlmClient, question: string) {
  return askChain(
    {
      db,
      outbound: createLocalAskOutbound(),
      resolveClient: () => ({ ok: true, client }),
      now: () => NOW,
      captureRunning: () => false,
      canSend: () => true,
      conversation: store
    },
    question
  )
}

describe('只追加：消息前缀稳定', () => {
  it('第二问 = 第一问的消息 + assistant 答复 + 第二问；system 与 <now> 都在', async () => {
    const store = createAskConversationStore()
    const client = new FakeLlmClient([{ json: '第一答' }, { json: '第二答' }])
    await ask(store, client, '第一问')
    await ask(store, client, '第二问')

    expect(client.askLoopRequests).toHaveLength(2)
    const first = buildChainAskLoopMessages(client.askLoopRequests[0]!)
    const second = buildChainAskLoopMessages(client.askLoopRequests[1]!)

    // 第一问的请求（system / user）是第二问消息的严格前缀
    expect(second.slice(0, first.length)).toEqual(first)
    // 前缀之后紧接着就是上一问的 assistant 答复
    expect(second[first.length]).toMatchObject({ role: 'assistant', content: '第一答' })
    // 第二问自己的 user（问题 + <now>）在最后
    expect(second[second.length - 1]).toMatchObject({ role: 'user' })
    expect(second[second.length - 1]?.content).toContain('<now>')
    // 不能出现连续 user（DeepSeek reasoner 会 400）
    for (let index = 1; index < second.length; index += 1) {
      expect(`${second[index - 1]?.role}->${second[index]?.role}`).not.toBe('user->user')
    }

    // system 逐字节相同（动态时间只在 <now> 里）
    expect(second[0]?.content).toBe(first[0]?.content)
    expect(second[0]?.content).not.toContain('2026-10-30')
  })

  it('工具轮也进会话：下一问重放 assistant tool_calls / tool 结果 / reasoning', async () => {
    const store = createAskConversationStore()
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'get_freshness', arguments: {} }], reasoning: '先看看数据边界。' },
      { json: '第一答' },
      { json: '第二答' }
    ])
    await ask(store, client, '第一问')
    await ask(store, client, '第二问')

    // 第一问有两轮请求（工具轮 + 收尾轮），第二问是第 3 条
    expect(client.askLoopRequests).toHaveLength(3)
    const first = buildChainAskLoopMessages(client.askLoopRequests[0]!)
    const second = buildChainAskLoopMessages(client.askLoopRequests[2]!)
    // 第一问第一轮（system + user）仍是前缀
    expect(second.slice(0, first.length)).toEqual(first)
    // 前缀后是上一问的工具轮
    const assistant = second[first.length]
    expect(assistant).toMatchObject({ role: 'assistant' })
    expect(assistant?.toolCalls?.[0]?.name).toBe('get_freshness')
    expect(assistant?.reasoningContent).toBe('先看看数据边界。')
    expect(second[first.length + 1]).toMatchObject({ role: 'tool' })
    expect(second[first.length + 2]).toMatchObject({ role: 'assistant', content: '第一答' })
  })

  it('会话里有工具轮时不再用 history 播种（不重复上一问）', async () => {
    const store = createAskConversationStore()
    const client = new FakeLlmClient([{ json: '第一答' }, { json: '第二答' }])
    await ask(store, client, '第一问')
    await ask(store, client, '第二问')
    const second = client.askLoopRequests[1]!
    // 会话 1 轮 + 本轮；history 不参与（payload 里 conversation 优先）
    expect(second.conversation).toHaveLength(1)
    expect(second.conversation?.[0]?.answer).toBe('第一答')
  })
})

describe('只追加：裁剪与摘要', () => {
  const turn = (index: number): CloudAskConversationTurn => ({
    question: `问 ${index} ${'q'.repeat(40)}`,
    now: '当前时间：x',
    turns: [],
    answer: `答 ${index} ${'a'.repeat(80)}`
  })

  it('超预算只裁最旧的，最近几轮保留全文；被裁的压进 digest', () => {
    let conversation = emptyAskConversation()
    for (let index = 0; index < 6; index += 1) {
      conversation = appendAskConversationTurn(conversation, turn(index), {
        maxChars: 400,
        keepTurns: 2
      })
    }
    expect(conversation.turns).toHaveLength(2)
    expect(conversation.turns.map((item) => item.answer)).toEqual([
      expect.stringContaining('答 4'),
      expect.stringContaining('答 5')
    ])
    expect(conversation.digest).toContain('问 0')
    expect(conversation.digest).toContain('答 0')
  })

  it('digest 挂在 system 尾部（不单独发 user，避免连续 user）', () => {
    const client = new FakeLlmClient([{ json: '答' }])
    const store = createAskConversationStore()
    store.save({ digest: '- 问：旧问题 → 答：旧回答', turns: [] })
    return ask(store, client, '新问题').then(() => {
      const messages = buildChainAskLoopMessages(client.askLoopRequests[0]!)
      expect(messages[0]?.role).toBe('system')
      expect(messages[0]?.content).toContain('<archived_session_summary>')
      expect(messages[0]?.content).toContain('问：旧问题')
      expect(messages[1]).toMatchObject({ role: 'user' })
    })
  })
})
