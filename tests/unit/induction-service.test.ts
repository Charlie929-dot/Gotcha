import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, insertEvent } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import { readCursor, startOfLocalDay } from '../../src/understand/cloud/batch'
import { FakeLlmClient, LlmAbortError, LlmParseError, type LlmClient } from '../../src/understand/cloud/llm-client'
import { createInductionService, type InductionService } from '../../src/understand/service'
import { localDayKey, readUsage } from '../../src/understand/induction'

const NOW = 1_700_000_000_000
const VALID = {
  nodes: [
    { title: '读技术方案', summary: '看了 M2 归纳方案', type: 'knowledge', event_ids: [1] },
    { title: '实现归纳服务', summary: '写了调度与暂停语义', type: 'activity', event_ids: [2] }
  ],
  edges: [{ from: 0, to: 1, weight: 0.6, evidence: '方案驱动实现' }]
}

function makeDb(options: { ocr?: string } = {}): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:')
  insertEvent(db, { ts: NOW - 10 * 60_000, app: 'code.exe', windowTitle: 'service.ts', ocrText: options.ocr ?? '调度' })
  insertEvent(db, {
    ts: NOW - 9 * 60_000,
    app: 'code.exe',
    windowTitle: 'service.ts',
    ocrText: options.ocr ?? '实现'
  })
  return db
}

