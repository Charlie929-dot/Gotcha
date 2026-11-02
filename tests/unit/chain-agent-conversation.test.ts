/**
 * 问记忆 · 会话只追加（D64 / M3 D69）
 *
 * 守四件事：
 * 1. 同一会话第二问的消息序列 = 第一问 + 追加，前面逐字节不变（前缀缓存的前提）；
 * 2. 工具轮（assistant tool_calls / tool 结果 / reasoning）也进会话，下一问原样重放；
 * 3. system 不随时间 / 数据边界变化（动态事实在 <now> 里）；
 * 4. **不再自动裁剪**（M3 / D69）：超预算也照常追加；旧轮只在 `/compact` 时压成摘要。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import { archiveIdOfImage, archiveIdOfText } from '../../src/chain/agent/archive'
import {
  appendAskConversationTurn,
  askConversationSentChars,
  compactAskConversation,
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

describe('图片：只有压缩才删', () => {
  const TINY =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  const turnWithImage = (index: number): CloudAskConversationTurn => ({
    question: `问 ${index}`,
    now: '当前时间：2026-10-30 14:00 周五',
    turns: [],
    answer: `答 ${index}`,
    attachments: { images: [TINY], files: [] }
  })

  function payloadWith(conversation: readonly CloudAskConversationTurn[]) {
    const { payload } = createLocalAskOutbound().buildLoop({
      question: '再问',
      systemTime: '2026-10-30 14:00 周五',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      conversation
    })
    return payload
  }

  it('用户附件图片：仓里留着，下一问的上下文里换成占位符（D88）', () => {
    const id = archiveIdOfImage(TINY)
    expect(id).not.toBeNull()
    const conversation = appendAskConversationTurn(emptyAskConversation(), turnWithImage(0))
    // 存储层照旧保留原图（recall / /log 要用）
    expect(conversation.turns[0]?.attachments?.images).toEqual([TINY])
    const messages = buildChainAskLoopMessages(payloadWith(conversation.turns))
    const first = messages[1]
    expect(first).toMatchObject({ role: 'user' })
    expect(first?.images).toBeUndefined()
    expect(String(first?.content)).toContain(`#${id}`)
    expect(String(first?.content)).toContain('recall')
  })

  it('工具截图（read_segment）同样归档：不再原样重发，只留占位符（D88）', () => {
    const id = archiveIdOfImage(TINY)
    const turn: CloudAskConversationTurn = {
      question: '看图',
      now: '',
      turns: [
        {
          toolCall: { name: 'get_freshness', arguments: {} },
          toolResult: {
            kind: 'get_freshness',
            freshness: { latestEvidenceTs: null, captureRunning: false }
          },
          images: [TINY]
        }
      ],
      answer: '看到'
    }
    const conversation = appendAskConversationTurn(emptyAskConversation(), turn)
    expect(conversation.turns[0]?.turns[0]?.images).toEqual([TINY])
    const messages = buildChainAskLoopMessages(payloadWith(conversation.turns))
    expect(messages.some((message) => message.images?.includes(TINY))).toBe(false)
    const placeholder = messages.find((message) => String(message.content).includes(`#${id}`))
    expect(placeholder).toMatchObject({ role: 'user' })
  })

  it('没超预算：图片一张都不删', () => {
    const conversation = appendAskConversationTurn(emptyAskConversation(), turnWithImage(0), {
      maxChars: 1_000_000,
      keepTurns: 8
    })
    expect(conversation.turns[0]?.attachments?.images).toEqual([TINY])
  })

  it('askChain 的附件图片进会话；下一问上下文里只留占位符（D88）', async () => {
    const store = createAskConversationStore()
    const client = new FakeLlmClient([{ json: '第一答' }, { json: '第二答' }])
    await askChain(
      {
        db,
        outbound: createLocalAskOutbound(),
        resolveClient: () => ({ ok: true, client }),
        now: () => NOW,
        captureRunning: () => false,
        canSend: () => true,
        conversation: store,
        attachments: { images: [TINY] }
      },
      '看图'
    )
    await ask(store, client, '第二问')
    expect(client.askLoopRequests[0]?.attachments?.images).toEqual([TINY])
    const second = buildChainAskLoopMessages(client.askLoopRequests[1]!)
    expect(second.some((message) => message.images?.includes(TINY))).toBe(false)
    expect(second.some((message) => String(message.content).includes('已归档'))).toBe(true)
  })

  it('recall：按上一问占位符里的 id 取回原图；没见过的 id 如实拒绝（D88）', async () => {
    const store = createAskConversationStore()
    const id = archiveIdOfImage(TINY)
    expect(id).not.toBeNull()
    const client = new FakeLlmClient([{ json: '第一答' }])
    await askChain(
      {
        db,
        outbound: createLocalAskOutbound(),
        resolveClient: () => ({ ok: true, client }),
        now: () => NOW,
        captureRunning: () => false,
        canSend: () => true,
        conversation: store,
        attachments: { images: [TINY] }
      },
      '看图'
    )

    // 第二问：先换个不存在的 id，再按真 id 取回
    client.push({ toolCalls: [{ name: 'recall', arguments: { id: 'deadbeef' } }] })
    client.push({ toolCalls: [{ name: 'recall', arguments: { id } }] })
    client.push({ json: '想起来了' })
    const result = await ask(store, client, '刚才那张图什么颜色')
    expect(result.kind).toBe('answer')

    const recalled = client.askLoopRequests.at(-1)!
    expect(recalled.turns[0]?.toolResult.kind).toBe('error')
    expect(recalled.turns[1]?.toolResult.kind).toBe('recall')
    // 图跟着工具轮挂回来（DeepSeek 只允许 user 消息带图）
    expect(recalled.turns[1]?.images?.[0]).toBe(TINY)
  })

  it('带图的一问：onUsage 的 meta.images 记下张数（D88 生命不记账的依据）', async () => {
    const seen: { images: number }[] = []
    const client = new FakeLlmClient([{ json: '答' }])
    const deps = {
      db,
      outbound: createLocalAskOutbound(),
      resolveClient: () => ({ ok: true, client }),
      now: () => NOW,
      captureRunning: () => false,
      canSend: () => true,
      onUsage: (_usage: { promptTokens: number; completionTokens: number }, meta: { images: number }) =>
        seen.push(meta)
    }
    await askChain({ ...deps, attachments: { images: [TINY] } }, '看图')
    await askChain(deps, '只问字')
    expect(seen).toEqual([{ images: 1 }, { images: 0 }])
  })

  it('压缩（/compact）：所有轮次都留着，图片一张都不删（D97）', () => {
    let conversation = appendAskConversationTurn(emptyAskConversation(), turnWithImage(0))
    conversation = appendAskConversationTurn(conversation, turnWithImage(1))
    const compacted = compactAskConversation(conversation)
    // 不删轮：轮数不变，原文也还在存储里（图 / 答复都在）
    expect(compacted.conversation.turns).toHaveLength(2)
    expect(compacted.conversation.turns[0]?.attachments?.images).toEqual([TINY])
    expect(compacted.conversation.turns[0]?.answer).toBe('答 0')
    expect(compacted.conversation.compactedTurns).toBe(2)
  })
})

describe('只追加：不自动裁剪（M3 / D69）', () => {
  const turn = (index: number): CloudAskConversationTurn => ({
    question: `问 ${index} ${'q'.repeat(40)}`,
    now: '当前时间：x',
    turns: [],
    answer: `答 ${index} ${'a'.repeat(80)}`
  })

  it('超预算也不自动丢轮，digest 不动（旧轮留给 /compact）', () => {
    let conversation = emptyAskConversation()
    for (let index = 0; index < 6; index += 1) {
      conversation = appendAskConversationTurn(conversation, turn(index), {
        maxChars: 400,
        keepTurns: 2
      })
    }
    expect(conversation.turns).toHaveLength(6)
    expect(conversation.turns.map((item) => item.answer)).toEqual(
      Array.from({ length: 6 }, (_, index) => expect.stringContaining(`答 ${index}`))
    )
    expect(conversation.digest).toBe('')
  })

  it('/compact 覆盖所有轮次：不删轮、不写摘要、超长正文只换占位符（D97）', () => {
    const long = (index: number): CloudAskConversationTurn => ({
      question: `问 ${index} ${'q'.repeat(400)}`,
      now: '当前时间：x',
      turns: [],
      answer: `答 ${index} ${'a'.repeat(800)}`
    })
    let conversation = emptyAskConversation()
    for (let index = 0; index < 6; index += 1) {
      conversation = appendAskConversationTurn(conversation, long(index))
    }
    const before = askConversationSentChars(conversation)
    const compacted = compactAskConversation(conversation)

    // 所有轮次都参与：前 6 轮全被覆盖，轮数与原文都没变
    expect(compacted.covered).toBe(6)
    expect(compacted.placeheld).toBe(12)
    expect(compacted.conversation.turns).toHaveLength(6)
    expect(compacted.conversation.compactedTurns).toBe(6)
    expect(compacted.conversation.turns.map((item) => item.answer)).toEqual(
      Array.from({ length: 6 }, (_, index) => expect.stringContaining(`答 ${index}`))
    )
    // 不再写摘要（digest 只留给老会话）
    expect(compacted.conversation.digest).toBe('')

    // 送云时：每轮的问题 / 答复都换成占位符，字符数明显下降
    const after = askConversationSentChars(compacted.conversation)
    expect(after).toBeLessThan(before / 4)
    const messages = buildChainAskLoopMessages(
      createLocalAskOutbound().buildLoop({
        question: '再问',
        systemTime: '2026-10-30 14:00 周五',
        freshness: { latestEvidenceTs: null, captureRunning: false },
        turns: [],
        conversation: compacted.conversation.turns,
        compactedTurns: compacted.conversation.compactedTurns
      }).payload
    )
    const body = messages.map((message) => String(message.content)).join('\n')
    expect(body).not.toContain('a'.repeat(800))
    expect(body).toContain('已压缩')
    expect(body).toContain('recall')
  })

  it('/compact 幂等：重复压缩不改变轮次、占位口径与送云字节（D97）', () => {
    const long = (index: number): CloudAskConversationTurn => ({
      question: `问 ${index} ${'q'.repeat(400)}`,
      now: 'x',
      turns: [],
      answer: `答 ${index} ${'a'.repeat(400)}`
    })
    let conversation = appendAskConversationTurn(emptyAskConversation(), long(0))
    conversation = appendAskConversationTurn(conversation, long(1))
    const once = compactAskConversation(conversation).conversation
    const twice = compactAskConversation(once)
    expect(twice.covered).toBe(0)
    expect(twice.conversation.turns).toHaveLength(2)
    expect(twice.conversation.compactedTurns).toBe(once.compactedTurns)
    expect(askConversationSentChars(twice.conversation)).toBe(askConversationSentChars(once))

    const payloadOf = (conversation: typeof once) =>
      buildChainAskLoopMessages(
        createLocalAskOutbound().buildLoop({
          question: '再问',
          systemTime: '2026-10-30 14:00 周五',
          freshness: { latestEvidenceTs: null, captureRunning: false },
          turns: [],
          conversation: conversation.turns,
          compactedTurns: conversation.compactedTurns
        }).payload
      )
    // 同样的输入 → 同样的消息（前缀缓存不因再压一次而断）
    expect(payloadOf(twice.conversation)).toEqual(payloadOf(once))
  })

  it('/compact 只换超长正文：短句原样留着（D97）', () => {
    let conversation = appendAskConversationTurn(emptyAskConversation(), {
      question: '在吗',
      now: '',
      turns: [],
      answer: '在'
    })
    conversation = appendAskConversationTurn(conversation, {
      question: '今天改了什么',
      now: '',
      turns: [],
      answer: `${'长'.repeat(500)}`
    })
    const compacted = compactAskConversation(conversation)
    expect(compacted.placeheld).toBe(1)
    const messages = buildChainAskLoopMessages(
      createLocalAskOutbound().buildLoop({
        question: '再说一次',
        systemTime: '2026-10-30 14:00 周五',
        freshness: { latestEvidenceTs: null, captureRunning: false },
        turns: [],
        conversation: compacted.conversation.turns,
        compactedTurns: compacted.conversation.compactedTurns
      }).payload
    )
    const body = messages.map((message) => String(message.content)).join('\n')
    expect(body).toContain('在吗')
    expect(body).toContain('已压缩')
  })

  it('压缩后的问答正文能 recall 回原文；没压缩过的轮次不占位（D97）', async () => {
    const LONG_ANSWER = `这是很长的答复：${'记忆'.repeat(300)}`
    const LONG_QUESTION = `这是很长的问题：${'背景'.repeat(300)}`
    let conversation = emptyAskConversation()
    conversation = appendAskConversationTurn(conversation, {
      question: LONG_QUESTION,
      now: '',
      turns: [],
      answer: LONG_ANSWER
    })
    const compacted = compactAskConversation(conversation).conversation
    const answerId = archiveIdOfText(LONG_ANSWER)
    const questionId = archiveIdOfText(LONG_QUESTION)

    const store = createAskConversationStore()
    store.save(compacted)
    const client = new FakeLlmClient([])
    // 模型照着占位符里的 id 把问题 / 答复原样取回
    client.push({ toolCalls: [{ name: 'recall', arguments: { id: questionId } }] })
    client.push({ toolCalls: [{ name: 'recall', arguments: { id: answerId } }] })
    client.push({ json: '想起来了' })
    const result = await ask(store, client, '刚才那两段原文是什么')
    expect(result.kind).toBe('answer')
    const recalled = client.askLoopRequests.at(-1)!
    expect(recalled.turns[0]?.toolResult).toMatchObject({
      kind: 'recall',
      id: questionId,
      text: LONG_QUESTION
    })
    expect(recalled.turns[1]?.toolResult).toMatchObject({
      kind: 'recall',
      id: answerId,
      text: LONG_ANSWER
    })
    // 模型自己的 recall 轮在上下文里仍是原文（本轮不归档）
    expect(recalled.turns[1]?.toolResult['media']).toBe('tool')
  })

  it('没压过的会话不占位（D97：占位只发生在 /compact 之后的轮次）', () => {
    const conversation = appendAskConversationTurn(emptyAskConversation(), {
      question: `问 ${'q'.repeat(400)}`,
      now: '',
      turns: [],
      answer: `答 ${'a'.repeat(800)}`
    })
    const messages = buildChainAskLoopMessages(
      createLocalAskOutbound().buildLoop({
        question: '再问',
        systemTime: '2026-10-30 14:00 周五',
        freshness: { latestEvidenceTs: null, captureRunning: false },
        turns: [],
        conversation: conversation.turns,
        compactedTurns: conversation.compactedTurns
      }).payload
    )
    const body = messages.map((message) => String(message.content)).join('\n')
    expect(body).toContain('a'.repeat(800))
    expect(body).not.toContain('已压缩')
  })

  it('digest 挂在第一条 user 消息里（system 永不改；没有连续 user）', () => {
    const client = new FakeLlmClient([{ json: '答' }])
    const store = createAskConversationStore()
    store.save({ digest: '- 问：旧问题 → 答：旧回答', turns: [] })
    return ask(store, client, '新问题').then(() => {
      const messages = buildChainAskLoopMessages(client.askLoopRequests[0]!)
      expect(messages[0]?.role).toBe('system')
      // system 只提到标签名，不含真正的摘要内容；摘要挂在第一条 user 里
      expect(messages[0]?.content).not.toContain('问：旧问题')
      expect(messages[0]?.content).not.toContain('旧回答')
      expect(messages[1]?.role).toBe('user')
      expect(messages[1]?.content).toContain('<archived_session_summary>')
      expect(messages[1]?.content).toContain('问：旧问题')
    })
  })
})
