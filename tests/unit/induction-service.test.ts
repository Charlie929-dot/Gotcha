import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, insertEvent } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import { readCursor } from '../../src/understand/cloud/batch'
import { FakeLlmClient, LlmAbortError, type LlmClient } from '../../src/understand/cloud/llm-client'
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
  it('合法输出：落节点与边、推进游标、记账 usage', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([{ json: VALID, usage: { promptTokens: 120, completionTokens: 30 } }])
      const service = makeService(db, client)
      const outcome = await service.runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 2, edges: 1, placeholders: 0, consumed: 2 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 2 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 1 })
      expect(readCursor(db)).toEqual({ ts: NOW - 9 * 60_000, id: 2 })
      expect(readUsage(db, NOW)).toEqual({ calls: 1, promptTokens: 120, completionTokens: 30 })
      expect(client.requests).toHaveLength(1)
      expect(client.optionCalls[0].signal).toBeInstanceOf(AbortSignal)
      expect(client.requests[0].events[0].eventIds).toEqual([1, 2])
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
      expect(client.optionCalls[1].repairHint).toContain('未被任何节点覆盖')
      expect(readUsage(db, NOW)).toMatchObject({ calls: 2 })
    } finally {
      db.close()
    }
  })

  it('修复重试仍非法：整批失败、游标不动、不写节点', async () => {
    const db = makeDb()
    try {
      const invalid = { nodes: [{ title: '只有一条', summary: '漏了事件 2', type: 'knowledge', event_ids: [1] }] }
      const client = new FakeLlmClient([{ json: invalid }, { json: invalid }])
      const service = makeService(db, client)
      const outcome = await service.runOnce()

      expect(outcome.status).toBe('error')
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 })
      expect(readCursor(db)).toEqual({ ts: 0, id: 0 })
      expect(readUsage(db, NOW)).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0 })
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
    } finally {
      db.close()
    }
  })

  it('全部时刻不可剥离：只生成「内容已保护」占位节点，不调用 LLM、游标照常推进', async () => {
    const db = makeDb({ ocr: '请输入密码' })
    try {
      const client = new FakeLlmClient([])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 1, placeholders: 1 })
      expect(client.requests).toHaveLength(0)
      const row = db.prepare('SELECT type, title FROM nodes').get() as Record<string, unknown>
      expect(row).toMatchObject({ type: 'protected', title: '内容已保护' })
      expect(readCursor(db)).toEqual({ ts: NOW - 9 * 60_000, id: 2 })
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
})