function makeService(db: ReturnType<typeof openDatabase>, client: LlmClient | null): InductionService {
  return createInductionService({ db, getClient: () => client, now: () => NOW })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('induction service · 跑批 / 校验 / 暂停 / 预算', () => {
  it('合法输出：落节点与边、同一天重复点击幂等、记账 usage', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([{ json: VALID, usage: { promptTokens: 120, completionTokens: 30 } }])
      const service = makeService(db, client)
      const outcome = await service.runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 2, edges: 1, placeholders: 0, consumed: 2 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 2 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 1 })
      // 按天归纳不再推进旧游标（D28）
      expect(readCursor(db)).toEqual({ ts: 0, id: 0 })
      expect(readUsage(db, NOW)).toEqual({ calls: 1, promptTokens: 120, completionTokens: 30 })
      expect(client.requests).toHaveLength(1)
      expect(client.optionCalls[0].signal).toBeInstanceOf(AbortSignal)
      expect(client.requests[0].events[0].eventIds).toEqual([1, 2])

      // 同一天再点一次：事件都已在节点 source_events 里，零请求
      expect(await service.runOnce()).toEqual({ status: 'empty' })
      expect(client.requests).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('首轮非法 → 用错误摘要修复重试一次后成功', async () => {
    const db = makeDb()
    try {
      const invalid = {
        nodes: [{ title: '只有一条', summary: '漏了事件 2', type: 'knowledge', event_ids: [1] }],
        edges: []
      }
      const client = new FakeLlmClient([{ json: invalid }, { json: VALID }])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 2 })
      expect(client.optionCalls).toHaveLength(2)
      expect(client.optionCalls[1].repair?.errors.join('；')).toContain('未被任何节点覆盖')
      expect(readUsage(db, NOW)).toMatchObject({ calls: 2 })
    } finally {
      db.close()
    }
  })

  it('解析层失败（空 content / 非法 JSON）也走 1 次修复重试', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([new LlmParseError('LLM 返回空 content'), { json: VALID }])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome.status).toBe('ok')
      expect(client.optionCalls).toHaveLength(2)
      expect(client.optionCalls[0].repair).toBeUndefined()
      expect(client.optionCalls[1].repair?.errors[0]).toContain('合法 json')
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })

  it('两次解析都失败也按真实 usage 记账（F03：失败循环不能绕过预算）', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([
        new LlmParseError('LLM 返回空 content', { promptTokens: 100, completionTokens: 0 }),
        new LlmParseError('LLM 返回空 content', { promptTokens: 100, completionTokens: 0 })
      ])
      const service = makeService(db, client)
      const outcome = await service.runOnce()

      expect(outcome.status).toBe('error')
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 })
      expect(readCursor(db)).toEqual({ ts: 0, id: 0 })
      // 修复前 spent 只在解析成功后累计，这里会是 0
      expect(readUsage(db, NOW)).toEqual({ calls: 2, promptTokens: 200, completionTokens: 0 })
    } finally {
      db.close()
    }
  })

  it('首轮解析失败（带 usage）+ 修复成功：usage 合计包含失败那一次（F03）', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([
        new LlmParseError('LLM 返回空 content', { promptTokens: 50, completionTokens: 0 }),
        { json: VALID, usage: { promptTokens: 120, completionTokens: 30 } }
      ])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome.status).toBe('ok')
      expect(readUsage(db, NOW)).toEqual({ calls: 2, promptTokens: 170, completionTokens: 30 })
    } finally {
      db.close()
    }
  })

  it('修复重试仍非法：整批失败、游标不动、不写节点', async () => {
    const db = makeDb()
    try {
      const invalid = { nodes: [{ title: '只有一条', summary: '漏了事件 2', type: 'knowledge', event_ids: [1] }] }
      const client = new FakeLlmClient([
        { json: invalid, usage: { promptTokens: 10, completionTokens: 2 } },
        { json: invalid, usage: { promptTokens: 10, completionTokens: 2 } }
      ])
      const service = makeService(db, client)
      const outcome = await service.runOnce()

      expect(outcome.status).toBe('error')
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 })
      expect(readCursor(db)).toEqual({ ts: 0, id: 0 })
      // 失败重试也已消耗 token：照实记账，预算才拦得住
      expect(readUsage(db, NOW)).toEqual({ calls: 2, promptTokens: 20, completionTokens: 4 })
      expect(service.getState().lastError).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('暂停 abort：在途请求取消，结果丢弃、不写库、游标不动', async () => {
    const db = makeDb()
    try {
      const pending: LlmClient = {
        completeJson: (_payload, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new LlmAbortError()))
          })
      }
      const service = makeService(db, pending)
      const running = service.runOnce()
      await new Promise((resolve) => setTimeout(resolve, 0))
      service.stop()
      const outcome = await running

      expect(outcome.status).toBe('aborted')
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 })
      expect(readCursor(db)).toEqual({ ts: 0, id: 0 })
      // 暂停后（含 Phase 2「立即归纳」）一律跳过：零出网
      expect(await service.runOnce({ manual: true })).toEqual({ status: 'skipped', reason: 'paused' })
    } finally {
      db.close()
    }
  })

  it('全部时刻不可剥离：只生成「内容已保护」占位节点，不调用 LLM', async () => {
    const db = makeDb({ ocr: '请输入密码' })
    try {
      const client = new FakeLlmClient([])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 1, placeholders: 1 })
      expect(client.requests).toHaveLength(0)
      const row = db.prepare('SELECT type, title FROM nodes').get() as Record<string, unknown>
      expect(row).toMatchObject({ type: 'protected', title: '内容已保护' })
      // 占位节点也覆盖 source_events，再点一次不会重复出云
      expect(await makeService(db, client).runOnce()).toEqual({ status: 'empty' })
    } finally {
      db.close()
    }
  })

  it('混合批：可出云时刻正常归纳，不可剥离时刻生成占位节点', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: NOW - 10 * 60_000, app: 'code.exe', windowTitle: 'a.ts', ocrText: '正常内容' })
      insertEvent(db, { ts: NOW - 9 * 60_000, app: '1password.exe', windowTitle: 'Vault', ocrText: '请输入密码' })
      const client = new FakeLlmClient([
        { json: { nodes: [{ title: '读代码', summary: 'S', type: 'activity', event_ids: [1] }], edges: [] } }
      ])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 2, placeholders: 1, consumed: 2 })
      const rows = db.prepare('SELECT type, title FROM nodes ORDER BY id').all() as Array<Record<string, unknown>>
      expect(rows).toEqual([
        { type: 'activity', title: '读代码' },
        { type: 'protected', title: '内容已保护' }
      ])
    } finally {
      db.close()
    }
  })

  it('今日 token 超预算：跳过（状态 budget-exhausted），不发请求', async () => {
    const db = makeDb()
    try {
      setSetting(db, `${'graph.usage.'}${localDayKey(NOW)}`, JSON.stringify({ calls: 3, prompt_tokens: 1000, completion_tokens: 0 }))
      setSetting(db, 'graph.budget_tokens_per_day', '1000')
      const client = new FakeLlmClient([{ json: VALID }])
      const service = makeService(db, client)
      expect(await service.runOnce()).toEqual({ status: 'skipped', reason: 'budget' })
      expect(client.requests).toHaveLength(0)
      expect(service.getState().status).toBe('budget-exhausted')
    } finally {
      db.close()
    }
  })

  it('graph.auto=0 时自动跑批跳过；manual 仍可立即归纳', async () => {
    const db = makeDb()
    try {
      setSetting(db, 'graph.auto', '0')
      const client = new FakeLlmClient([{ json: VALID }, { json: VALID }])
      const service = makeService(db, client)
      expect(await service.runOnce()).toEqual({ status: 'skipped', reason: 'auto-off' })
      expect(client.requests).toHaveLength(0)
      expect((await service.runOnce({ manual: true })).status).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('无新事件返回 empty；未配置供应商返回 not-configured', async () => {
    const emptyDb = openDatabase(':memory:')
    const db = makeDb()
    try {
      expect(await makeService(emptyDb, new FakeLlmClient([{ json: VALID }])).runOnce()).toEqual({
        status: 'empty'
      })
      expect(await makeService(db, null).runOnce()).toEqual({ status: 'skipped', reason: 'not-configured' })
    } finally {
      emptyDb.close()
      db.close()
    }
  })

  it('start 在 firstDelayMs 后跑第一次、结束后按间隔排下一次；stop 清定时器', async () => {
    vi.useFakeTimers()
    const db = makeDb()
    try {
      const client = new FakeLlmClient([{ json: VALID }, { json: VALID }])
      const service = createInductionService({
        db,
        getClient: () => client,
        now: () => NOW,
        firstDelayMs: 5_000,
        intervalMs: 600_000
      })
      service.start()
      expect(service.isActive()).toBe(true)
      expect(service.getState().nextRunAt).toBe(NOW + 5_000)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(client.requests).toHaveLength(1)
      expect(service.getState().nextRunAt).toBe(NOW + 600_000)

      service.stop()
      expect(service.isActive()).toBe(false)
      expect(service.getState().status).toBe('stopped')
      await vi.advanceTimersByTimeAsync(600_000)
      expect(client.requests).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('失败按 1m / 5m / 15m 退避（上限 30m），成功复位', async () => {
    vi.useFakeTimers()
    const db = makeDb()
    try {
      const invalid = { nodes: [{ title: '只有一条', summary: '漏了事件 2', type: 'knowledge', event_ids: [1] }] }
      const client = new FakeLlmClient(Array.from({ length: 6 }, () => ({ json: invalid })))
      const service = createInductionService({
        db,
        getClient: () => client,
        now: () => NOW,
        firstDelayMs: 5_000,
        intervalMs: 600_000
      })
      service.start()

      await vi.advanceTimersByTimeAsync(5_000)
      expect(service.getState().status).toBe('backoff')
      expect(service.getState().nextRunAt).toBe(NOW + 60_000)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(service.getState().nextRunAt).toBe(NOW + 300_000)

      await vi.advanceTimersByTimeAsync(300_000)
      expect(service.getState().nextRunAt).toBe(NOW + 900_000)
    } finally {
      db.close()
    }
  })

  it('graph.batch_max_moments 可调：单批时刻上限来自 settings', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: NOW - 10 * 60_000, app: 'a.exe', windowTitle: 'A' })
      insertEvent(db, { ts: NOW - 9 * 60_000, app: 'b.exe', windowTitle: 'B' })
      setSetting(db, 'graph.batch_max_moments', '1')
      const client = new FakeLlmClient([
        { json: { nodes: [{ title: 'A', summary: 'S', type: 'knowledge', event_ids: [1] }], edges: [] } },
        { json: { nodes: [{ title: 'B', summary: 'S', type: 'knowledge', event_ids: [2] }], edges: [] } }
      ])
      const service = makeService(db, client)

      expect(await service.runOnce()).toMatchObject({ status: 'ok', consumed: 1, more: true })
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 1 })
      expect((await service.runOnce()).status).toBe('ok')
      // 第二次只剩 B（A 的事件已在 source_events 里）
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 2 })
      expect(client.requests).toHaveLength(2)
      expect(client.requests[1].events[0].eventIds).toEqual([2])
    } finally {
      db.close()
    }
  })

  it('手动 dayStart：只归纳指定日，今天的事件留给今天', async () => {
    const db = openDatabase(':memory:')
    try {
      const yesterday = NOW - 24 * 60 * 60_000
      const yesterdayStart = startOfLocalDay(yesterday)
      // 昨天一条、今天一条
      insertEvent(db, { ts: yesterday, app: 'old.exe', windowTitle: '昨天', ocrText: '旧内容' })
      insertEvent(db, { ts: NOW - 10 * 60_000, app: 'new.exe', windowTitle: '今天', ocrText: '新内容' })
      const client = new FakeLlmClient([
        {
          json: {
            nodes: [{ title: '昨天的事', summary: 'S', type: 'activity', event_ids: [1] }],
            edges: []
          }
        },
        {
          json: {
            nodes: [{ title: '今天的事', summary: 'S', type: 'activity', event_ids: [2] }],
            edges: []
          }
        }
      ])
      const service = makeService(db, client)

      const oldOutcome = await service.runOnce({ manual: true, dayStart: yesterdayStart })
      expect(oldOutcome.status).toBe('ok')
      expect(client.requests[0].events.map((event) => event.eventIds)).toEqual([[1]])

      // 不传 dayStart = 今天，只处理今天那条
      const todayOutcome = await service.runOnce({ manual: true })
      expect(todayOutcome.status).toBe('ok')
      expect(client.requests[1].events.map((event) => event.eventIds)).toEqual([[2]])
    } finally {
      db.close()
    }
  })

  it('stop 后再 start 可重入（暂停解除后恢复调度）', () => {
    const db = makeDb()
    try {
      const service = createInductionService({
        db,
        getClient: () => new FakeLlmClient([]),
        now: () => NOW,
        firstDelayMs: 5_000,
        intervalMs: 600_000
      })
      service.start()
      service.stop()
      expect(service.isActive()).toBe(false)
      expect(service.getState().status).toBe('stopped')

      service.start()
      expect(service.isActive()).toBe(true)
      expect(service.getState().nextRunAt).toBe(NOW + 5_000)
      service.stop()
    } finally {
      db.close()
    }
  })
})
