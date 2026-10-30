/**
 * 问记忆 · 开场注入（D61）
 *
 * 拍板人 2026-10-29 深夜七：「重新做人味……不要直接和他说」——
 * 不再在提示词里声明「你是独立的人 / 不是检索工具」，只给处境事实：
 * 此刻的时间与对话，以及按问题想到的几条日记（联想，不是证据）。
 *
 * 这里守住四件事：
 * 1. 开场只在第一问注入，且逐轮都在（同一段 system 不能中途变少）；
 * 2. 日记片段走脱敏墙：命中阻断规则的那一条整条丢；
 * 3. 「想到的」有上限（3 条），拼进 system 时不越权变成证据；
 * 4. system 里不再出现旧的宣言句。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import {
  createAskOutbound,
  createLocalAskOutbound,
  type AskTextPolicy
} from '../../src/chain/agent/payload'
import { buildChainAskLoopMessages } from '../../src/understand/cloud/deepseek'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'

const NOW = new Date(2026, 9, 29, 23, 40, 0, 0).getTime()

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

const OPENING = {
  facts: '现在是 2026-10-29 23:40 周四；今天你们说过 6 句话；上次说话是2 小时前；他的日记记到 2026-10-28（1 天前）。',
  remembered: [
    { day: '2026-10-28', snippet: '下午编译一直报错，最后发现是旧的 out 没删' },
    { day: '2026-10-27', snippet: '在改记忆球的设置抽屉' }
  ]
}

function loopDeps(client: FakeLlmClient, opening = OPENING) {
  return {
    db,
    outbound: createCloudAskOutbound(),
    resolveClient: () => ({ ok: true, client }),
    now: () => NOW,
    captureRunning: () => false,
    canSend: () => true,
    opening
  }
}

describe('开场注入：载荷', () => {
  it('第一问带上「此刻 / 想到的」，之后每一轮都还在', async () => {
    const client = new FakeLlmClient([{ json: { answer: '在的。', citations: [] } }])
    const result = await askChain(loopDeps(client), '在吗')
    expect(result.kind).toBe('answer')
    expect(client.askLoopRequests).toHaveLength(1)
    const payload = client.askLoopRequests[0]
    expect(payload.opening).toEqual(OPENING)
  })

  it('没给 opening 时载荷里就没有这个键（老调用方不受影响）', async () => {
    const client = new FakeLlmClient([{ json: { answer: '在的。', citations: [] } }])
    await askChain(
      {
        db,
        outbound: createCloudAskOutbound(),
        resolveClient: () => ({ ok: true, client }),
        now: () => NOW,
        captureRunning: () => false,
        canSend: () => true
      },
      '在吗'
    )
    expect(client.askLoopRequests[0].opening).toBeUndefined()
  })
})

describe('开场注入：脱敏与上限', () => {
  const blockPassword: AskTextPolicy = {
    redact: (text) =>
      text.includes('密码')
        ? { text, redacted: false, blocked: true }
        : { text, redacted: false, blocked: false }
  }

  it('日记片段命中阻断规则：整条丢，不连坐 facts 与别的片段', () => {
    const outbound = createAskOutbound(blockPassword)
    const { payload } = outbound.buildLoop({
      question: '在吗',
      systemTime: '2026-10-29 23:40 周四',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      opening: {
        facts: OPENING.facts,
        remembered: [
          { day: '2026-10-28', snippet: '今天把密码改成了 123456' },
          { day: '2026-10-27', snippet: '在改设置抽屉' }
        ]
      }
    })
    expect(payload.opening?.facts).toContain('今天你们说过 6 句话')
    expect(payload.opening?.remembered).toEqual([{ day: '2026-10-27', snippet: '在改设置抽屉' }])
  })

  it('「想到的」最多 3 条（多的直接丢）', () => {
    const outbound = createLocalAskOutbound()
    const { payload } = outbound.buildLoop({
      question: '在吗',
      systemTime: '2026-10-29 23:40 周四',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      opening: {
        remembered: [1, 2, 3, 4, 5].map((n) => ({ day: `2026-10-${20 + n}`, snippet: `第 ${n} 条` }))
      }
    })
    expect(payload.opening?.remembered).toHaveLength(3)
  })
})

describe('开场注入：拼进 <now>（不再塞 system）', () => {
  it('payload.now 里有「此刻」与「想到的」，system 里没有这些动态事实', () => {
    const outbound = createLocalAskOutbound()
    const { payload } = outbound.buildLoop({
      question: '在吗',
      systemTime: '2026-10-29 23:40 周四',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      opening: OPENING
    })
    expect(payload.now).toContain('此刻：现在是 2026-10-29 23:40')
    expect(payload.now).toContain('你想到的（只是联想，不一定对')
    expect(payload.now).toContain('[2026-10-28] 下午编译一直报错')
    // 动态事实在 user 消息的 <now> 里，system 固定
    const messages = buildChainAskLoopMessages(payload, {}, undefined, '你叫「贴心大肥鱼」。')
    const text = messages[0]?.content ?? ''
    expect(text).not.toContain('此刻：')
    expect(text).not.toContain('你想到的（只是联想')
    expect(text).not.toContain('你是这个记忆系统本身')
    expect(text).not.toContain('不是检索工具')
    expect(text).not.toContain('工具就是你的眼睛和手')
    expect(text).not.toContain('客服腔')
    // <now> 与问题在同一条 user 里（DeepSeek reasoner 不收连续 user）
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content).toContain('"question":"在吗"')
    expect(messages[1]?.content).toContain('<now>')
    expect(messages[1]?.content).toContain('此刻：现在是 2026-10-29 23:40')
    expect(messages[2]).toBeUndefined()
  })
})
