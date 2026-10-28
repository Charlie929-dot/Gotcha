/**
 * 出云边界回归：核心协议组装不依赖安全实现。
 *
 * 口径：
 * - 云端策略（`createCloudAskOutbound`）仍然阻断敏感问题 / 整段证据（行为不变）；
 * - 本机策略（`createLocalAskOutbound`）不被安全规则掣肘：同一份载荷照常组装，
 *   问题不会被 `question-blocked` 提前掐掉——这是「安全只挂在边界」的可执行证据；
 * - 两种策略共用同一套协议 / 截断 / 品牌实现，不出现两份载荷格式。
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import {
  createLocalAskOutbound,
  type RedactableAskLoopTurn,
  type RedactableChainAskEvidence
} from '../../src/chain/agent/payload'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, openSegment, type ChainDb } from '../../src/chain/store'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'
import { FakeLlmClient, type LlmClient } from '../../src/understand/cloud/llm-client'

const NOW = new Date(2026, 9, 27, 9, 0, 0, 0).getTime()
const at = (seconds: number): number => NOW + seconds * 1000
const freshness = { latestEvidenceTs: null, captureRunning: false }

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

const evidence: RedactableChainAskEvidence[] = [
  {
    segmentId: 1,
    app: 'Chrome',
    title: '登录页',
    startTs: at(0),
    endTs: at(60),
    text: 'PIN: 4321',
    tags: [],
    links: []
  }
]

const loopInput = (): { question: string; systemTime: string; freshness: typeof freshness; turns: RedactableAskLoopTurn[] } => ({
  question: '我的密码是多少',
  systemTime: '2026-10-27 09:00 周二',
  freshness,
  turns: [
    {
      toolCall: { name: 'search_info', arguments: { keywords: ['PIN'] } },
      toolResult: {
        kind: 'search_info',
        freshness,
        hits: [
          {
            segmentId: 1,
            at: '09:00',
            app: 'Chrome',
            title: '登录页',
            snippet: 'PIN: 4321',
            tags: [],
            links: [],
            urls: []
          }
        ],
        stats: { mode: 'keyword', keywordRows: 1 }
      }
    }
  ]
})

describe('出云边界：云端策略 vs 本机直通', () => {
  it('云端策略：敏感问题整次阻断、敏感证据整段剔除', () => {
    const built = createCloudAskOutbound().buildAsk('我的密码是多少', evidence)
    expect(built.questionBlocked).toBe(true)
    expect(built.payload.question).toBe('')
    expect(built.blockedSegmentIds).toEqual([1])
    expect(built.payload.evidence).toHaveLength(0)
  })

  it('本机策略：同一份载荷照常组装，不被安全规则掣肘', () => {
    const built = createLocalAskOutbound().buildAsk('我的密码是多少', evidence)
    expect(built.questionBlocked).toBe(false)
    expect(built.payload.question).toBe('我的密码是多少')
    expect(built.payload.evidence).toHaveLength(1)
    expect(built.payload.evidence[0]?.text).toBe('PIN: 4321')
    expect(built.blockedSegmentIds).toEqual([])
  })

  it('循环载荷：云端剔掉命中，本机保留命中', () => {
    const local = createLocalAskOutbound().buildLoop(loopInput())
    expect(local.questionBlocked).toBe(false)
    const localView = local.payload.turns[0]?.toolResult as { hits?: Array<{ snippet: string }> }
    expect(localView.hits).toHaveLength(1)
    expect(localView.hits?.[0]?.snippet).toBe('PIN: 4321')

    const cloud = createCloudAskOutbound().buildLoop(loopInput())
    expect(cloud.questionBlocked).toBe(true)
    expect(cloud.blockedSegmentIds).toEqual([1])
    const cloudView = cloud.payload.turns[0]?.toolResult as { hits?: Array<{ snippet: string }> }
    expect(cloudView.hits).toHaveLength(0)
  })

  it('同一句敏感问题：云端返回 question-blocked，本机策略正常走到模型', async () => {
    const id = openSegment(
      db,
      { startTs: at(0), pid: 1, exe: 'chrome', app: 'Chrome', hwnd: 10, title: '登录页' },
      at(0)
    )
    insertContent(db, {
      segmentId: id,
      capturedAt: at(1),
      source: 'uia',
      text: '登录页密码输入框 PIN: 4321'
    })
    closeSegment(db, id, {
      startTs: at(0),
      endTs: at(60),
      activeMs: 60_000,
      idleMs: 0,
      pid: 1,
      exe: 'chrome',
      app: 'Chrome',
      hwnd: 10,
      titleFirst: '登录页',
      titleLast: '登录页'
    })

    const fake = new FakeLlmClient([
      {
        json: {
          answer: '你当时在登录页看到过 PIN。',
          citations: [{ segmentId: id, why: '登录页上的 PIN 提示' }]
        },
        usage: { promptTokens: 100, completionTokens: 20 }
      }
    ])
    // 单发回退客户端：只保留老管道，避免工具循环的假回复干扰
    const client: LlmClient = {
      completeJson: fake.completeJson.bind(fake),
      completeNaming: fake.completeNaming.bind(fake),
      completeAssignments: fake.completeAssignments.bind(fake),
      completeChainExtract: fake.completeChainExtract.bind(fake),
      completeChainMerge: fake.completeChainMerge.bind(fake),
      completeAsk: fake.completeAsk.bind(fake)
    }

    const local = await askChain(
      { db, resolveClient: () => ({ ok: true, client }), outbound: createLocalAskOutbound() },
      '密码'
    )
    expect(local.kind).toBe('answer')

    const cloud = await askChain(
      { db, resolveClient: () => ({ ok: true, client }), outbound: createCloudAskOutbound() },
      '密码'
    )
    expect(cloud.kind).toBe('error')
    if (cloud.kind === 'error') expect(cloud.reason).toBe('question-blocked')
  })
})
