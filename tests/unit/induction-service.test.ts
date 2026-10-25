import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, insertEvent } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import { readCursor, startOfLocalDay } from '../../src/understand/cloud/batch'
import {
  FakeLlmClient,
  LlmAbortError,
  LlmError,
  LlmHttpError,
  LlmNetworkError,
  LlmParseError,
  LlmTimeoutError,
  type LlmClient
} from '../../src/understand/cloud/llm-client'
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
      // 结构非法（编造 id）才走修复重试；覆盖缺口已改为确定性补齐（见下方用例）
      const invalid = {
        nodes: [{ title: '只有一条', summary: '编造了 id', type: 'knowledge', event_ids: [1, 99] }],
        edges: []
      }
      const client = new FakeLlmClient([{ json: invalid }, { json: VALID }])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 2 })
      expect(client.optionCalls).toHaveLength(2)
      expect(client.optionCalls[1].repair?.errors.join('；')).toContain('不是本批事件 id')
      expect(readUsage(db, NOW)).toMatchObject({ calls: 2 })
    } finally {
      db.close()
    }
  })

  it('同一时刻只回显第一个 id：自动补齐、不失败、不重复出云', async () => {
    const db = makeDb()
    try {
      // 两个事件同 app + 同标题 + 相邻 1 分钟 → 同一个时刻（event_ids = [1, 2]）
      const client = new FakeLlmClient([
        { json: { nodes: [{ title: '读代码', summary: 'S', type: 'activity', event_ids: [1] }], edges: [] } }
      ])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 1, coverage: { filled: 1, uncovered: 0 } })
      expect(db.prepare('SELECT source_events FROM nodes').get()).toEqual({ source_events: '[1,2]' })
      // 一次性成功：没有为覆盖缺口浪费修复重试
      expect(client.requests).toHaveLength(1)
      expect(await makeService(db, client).runOnce()).toEqual({ status: 'empty' })
    } finally {
      db.close()
    }
  })

  it('整段时刻被模型忽略：落本地「未归纳时段」兜底节点，事件不丢', async () => {
    const db = openDatabase(':memory:')
    try {
      // 两个不同的时刻（标题不同），模型只归纳了第一个
      insertEvent(db, { ts: NOW - 10 * 60_000, app: 'code.exe', windowTitle: 'a.ts', ocrText: '读代码' })
      insertEvent(db, { ts: NOW - 9 * 60_000, app: 'chrome.exe', windowTitle: 'B 站', ocrText: '看视频' })
      const client = new FakeLlmClient([
        { json: { nodes: [{ title: '读代码', summary: 'S', type: 'activity', event_ids: [1] }], edges: [] } }
      ])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 2, coverage: { filled: 0, uncovered: 1 } })
      const rows = db
        .prepare('SELECT type, title, summary, source_events FROM nodes ORDER BY id')
        .all() as Array<Record<string, unknown>>
      expect(rows).toEqual([
        { type: 'activity', title: '读代码', summary: 'S', source_events: '[1]' },
        {
          type: 'activity',
          title: '未归纳时段',
          summary: '该时段模型未归纳，本地兜底（未出云）',
          source_events: '[2]'
        }
      ])
      // 兜底节点也覆盖事件：不会因为缺口反复重试同批
      expect(await makeService(db, client).runOnce()).toEqual({ status: 'empty' })
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

  it('修复重试仍非法（编造 id）：整批失败、游标不动、不写节点', async () => {
    const db = makeDb()
    try {
      const invalid = {
        nodes: [{ title: '只有一条', summary: '编造了 id', type: 'knowledge', event_ids: [1, 99] }]
      }
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
          }),
        // P2 在线路径（命名 / 模糊确认）在本用例里不会发生
        completeNaming: async () => {
          throw new Error('unused: completeNaming')
        },
        completeAssignments: async () => {
          throw new Error('unused: completeAssignments')
        }
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

  it('在线路径可用时自动跑批让位（online），手动「立即归纳」仍可补历史', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([{ json: VALID }])
      const service = createInductionService({
        db,
        getClient: () => client,
        now: () => NOW,
        shouldAutoRun: () => false
      })
      expect(await service.runOnce()).toEqual({ status: 'skipped', reason: 'online' })
      expect(client.requests).toHaveLength(0)
      expect((await service.runOnce({ manual: true })).status).toBe('ok')
      expect(client.requests).toHaveLength(1)
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
      // 用结构非法（type 越界）制造失败：覆盖缺口已改为确定性补齐，不再是失败理由
      const invalid = { nodes: [{ title: '只有一条', summary: 'S', type: 'idea', event_ids: [1] }] }
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

describe('induction service · 失败分类与停自动（可观测性）', () => {
  const INVALID = {
    nodes: [{ title: '只有一条', summary: 'S', type: 'idea', event_ids: [1] }]
  }

  it('失败写 lastFailure（分类 + 连续次数），下一次运行开始时清空', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([new LlmHttpError(429)])
      const service = makeService(db, client)

      const outcome = await service.runOnce()
      expect(outcome.status).toBe('error')
      expect(service.getState().lastFailure).toMatchObject({
        code: 'http',
        status: 429,
        streak: 1
      })
      expect(service.getState().lastError).toContain('429')

      // 下一次开始（running）立刻清掉旧失败，避免 UI 把上次原因挂在运行中
      client.push({ json: VALID })
      const pending = service.runOnce()
      expect(service.getState().lastFailure).toBeUndefined()
      expect((await pending).status).toBe('ok')
      expect(service.getState().lastSuccessAt).toBe(NOW)
    } finally {
      db.close()
    }
  })

  it('超长标题截断后照常落库（不再整批失败）', async () => {
    const db = makeDb()
    try {
      const longTitle = {
        nodes: [
          { title: '标'.repeat(50), summary: '摘要', type: 'knowledge', event_ids: [1, 2] }
        ],
        edges: []
      }
      const client = new FakeLlmClient([{ json: longTitle }])
      const outcome = await makeService(db, client).runOnce()

      expect(outcome).toMatchObject({ status: 'ok', nodes: 1 })
      if (outcome.status === 'ok') {
        expect(outcome.truncated).toEqual({ titles: 1, summaries: 0, evidence: 0 })
      }
      const row = db.prepare('SELECT title FROM nodes').get() as { title: string }
      expect(row.title).toHaveLength(40)
      // 一次调用就够：长度不再是校验错误，不需要修复重试
      expect(client.requests).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('校验失败单独分类（validation），消息与 details 带具体规则', async () => {
    const db = makeDb()
    try {
      const client = new FakeLlmClient([{ json: INVALID }, { json: INVALID }])
      const service = makeService(db, client)

      const outcome = await service.runOnce()
      expect(outcome.status).toBe('error')
      const failure = service.getState().lastFailure
      expect(failure?.code).toBe('validation')
      expect(failure?.message).toContain('未通过校验')
      expect(failure?.message).toContain('只能是 knowledge / activity')
      expect(failure?.details).toEqual(['nodes[0].type 只能是 knowledge / activity'])
      // 修复重试仍然只有一次
      expect(client.requests).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('失败分类：超时 / 网络 / 配置 / 未知各归各类', async () => {
    const cases: Array<[Error, string]> = [
      [new LlmTimeoutError(), 'timeout'],
      [new LlmNetworkError(), 'network'],
      [new LlmError('缺少 API key', 'config'), 'config'],
      [new Error('boom'), 'unknown']
    ]
    for (const [error, code] of cases) {
      const db = makeDb()
      try {
        const service = makeService(db, new FakeLlmClient([error]))
        expect((await service.runOnce()).status).toBe('error')
        expect(service.getState().lastFailure?.code).toBe(code)
        expect(service.getState().lastFailure?.streak).toBe(1)
      } finally {
        db.close()
      }
    }
  })

  it('连续失败达上限停自动（不再排下次）；手动成功一次即恢复排程', async () => {
    vi.useFakeTimers()
    const db = makeDb()
    try {
      setSetting(db, 'graph.max_consecutive_failures', '2')
      const client = new FakeLlmClient([
        { json: INVALID },
        { json: INVALID },
        { json: INVALID },
        { json: INVALID },
        { json: VALID }
      ])
      const service = createInductionService({
        db,
        getClient: () => client,
        now: () => NOW,
        firstDelayMs: 5_000,
        intervalMs: 600_000
      })
      service.start()

      // 第 1 次失败 → 退避 1 分钟后重试
      await vi.advanceTimersByTimeAsync(5_000)
      expect(service.getState().status).toBe('backoff')
      expect(service.getState().lastFailure).toMatchObject({ code: 'validation', streak: 1 })
      expect(service.getState().nextRunAt).toBe(NOW + 60_000)

      // 第 2 次失败 → 到上限：停自动，不再排下一次
      await vi.advanceTimersByTimeAsync(60_000)
      expect(service.getState().status).toBe('error')
      expect(service.getState().halted).toBe(true)
      expect(service.getState().lastFailure?.streak).toBe(2)
      expect(service.getState().nextRunAt).toBeUndefined()

      // 再过一小时也不会自己重试（不会无限 1/5/15 分钟循环）
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(client.pending).toBe(1)

      // 手动「立即归纳」成功：解除停自动并恢复排程
      expect((await service.runOnce({ manual: true })).status).toBe('ok')
      expect(service.getState().halted).toBe(false)
      expect(service.getState().nextRunAt).toBe(NOW + 600_000)
    } finally {
      db.close()
    }
  })

  it('start 复位停自动状态（采集重启后回到正常调度）', async () => {
    const db = makeDb()
    try {
      setSetting(db, 'graph.max_consecutive_failures', '1')
      const service = createInductionService({
        db,
        getClient: () => new FakeLlmClient([new Error('boom')]),
        now: () => NOW,
        firstDelayMs: 5_000
      })
      service.start()
      await service.runOnce()
      expect(service.getState().halted).toBe(true)
      service.stop()
      service.start()
      expect(service.getState().halted).toBe(false)
      service.stop()
    } finally {
      db.close()
    }
  })
})

