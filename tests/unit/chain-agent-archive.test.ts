/**
 * 归档（D88 图片 / D89 工具结果）：记忆会模糊，想再看就 recall
 *
 * 守五件事：
 * 1. id 由内容哈希算出——同一条记忆每轮渲染出来的字节一样（缓存与 recall 都对得上）；
 * 2. 历史轮次的工具结果换成占位符，`error` 例外（模糊掉会重复犯错）；
 * 3. 本轮工具结果永远是原文（模型正在用）；
 * 4. `recall` 自己的结果占位时回显「回想的是哪一段」，防止模型看到陌生的自己又去查；
 * 5. 同一条被 recall 够 `RECALL_PLACEHOLDER_LIMIT` 次后不再模糊，其余照旧；
 *    存储层始终留全文（`/log` 与 recall 取的就是它）。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import {
  RECALL_PLACEHOLDER_LIMIT,
  archiveIdOfTurnResult,
  archiveIdOfToolResult,
  recallPlaceholder,
  toolResultLabel,
  toolResultPlaceholder
} from '../../src/chain/agent/archive'
import {
  appendAskConversationTurn,
  emptyAskConversation,
  type CloudAskConversationTurn
} from '../../src/chain/agent/conversation'
import { createLocalAskOutbound, type RedactableAskLoopToolResult } from '../../src/chain/agent/payload'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import { createAskConversationStore } from '../../src/main/ask-conversation'
import { buildChainAskLoopMessages } from '../../src/understand/cloud/deepseek'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'

const NOW = new Date(2026, 9, 30, 14, 0, 0, 0).getTime()
const FRESHNESS = { latestEvidenceTs: null, captureRunning: false }

/** 一段历史工具结果（形状照 `read_segment` 的云端视图） */
type ReadSegmentResult = Extract<RedactableAskLoopToolResult, { kind: 'read_segment' }>
const READ_RESULT: ReadSegmentResult = {
  kind: 'read_segment',
  freshness: FRESHNESS,
  segmentId: 42,
  at: '2026-10-30 13:58',
  app: '记事本',
  title: '会议纪要.txt',
  text: '这是一段很长的正文。'.repeat(100),
  urls: [],
  offset: 0,
  limit: 6000,
  shotCount: 0
}

function payloadWith(conversation: readonly CloudAskConversationTurn[]) {
  const { payload } = createLocalAskOutbound().buildLoop({
    question: '再问一句',
    systemTime: '2026-10-30 14:00 周五',
    freshness: FRESHNESS,
    turns: [],
    conversation
  })
  return payload
}

function conversationWith(
  turns: CloudAskConversationTurn['turns'],
  answer = '看过了'
): CloudAskConversationTurn {
  return { question: '看一下', now: '', turns, answer }
}

function toolMessages(messages: ReturnType<typeof buildChainAskLoopMessages>) {
  return messages.filter((message) => message.role === 'tool')
}

describe('归档 id 与占位符文案', () => {
  it('id 由内容哈希算出：同样内容同 id，不同内容不同 id', () => {
    const first = archiveIdOfToolResult(READ_RESULT)
    expect(first).toMatch(/^[a-f0-9]{8}$/)
    expect(archiveIdOfToolResult({ ...READ_RESULT })).toBe(first)
    expect(archiveIdOfToolResult({ ...READ_RESULT, text: '别的正文' })).not.toBe(first)
  })

  it('recall 回指的永远是原文那条 id（不再套一层新 id）', () => {
    expect(
      archiveIdOfTurnResult('recall', { kind: 'recall', id: 'a1b2c3d4', media: 'tool', text: '' })
    ).toBe('a1b2c3d4')
    expect(archiveIdOfTurnResult('recall', { kind: 'recall', id: '', media: 'tool', text: '' })).toMatch(
      /^[a-f0-9]{8}$/
    )
  })

  it('占位符说清「用哪个工具看了什么」', () => {
    const id = archiveIdOfToolResult(READ_RESULT)
    const label = toolResultLabel(id, 'read_segment', {}, READ_RESULT)
    expect(label).toBe(`#${id} 用 read_segment 查看了《会议纪要.txt》（记事本）的内容`)
    expect(toolResultPlaceholder(id, 'read_segment', {}, READ_RESULT)).toBe(`[${label}]`)
  })

  it('检索类工具落在关键词上，取不到目标时退成一句模糊的', () => {
    expect(toolResultPlaceholder('abcd1234', 'search_info', { keywords: '会议' }, {})).toBe(
      '[#abcd1234 用 search_info 检索了「会议」的结果]'
    )
    expect(toolResultPlaceholder('abcd1234', 'give_birth', {}, {})).toBe(
      '[#abcd1234 用 give_birth 做了一件事]'
    )
  })

  it('recall 占位回显原占位符；没有 label 就只说 id', () => {
    expect(recallPlaceholder('a1b2c3d4', '#a1b2c3d4 用 read_segment 查看了《X》（Y）的内容')).toBe(
      '[回忆了 #a1b2c3d4 用 read_segment 查看了《X》（Y）的内容]'
    )
    expect(recallPlaceholder('a1b2c3d4')).toBe('[回忆了 #a1b2c3d4 的内容]')
  })
})

