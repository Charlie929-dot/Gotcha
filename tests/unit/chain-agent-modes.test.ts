/**
 * 问记忆 · 模式（D62）在链层 / 云端的行为
 *
 * 守三件事：
 * 1. 无工具模式只发一次请求（allowTools=false、无工具组），不再有「收尾轮」语义；
 * 2. 两种工具组各给各的工具：日记组不给 search_info，屏幕组不给 recall_diary；
 * 3. system 按模式分段：没有屏幕工具就没有「数据边界 / 最近段」，没有任何工具就不写「手边有工具」。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import {
  askLoopToolsFor,
  buildChainAskLoopMessages
} from '../../src/understand/cloud/deepseek'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'

const NOW = new Date(2026, 9, 30, 0, 30, 0, 0).getTime()
const SYSTEM_TIME = '2026-10-30 00:30 周五'

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function payloadOf(groups?: { screen: boolean; diary: boolean }) {
  void groups
  const outbound = createLocalAskOutbound()
  const { payload } = outbound.buildLoop({
    question: '在吗',
    systemTime: SYSTEM_TIME,
    freshness: { latestEvidenceTs: null, captureRunning: false },
    turns: [],
    opening: {
      facts: '现在是 2026-10-30 00:30 周五；今天你们说过 2 句话。',
      remembered: [{ day: '2026-10-29', snippet: '在改记忆球的设置抽屉' }]
    }
  })
  return payload
}

function systemText(groups: { screen: boolean; diary: boolean }, final = false): string {
  const [system] = buildChainAskLoopMessages(
    payloadOf(groups),
    { final },
    undefined,
    '你叫「贴心大肥鱼」。',
    groups
  )
  return system?.content ?? ''
}

describe('system 按模式分段', () => {
  it('两组都开：数据边界 / 最近段 / 两边工具句都在', () => {
    const text = systemText({ screen: true, diary: true })
    expect(text).toContain('数据边界：')
    expect(text).toContain('能翻这台电脑的窗口记录，也能翻这个人写的日记')
    expect(text).toContain('此刻：现在是 2026-10-30')
    expect(text).toContain('你想到的（只是联想')
  })

  it('只有日记（聊天）：不写数据边界 / 屏幕工具，写日记工具句', () => {
    const text = systemText({ screen: false, diary: true })
    expect(text).not.toContain('数据边界：')
    expect(text).not.toContain('最近一段证据：')
    expect(text).toContain('能翻这个人写的日记')
    expect(text).not.toContain('能翻这台电脑的窗口记录')
    // 聊天仍给「此刻 / 想到的」（这是人味的来源，不是屏幕记忆）
    expect(text).toContain('此刻：')
    expect(text).toContain('你想到的（只是联想')
  })

  it('两组都关（提问）：没有工具句、没有数据边界、也没有「收尾轮」提示', () => {
    const text = systemText({ screen: false, diary: false }, true)
    expect(text).not.toContain('手边有些工具')
    expect(text).not.toContain('数据边界：')
    expect(text).not.toContain('最近一段证据：')
    expect(text).not.toContain('【收尾】')
    expect(text).toContain('当前时间：')
    // 底线仍在不编造
    expect(text).toContain('不编造')
  })

  it('有工具的收尾轮才写「轮数用尽」', () => {
    expect(systemText({ screen: true, diary: true }, true)).toContain('【收尾】')
    expect(systemText({ screen: false, diary: true }, true)).toContain('【收尾】')
  })
})

describe('工具过滤', () => {
  const names = (groups: { screen: boolean; diary: boolean }): string[] =>
    askLoopToolsFor(groups).map((tool) => tool.function.name)

  it('屏幕组：有检索 / 读段 / 问答记录，没有日记工具', () => {
    const list = names({ screen: true, diary: false })
    expect(list).toContain('search_info')
    expect(list).toContain('read_segment')
    expect(list).not.toContain('recall_diary')
    expect(list).not.toContain('read_diary')
  })

  it('日记组：有 recall_diary / read_diary，没有屏幕检索', () => {
    const list = names({ screen: false, diary: true })
    expect(list).toContain('recall_diary')
    expect(list).toContain('read_diary')
    expect(list).not.toContain('search_info')
  })

  it('两组都关：一个工具都不发', () => {
    expect(names({ screen: false, diary: false })).toEqual([])
  })
})

function loopDeps(client: FakeLlmClient, tools: { screen: boolean; diary: boolean }) {
  return {
    db,
    outbound: createCloudAskOutbound(),
    resolveClient: () => ({ ok: true, client }),
    now: () => NOW,
    captureRunning: () => false,
    canSend: () => true,
    tools
  }
}

describe('无工具模式：只发一次请求', () => {
  it('不跑工具循环、不带 tools、不走收尾轮语义', async () => {
    const client = new FakeLlmClient([{ json: '在的，你说。' }])
    const result = await askChain(loopDeps(client, { screen: false, diary: false }), '在吗')
    expect(result.kind).toBe('answer')
    expect(client.askLoopRequests).toHaveLength(1)
    // FakeLlmClient 记录的选项就是链层给客户端的：收尾轮语义（allowTools=false）
    expect(client.optionCalls[0]?.allowTools).toBe(false)
    expect(client.optionCalls[0]?.toolGroups).toEqual({ screen: false, diary: false })
    expect(result.stats.turns).toBe(1)
    // 没有工具就没有引用
    if (result.kind === 'answer') expect(result.citations).toEqual([])
  })

  it('聊天模式（日记组）：工具组传给客户端，允许工具轮', async () => {
    const client = new FakeLlmClient([{ json: '我在。' }])
    await askChain(loopDeps(client, { screen: false, diary: true }), '在吗')
    expect(client.optionCalls[0]?.toolGroups).toEqual({ screen: false, diary: true })
    // 模型没调工具就直接答：allowTools 仍是 true（给了工具，用不用由它）
    expect(client.optionCalls[0]?.allowTools).toBe(true)
  })
})
