/**
 * 问记忆 · 分支工具白名单（D72）在链层 / 云端的行为
 *
 * 守三件事：
 * 1. 空工具表 = 纯模型：只发一次请求（allowTools=false），不再有「收尾轮」语义；
 * 2. 工具按元素名发：屏幕组不给日记工具，日记组不给检索；
 * 3. system 按工具分段：没有屏幕工具就没有「数据边界 / 最近段」，没有任何工具就不写「手边有工具」。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import {
  ASK_TOOL_DIARY_NAMES,
  ASK_TOOL_NAMES,
  ASK_TOOL_SCREEN_NAMES
} from '../../src/chain/agent/tool-catalog'
import {
  askLoopToolsFor,
  buildChainAskLoopMessages
} from '../../src/understand/cloud/deepseek'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'

const NOW = new Date(2026, 9, 30, 0, 30, 0, 0).getTime()
const SYSTEM_TIME = '2026-10-30 00:30 周五'

const SCREEN = [...ASK_TOOL_SCREEN_NAMES]
const DIARY = [...ASK_TOOL_DIARY_NAMES]
const ALL = [...ASK_TOOL_NAMES]
const NONE: string[] = []

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function payloadOf(tools: readonly string[]) {
  const outbound = createLocalAskOutbound()
  const { payload } = outbound.buildLoop({
    question: '在吗',
    systemTime: SYSTEM_TIME,
    systemTimeMs: NOW,
    tools,
    freshness: { latestEvidenceTs: null, captureRunning: false },
    turns: [],
    opening: {
      facts: '现在是 2026-10-30 00:30 周五；今天你们说过 2 句话。',
      remembered: [{ day: '2026-10-29', snippet: '在改记忆球的设置抽屉' }]
    }
  })
  return payload
}

function messagesOf(tools: readonly string[], final = false) {
  return buildChainAskLoopMessages(
    payloadOf(tools),
    { final },
    undefined,
    '你叫「贴心大肥鱼」。',
    tools
  )
}

function systemText(tools: readonly string[]): string {
  return messagesOf(tools)[0]?.content ?? ''
}

describe('system 按工具分段（D64：动态事实改放 <now>）', () => {
  it('全开：工具清单两边都在；时间 / 数据边界在 <now> 里', () => {
    const text = systemText(ALL)
    expect(text).toContain('<tools>')
    expect(text).toContain('search_info')
    expect(text).toContain('recall_diary')
    expect(text).not.toContain('数据边界：')
    const now = payloadOf(ALL).now
    expect(now).toContain('数据边界：')
    expect(now).toContain('此刻：现在是 2026-10-30')
    expect(now).toContain('你想到的（只是联想')
  })

  it('只有日记：不写屏幕工具；<now> 不写数据边界 / 最近段', () => {
    const text = systemText(DIARY)
    expect(text).not.toContain('search_info')
    expect(text).toContain('recall_diary')
    const now = payloadOf(DIARY).now
    expect(now).not.toContain('数据边界：')
    expect(now).not.toContain('最近一段证据：')
    // 聊天仍给「此刻 / 想到的」（这是人味的来源，不是屏幕记忆）
    expect(now).toContain('此刻：')
    expect(now).toContain('你想到的（只是联想')
  })

  it('空表（纯模型）：没有工具清单；<now> 只有时间', () => {
    const text = systemText(NONE)
    expect(text).not.toContain('<tools>')
    const messages = messagesOf(NONE, true)
    expect(messages.some((message) => message.content.includes('<final>'))).toBe(false)
    const now = payloadOf(NONE).now
    // D88：时间行改成「现在是<时段> HH:mm（…）」+「距今天 24:00 还有 …」
    expect(now).toMatch(/^现在是(凌晨|早上|上午|中午|下午|傍晚|晚上) \d{2}:\d{2}/u)
    expect(now).toContain('距今天 24:00 还有')
    expect(now).not.toContain('数据边界：')
    // 底线仍在不编造
    expect(text).toContain('不编造')
  })

  it('有工具的收尾轮：不再追加消息（没有 tool call 本身就是收尾）', () => {
    for (const tools of [ALL, DIARY]) {
      const messages = messagesOf(tools, true)
      expect(messages).toEqual(messagesOf(tools, false))
      expect(messages.some((message) => message.content.includes('<final>'))).toBe(false)
    }
  })
})

describe('工具过滤', () => {
  const names = (tools: readonly string[]): string[] =>
    askLoopToolsFor(tools).map((tool) => tool.function.name)

  it('屏幕组：有检索 / 读段 / 问答记录，没有日记工具', () => {
    const list = names(SCREEN)
    expect(list).toContain('search_info')
    expect(list).toContain('read_segment')
    expect(list).not.toContain('recall_diary')
    expect(list).not.toContain('read_diary')
  })

  it('日记组：有 recall_diary / read_diary，没有屏幕检索', () => {
    const list = names(DIARY)
    expect(list).toContain('recall_diary')
    expect(list).toContain('read_diary')
    expect(list).not.toContain('search_info')
  })

  it('单个元素：只发那一个（/tool rm 之后的行为）', () => {
    expect(names(['search_info'])).toEqual(['search_info'])
    expect(names([])).toEqual([])
  })

  it('生女儿工具只在 giveBirth=true 时出现（生命 ≤15% 才由组合根打开）', () => {
    expect(names(ALL)).not.toContain('give_birth')
    expect(names(DIARY)).not.toContain('give_birth')
    const withLife = askLoopToolsFor(ALL, { giveBirth: true }).map((tool) => tool.function.name)
    expect(withLife).toContain('give_birth')
  })
})

describe('女儿代：<mom_letter>', () => {
  it('信放在 persona 之后、工具 / 规则之前', () => {
    const messages = buildChainAskLoopMessages(
      payloadOf(ALL),
      {},
      undefined,
      '你叫「贴心大肥鱼」。',
      ALL,
      { momLetter: '给女儿的话' }
    )
    const system = messages[0]?.content ?? ''
    expect(system).toContain('<mom_letter>\n给女儿的话\n</mom_letter>')
    expect(system.indexOf('<persona>')).toBeLessThan(system.indexOf('<mom_letter>'))
    expect(system.indexOf('<mom_letter>')).toBeLessThan(system.indexOf('<tools>'))
  })

  it('没有信就不写这一段', () => {
    const messages = buildChainAskLoopMessages(
      payloadOf(ALL),
      {},
      undefined,
      '你叫「贴心大肥鱼」。',
      ALL
    )
    expect(messages[0]?.content).not.toContain('<mom_letter>')
  })
})

function loopDeps(client: FakeLlmClient, tools: readonly string[]) {
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

describe('空工具表：只发一次请求', () => {
  it('不跑工具循环、不带 tools、不走收尾轮语义', async () => {
    const client = new FakeLlmClient([{ json: '在的，你说。' }])
    const result = await askChain(loopDeps(client, NONE), '在吗')
    expect(result.kind).toBe('answer')
    expect(client.askLoopRequests).toHaveLength(1)
    // FakeLlmClient 记录的选项就是链层给客户端的：收尾轮语义（allowTools=false）
    expect(client.optionCalls[0]?.allowTools).toBe(false)
    expect(client.optionCalls[0]?.toolElements).toEqual([])
    expect(result.stats.turns).toBe(1)
    // 没有工具就没有引用
    if (result.kind === 'answer') expect(result.citations).toEqual([])
  })

  it('只挂日记：白名单传给客户端，允许工具轮', async () => {
    const client = new FakeLlmClient([{ json: '我在。' }])
    await askChain(loopDeps(client, DIARY), '在吗')
    expect(client.optionCalls[0]?.toolElements).toEqual(DIARY)
    // 模型没调工具就直接答：allowTools 仍是 true（给了工具，用不用由它）
    expect(client.optionCalls[0]?.allowTools).toBe(true)
  })
})