describe('历史轮次：工具结果换成占位符（D89）', () => {
  it('上一条问的工具结果在下一问里只剩一行占位符，存储层仍是全文', () => {
    const id = archiveIdOfToolResult(READ_RESULT)
    const conversation = appendAskConversationTurn(
      emptyAskConversation(),
      conversationWith([
        { toolCall: { name: 'read_segment', arguments: { segmentId: 42 } }, toolResult: READ_RESULT }
      ])
    )
    // 存储层：原文一行不少（/log 与 recall 取的就是它）
    expect(conversation.turns[0]?.turns[0]?.toolResult).toEqual(READ_RESULT)

    const messages = buildChainAskLoopMessages(payloadWith(conversation.turns))
    const tool = toolMessages(messages)[0]
    expect(tool?.content).toBe(
      `[#${id} 用 read_segment 查看了《会议纪要.txt》（记事本）的内容]`
    )
    expect(tool?.content).not.toContain('这是一段很长的正文')
  })

  it('`error` 不模糊：失败反馈原样重放（模糊掉会重复犯错）', () => {
    const result = { kind: 'error', message: 'read_segment 需要 segmentId' }
    const conversation = appendAskConversationTurn(
      emptyAskConversation(),
      conversationWith([{ toolCall: { name: 'read_segment', arguments: {} }, toolResult: result }])
    )
    const tool = toolMessages(buildChainAskLoopMessages(payloadWith(conversation.turns)))[0]
    expect(tool?.content).toBe(JSON.stringify(result))
  })

  it('本轮工具结果永远是原文（模型正在用）', () => {
    const { payload } = createLocalAskOutbound().buildLoop({
      question: '读一下',
      systemTime: '2026-10-30 14:00 周五',
      freshness: FRESHNESS,
      turns: [
        { toolCall: { name: 'read_segment', arguments: { segmentId: 42 } }, toolResult: READ_RESULT }
      ]
    })
    const tool = toolMessages(buildChainAskLoopMessages(payload))[0]
    expect(tool?.content).toContain('这是一段很长的正文')
  })
})

