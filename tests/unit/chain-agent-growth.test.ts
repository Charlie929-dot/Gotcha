/**
 * 问记忆循环里的成长档案（自调用 v0.2 §8 / §12.3）
 *
 * 守的纪律：
 * 1. kind / content 都钳住；缺参给出可照抄的写法；没接后端如实报「写不了」；
 * 2. 正文不静默截断：超过安全线直接拒，让 ta 自己挑重点；
 * 3. 回执是真回执（落盘成功 / 失败由存储层给），失败时模型不能改口成成功；
 * 4. 成长档案**不**每轮注入（全文留在记忆仓，只有回执进上下文）。
 */

import { describe, expect, it, vi } from 'vitest'

import { runAskLoop } from '../../src/chain/agent/loop'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import { createAskToolExecutor, type GrowthToolDeps } from '../../src/chain/agent/tools'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { openDatabase, type Db } from '../../src/db'
import { ensureChainSchema } from '../../src/chain/schema'

function freshDb(): Db {
  const db = openDatabase(':memory:')
  ensureChainSchema(db)
  return db
}

const NOW = new Date(2026, 10, 1, 23, 30, 0, 0).getTime()

function fakeGrowth(overrides: Partial<GrowthToolDeps> = {}): GrowthToolDeps {
  return {
    write: vi.fn(() => ({
      ok: true,
      message: '日记已写入 growth/daily/2026-11-01.md（8 字）',
      kind: 'daily' as const,
      period: '2026-11-01',
      chars: 8
    })),
    ...overrides
  }
}

function executor(growth?: GrowthToolDeps) {
  const db = freshDb()
  const tool = createAskToolExecutor({
    db,
    now: () => NOW,
    captureRunning: () => false,
    ...(growth ? { growth } : {})
  })
  return { db, tool }
}

function callsOf(deps: GrowthToolDeps): unknown[] {
  return (deps.write as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0])
}

describe('write_growth 参数', () => {
  it('daily：把 kind 与正文原样交给存储层', async () => {
    const growth = fakeGrowth()
    const { tool } = executor(growth)
    const outcome = await tool.execute({
      name: 'write_growth',
      arguments: { kind: 'daily', content: '今天在改自调用。' }
    })
    expect(outcome.result).toMatchObject({
      kind: 'write_growth',
      ok: true,
      growthKind: 'daily',
      period: '2026-11-01',
      chars: 8
    })
    expect(callsOf(growth)).toEqual([{ kind: 'daily', content: '今天在改自调用。' }])
  })

  it('weekly 也走同一个口', async () => {
    const growth = fakeGrowth({
      write: vi.fn(() => ({
        ok: true,
        message: '周记已写入 growth/weekly/2026-W44.md（12 字）',
        kind: 'weekly' as const,
        period: '2026-W44',
        chars: 12
      }))
    })
    const { tool } = executor(growth)
    await tool.execute({ name: 'write_growth', arguments: { kind: 'weekly', content: '这一周……' } })
    expect(callsOf(growth)).toEqual([{ kind: 'weekly', content: '这一周……' }])
  })

  it('monthly / yearly 也走同一个口（月末总结 / 年终总结）', async () => {
    const monthly = fakeGrowth({
      write: vi.fn(() => ({
        ok: true,
        message: '月末总结已写入 growth/monthly/2026-11.md（20 字）',
        kind: 'monthly' as const,
        period: '2026-11',
        chars: 20
      }))
    })
    const monthlyRun = executor(monthly)
    const first = await monthlyRun.tool.execute({
      name: 'write_growth',
      arguments: { kind: 'monthly', content: '这个月……' }
    })
    expect(first.result).toMatchObject({ kind: 'write_growth', growthKind: 'monthly', period: '2026-11' })
    expect(callsOf(monthly)).toEqual([{ kind: 'monthly', content: '这个月……' }])

    const yearly = fakeGrowth({
      write: vi.fn(() => ({
        ok: true,
        message: '年终总结已写入 growth/yearly/2026.md（30 字）',
        kind: 'yearly' as const,
        period: '2026',
        chars: 30
      }))
    })
    const yearlyRun = executor(yearly)
    await yearlyRun.tool.execute({
      name: 'write_growth',
      arguments: { kind: 'yearly', content: '这一年……' }
    })
    expect(callsOf(yearly)).toEqual([{ kind: 'yearly', content: '这一年……' }])
  })

  it('缺 kind / 缺正文 / 太长的正文 / 认不出的 kind 都拒，不调存储层', async () => {
    const growth = fakeGrowth()
    const { tool } = executor(growth)
    for (const args of [
      {},
      { kind: 'month', content: 'x' },
      { kind: 'daily' },
      { kind: 'daily', content: '   ' },
      { kind: 'daily', content: 'a'.repeat(4001) }
    ]) {
      const outcome = await tool.execute({ name: 'write_growth', arguments: args })
      expect(outcome.result.kind).toBe('error')
    }
    expect(growth.write).not.toHaveBeenCalled()
  })

  it('没接成长档案：如实说写不了', async () => {
    const { tool } = executor()
    const outcome = await tool.execute({
      name: 'write_growth',
      arguments: { kind: 'daily', content: '今天……' }
    })
    expect(outcome.result.kind).toBe('error')
    expect(JSON.stringify(outcome.result)).toContain('写不了')
  })

  it('存储层说没写成：ok=false，原因原样回给模型', async () => {
    const growth = fakeGrowth({
      write: vi.fn(() => ({
        ok: false,
        message: '太长（1500 字，日记最多 1200 字）。挑最重要的写；细节留在记忆里。',
        kind: '' as const,
        period: '',
        chars: 0
      }))
    })
    const { tool } = executor(growth)
    const outcome = await tool.execute({
      name: 'write_growth',
      arguments: { kind: 'daily', content: 'x' }
    })
    expect(outcome.result).toMatchObject({ kind: 'write_growth', ok: false, period: '' })
    expect(JSON.stringify(outcome.result)).toContain('最多 1200 字')
  })
})

describe('循环里的回执', () => {
  it('写完回灌：回执与过程摘要都在，模型知道写到了哪一篇', async () => {
    const growth = fakeGrowth()
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'write_growth', arguments: { kind: 'daily', content: '今天在改自调用。' } }] },
      { json: { answer: '写完了。', citations: [] } }
    ])
    const result = await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: createLocalAskOutbound(),
        now: () => NOW,
        captureRunning: () => false,
        tools: ['write_growth'],
        growth
      },
      '写今天的日记'
    )
    expect(result.kind).toBe('answer')
    const text = JSON.stringify(client.askLoopRequests.at(-1))
    expect(text).toContain('日记已写入 growth/daily/2026-11-01.md')
    if (result.kind === 'answer') {
      expect(result.trace?.steps[0]?.tools[0]?.summary).toContain('日记已写')
    }
  })

  it('成长档案全文不每轮注入：<now> 里没有它', async () => {
    const growth = fakeGrowth()
    const client = new FakeLlmClient([{ json: { answer: '嗯。', citations: [] } }])
    await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: createLocalAskOutbound(),
        now: () => NOW,
        captureRunning: () => false,
        tools: [],
        growth
      },
      '在吗'
    )
    const text = JSON.stringify(client.askLoopRequests.at(-1))
    expect(text).not.toContain('成长档案')
    expect(text).not.toContain('growth/daily')
  })
})
