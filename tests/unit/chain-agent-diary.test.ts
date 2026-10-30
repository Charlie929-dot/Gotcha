/**
 * 问记忆 · 日记第二本账（工具 + 引用）
 *
 * 三条要守住的纪律：
 * 1）日记命中能当引用（memories），且**必须**是本轮工具给过的 itemId；
 * 2）编造的 itemId 一律剥掉；只剩编造引用时按「没找到」收口，不能把无依据的正文放出来；
 * 3）没接日记库时，三个记忆工具如实报错，不假装查过。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type Db } from '../../src/db'
import { ensureChainSchema } from '../../src/chain/schema'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import { runAskLoop } from '../../src/chain/agent/loop'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import type { DiaryToolDeps, DiaryHitView } from '../../src/chain/agent/tools'

const HIT: DiaryHitView = {
  itemId: 7,
  day: '2026-09-29',
  section: 'Diary',
  kind: 'diary',
  text: '昨天参加国家奖学金评选，重点观察了肖梦婷的讲解，她把自己擅长的表达发挥到极致。',
  tags: ['观察'],
  refs: ['肖梦婷'],
  reasons: ['提到「评选」', '标签「观察」']
}

function fakeDiary(overrides: Partial<DiaryToolDeps> = {}): DiaryToolDeps {
  return {
    recall: () => [HIT],
    readDay: (day) =>
      day === '2026-09-29'
        ? {
            day,
            text: '## Diary\n- 昨天参加国家奖学金评选',
            items: [{ itemId: HIT.itemId, section: 'Diary', text: HIT.text }]
          }
        : null,
    profile: () => ({
      stats: { items: 6, days: 2, streakDays: 2 },
      observations: [{ topic: 'topics', statement: '最常出现的双链是「肖梦婷」' }]
    }),
    ...overrides
  }
}

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

describe('runAskLoop · 日记引用', () => {
  it('read_diary 打开过的条目自动成为 memories（recall 只给摘要，不算引用）', async () => {
    const client = new FakeLlmClient([
      {
        toolCalls: [{ name: 'recall_diary', arguments: { keywords: ['评选'] } }],
        usage: { promptTokens: 10, completionTokens: 2 }
      },
      { toolCalls: [{ name: 'read_diary', arguments: { day: '2026-09-29' } }] },
      {
        json: {
          answer: '你去年评奖学金时重点观察了肖梦婷的讲解。'
        },
        usage: { promptTokens: 20, completionTokens: 8 }
      }
    ])

    const result = await runAskLoop(
      {
        db,
        client,
        outbound: createLocalAskOutbound(),
        now: () => Date.now(),
        captureRunning: () => false,
        diary: fakeDiary()
      },
      '我上次评奖学金时观察了谁？'
    )

    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.answer).toContain('肖梦婷')
    // 屏幕段一条没有，日记引用一条就够撑起这次回答（引用由 read_diary 自动带出）
    expect(result.citations).toHaveLength(0)
    expect(result.memories).toHaveLength(1)
    expect(result.memories![0]).toMatchObject({
      itemId: 7,
      day: '2026-09-29',
      section: 'Diary',
      why: ''
    })
    expect(result.memories![0].snippet).toContain('肖梦婷')
  })

  it('模型写的 memories 不再采信：没打开就只是普通答复', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'recall_diary', arguments: { keywords: ['评选'] } }] },
      { json: { answer: '你记过这件事。', citations: [], memories: [{ itemId: 999, why: '编的' }] } }
    ])

    const result = await runAskLoop(
      {
        db,
        client,
        outbound: createLocalAskOutbound(),
        now: () => Date.now(),
        captureRunning: () => false,
        diary: fakeDiary()
      },
      '我记过什么？'
    )

    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.memories ?? []).toHaveLength(0)
  })

  it('read_diary 打开当天条目，也能作为引用来源', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'read_diary', arguments: { day: '2026-09-29' } }] },
      {
        json: {
          answer: '那天你写了评选的事。',
          citations: [],
          memories: [{ itemId: 7, why: '当天的日记' }]
        }
      }
    ])

    const result = await runAskLoop(
      {
        db,
        client,
        outbound: createLocalAskOutbound(),
        now: () => Date.now(),
        captureRunning: () => false,
        diary: fakeDiary()
      },
      '9 月 29 日我写了什么？'
    )

    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.memories?.[0].day).toBe('2026-09-29')
  })

  it('打开不存在的一天 / 没接日记库：工具如实报错，不假装查过', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'read_diary', arguments: { day: '1999-01-01' } }] },
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const missing = await runAskLoop(
      {
        db,
        client,
        outbound: createLocalAskOutbound(),
        now: () => Date.now(),
        captureRunning: () => false,
        diary: fakeDiary()
      },
      '1999 年我写了什么？'
    )
    expect(missing.kind).toBe('no-evidence')
    const secondRequest = client.askLoopRequests.at(-1)
    expect(JSON.stringify(secondRequest)).toContain('这一天没有日记条目')
  })

  it('没接日记库时 recall_diary 返回固定错误（不会拿屏幕段顶替）', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'recall_diary', arguments: { keywords: ['评选'] } }] },
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const result = await runAskLoop(
      {
        db,
        client,
        outbound: createLocalAskOutbound(),
        now: () => Date.now(),
        captureRunning: () => false
      },
      '我写了什么？'
    )
    expect(result.kind).toBe('no-evidence')
    expect(JSON.stringify(client.askLoopRequests.at(-1))).toContain('没有接入日记记忆')
  })
})