describe('recall 的占位与「够了就不再模糊」（D89）', () => {
  const ID = archiveIdOfToolResult(READ_RESULT)
  const LABEL = toolResultLabel(ID, 'read_segment', {}, READ_RESULT)

  const recallTurn = (): {
    toolCall: { name: string; arguments: Record<string, unknown> }
    toolResult: Record<string, unknown>
  } => ({
    toolCall: { name: 'recall', arguments: { id: ID } },
    toolResult: { kind: 'recall', id: ID, media: 'tool', text: JSON.stringify(READ_RESULT), name: 'read_segment', label: LABEL }
  })

  it('recall 的结果占位时回显「回想的是哪一段」，防止看到陌生的自己又去查', () => {
    const conversation = appendAskConversationTurn(
      emptyAskConversation(),
      conversationWith([recallTurn()])
    )
    const tool = toolMessages(buildChainAskLoopMessages(payloadWith(conversation.turns)))[0]
    expect(tool?.content).toBe(`[回忆了 ${LABEL}]`)
  })

  /** 一问读了段正文，之后连着回想 count 次 */
  function conversationAfterRecalls(count: number) {
    let conversation = appendAskConversationTurn(
      emptyAskConversation(),
      conversationWith([
        { toolCall: { name: 'read_segment', arguments: {} }, toolResult: READ_RESULT }
      ])
    )
    for (let index = 0; index < count; index += 1) {
      conversation = appendAskConversationTurn(conversation, conversationWith([recallTurn()]))
    }
    return conversation
  }

  it(`回想 ${RECALL_PLACEHOLDER_LIMIT} 次时还都是模糊的：原文与回显都是一行`, () => {
    const conversation = conversationAfterRecalls(RECALL_PLACEHOLDER_LIMIT)
    const [original, ...recalls] = toolMessages(
      buildChainAskLoopMessages(payloadWith(conversation.turns))
    )
    expect(original?.content).toBe(`[${LABEL}]`)
    for (const echo of recalls) {
      expect(String(echo.content)).toBe(`[回忆了 ${LABEL}]`)
    }
  })

  it(`第 ${RECALL_PLACEHOLDER_LIMIT + 1} 次回想起不再模糊：那一次保留原文，更早的一行不动`, () => {
    const conversation = conversationAfterRecalls(RECALL_PLACEHOLDER_LIMIT + 1)
    const [original, ...recalls] = toolMessages(
      buildChainAskLoopMessages(payloadWith(conversation.turns))
    )
    // 原文那条照旧是占位符（不确定自己是哪一次变清晰的，就不动它）
    expect(String(original?.content)).not.toContain('这是一段很长的正文')
    // 前 5 次一行，第 6 次是全文
    for (const echo of recalls.slice(0, RECALL_PLACEHOLDER_LIMIT)) {
      expect(String(echo.content)).toBe(`[回忆了 ${LABEL}]`)
    }
    expect(String(recalls[RECALL_PLACEHOLDER_LIMIT]?.content)).toContain('这是一段很长的正文')
  })

  it('手滑再回想一次：旧的全文不收回去（只往后加，缓存不从那里断）', () => {
    const conversation = conversationAfterRecalls(RECALL_PLACEHOLDER_LIMIT + 2)
    const [, ...recalls] = toolMessages(buildChainAskLoopMessages(payloadWith(conversation.turns)))
    // 第 6 次仍是全文（不收）
    expect(String(recalls[RECALL_PLACEHOLDER_LIMIT]?.content)).toContain('这是一段很长的正文')
    // 第 7 次也照常拿到原文
    expect(String(recalls[RECALL_PLACEHOLDER_LIMIT + 1]?.content)).toContain('这是一段很长的正文')
    // 更早的那些一行都没变
    for (const echo of recalls.slice(0, RECALL_PLACEHOLDER_LIMIT)) {
      expect(String(echo.content)).toBe(`[回忆了 ${LABEL}]`)
    }
  })
})

describe('recall 取回历史工具结果的原文（D89）', () => {
  let db: ChainDb

  beforeEach(() => {
    db = new Database(':memory:')
    ensureChainSchema(db)
  })

  afterEach(() => {
    db.close()
  })

  async function ask(
    store: ReturnType<typeof createAskConversationStore>,
    client: FakeLlmClient,
    question: string
  ) {
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

  it('按上一问占位符里的 id 取回当时那条工具结果', async () => {
    const store = createAskConversationStore()
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'get_freshness', arguments: {} }] },
      { json: '第一答' }
    ])
    await ask(store, client, '第一问')

    const stored = store.load().turns[0]?.turns[0]?.toolResult
    expect(stored?.kind).toBe('get_freshness')
    const id = archiveIdOfToolResult(stored)

    client.push({ toolCalls: [{ name: 'recall', arguments: { id } }] })
    client.push({ json: '想起来了' })
    const result = await ask(store, client, '刚才那条数据边界呢')

    expect(result.kind).toBe('answer')
    const recalled = client.askLoopRequests.at(-1)?.turns[0]?.toolResult
    expect(recalled?.kind).toBe('recall')
    expect(recalled?.media).toBe('tool')
    expect(recalled?.text).toBe(JSON.stringify(stored))
    expect(String(recalled?.label)).toContain('用 get_freshness')
  })

  it('没见过的 id 如实拒绝（不能按 id 扫库）', async () => {
    const store = createAskConversationStore()
    const client = new FakeLlmClient([{ json: '第一答' }])
    await ask(store, client, '第一问')

    client.push({ toolCalls: [{ name: 'recall', arguments: { id: 'deadbeef' } }] })
    client.push({ json: '没有' })
    await ask(store, client, '刚才那个呢')
    const recalled = client.askLoopRequests.at(-1)?.turns[0]?.toolResult
    expect(recalled?.kind).toBe('error')
    expect(String(recalled?.message)).toContain('没有这个归档')
  })
})
