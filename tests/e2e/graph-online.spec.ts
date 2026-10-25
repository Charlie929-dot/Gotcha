/**
 * 在线归属闭环 E2E（M2 P2 · S7；docs/m2-graph-redesign.md §9.1 / §13.2）
 *
 * 走的是真实主进程接线（不直接调业务函数），只把三样东西换成确定性的假实现：
 * 采集（`GOTCHA_FAKE_CAPTURE`）、LLM（`GOTCHA_FAKE_LLM`）、向量（`GOTCHA_FAKE_EMBEDDING`）。
 * 不启动真实录屏 / OCR / 网络，也不加载 90 MB 真模型。
 *
 * 覆盖一条完整链路：
 * 1. 采集 `running` → `moment-runtime` 把已稳定的事件补成时刻（本地、零出网）；
 * 2. `theme-online-runtime` 用假向量归属：没有主题时各建一个（兜底标题 + `namePending`），
 *    命名任务经串行队列交给假 LLM（D24 确认门已开）→ 节点标题 / 摘要换成模型命名；
 * 3. 打开图谱后再来一个新时刻：归属到已有主题（零额外 LLM）→ `graph:changed` → 画布**就地刷新**；
 * 4. 暂停采集后再跑一轮：`skipped: paused`、零出网（D18）。
 *
 * 时序说明：在线运行时默认 60s 一轮，用例等不起；第二次归属用测试钩子
 * `__gotchaTest.onlineTick()` 直接跑 `runOnce()`，它不会绕过暂停 / 授权 / 预算门。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import { localDayKey } from '../../src/understand/moments'

const APP_ARGS = ['.'] as const

let userDataDir: string
let dbPath: string
let app: ElectronApplication
/** 第二个用例才打开图谱（先让无窗口状态下的在线链路自己跑） */
let graph: Page | null = null
let e1 = 0
let e2 = 0

interface GraphCounts {
  nodes: number
  themes?: number
  moments?: number
}

interface TickResult {
  status: 'done' | 'skipped'
  reason?: string
  moments: number
  embedded: number
  assigned: number
  created: number
  ambiguous: number
  named: number
  namedApplied: number
  confirmed: number
}

/** 只读看库（应用持有写连接，WAL 下并发读安全） */
function withDb<T>(fn: (db: Db) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** 用例自己的写连接（模拟「新事件 / 新时刻」落库，和应用不是同一个连接） */
function withWriteDb<T>(fn: (db: Db) => T): T {
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

function onlineState(): Promise<{
  moments: number
  themes: number
  owners: number
}> {
  return Promise.resolve(
    withDb((db) => ({
      moments: count(db, 'SELECT COUNT(*) AS n FROM moments'),
      themes: count(db, "SELECT COUNT(*) AS n FROM nodes WHERE level = 1"),
      owners: count(db, 'SELECT COUNT(*) AS n FROM theme_moments')
    }))
  )
}

function fakeLlm(): Promise<{ requests: number; aborted: number }> {
  return app.evaluate(() => globalThis.__gotchaTest!.fakeLlm()!)
}

function captureStatus(): Promise<string> {
  return app.evaluate(() => globalThis.__gotchaTest!.status())
}

function onlineTick(): Promise<TickResult | null> {
  return app.evaluate(() => globalThis.__gotchaTest!.onlineTick()) as Promise<TickResult | null>
}

/** 上一轮还在跑时 `runOnce()` 返回 `busy`：等一下再跑（不绕过任何门，只是重试同一入口） */
async function onlineTickDone(): Promise<TickResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await onlineTick()
    if (result?.status === 'done') return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('在线归属连续三轮都没跑起来')
}

function visibleCounts(): Promise<GraphCounts> {
  return graph!.evaluate(
    () =>
      (window as unknown as { __gotchaGraphView: { visibleCounts(): GraphCounts } }).__gotchaGraphView.visibleCounts()
  )
}

/** 新增一个「时刻」（与 moment-builder 的落库形状一致）；返回时刻 id */
function insertMoment(input: {
  ts: number
  app: string
  title: string
  ocr: string
  eventId: number
}): number {
  const end = input.ts + 30_000
  const result = withWriteDb((db) =>
    db
      .prepare(
        `INSERT INTO moments (start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.ts,
        end,
        localDayKey(input.ts),
        input.app,
        input.title,
        input.ocr,
        JSON.stringify([input.eventId]),
        input.ts
      )
  )
  return Number(result.lastInsertRowid)
}

test.beforeAll(async () => {
  // DSH 宿主会注入 ELECTRON_RUN_AS_NODE=1，子进程里必须清掉（gotchas.md）
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-online-e2e-'))
  dbPath = join(userDataDir, 'memory.db')

  const now = Date.now()
  // 两条「已经稳定」的事件（早于 moment-runtime 的 3 分钟水位），app / 标题都不同 → 两个时刻
  const t1 = now - 15 * 60_000
  const t2 = now - 8 * 60_000

  const db = openDatabase(dbPath)
  e1 = insertEvent(db, { ts: t1, app: 'Code', windowTitle: 'a.ts', ocrText: '改按钮样式' })
  e2 = insertEvent(db, { ts: t2, app: 'Chrome', windowTitle: '文档', ocrText: '查接口文档' })

  // 在线路径的判定全走设置：确认门 + 开关；模型目录指到不存在的路径，证明“就绪”来自假向量注入
  setSetting(db, 'graph.outbound_consent', '1')
  setSetting(db, 'graph.online_themes', '1')
  setSetting(db, 'graph.embedding_model_dir', join(userDataDir, 'no-model-for-e2e'))
  db.close()

  app = await electron.launch({
    args: [...APP_ARGS],
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      GOTCHA_USER_DATA: userDataDir,
      GOTCHA_FAKE_CAPTURE: '1',
      GOTCHA_FAKE_LLM: '1',
      GOTCHA_FAKE_EMBEDDING: '1'
    }
  })
  const ball = await app.firstWindow()
  await ball.waitForSelector('#ball')
  await ball.waitForTimeout(400)
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test.describe.serial('在线归属闭环（假采集 + 假 LLM + 假向量）', () => {
  test('采集后：时刻 → 新主题 → 模型命名，全程只发两次命名请求', async () => {
    // 假向量注入让「本地模型就绪」成立，在线路径才会接手新数据
    expect(await app.evaluate(() => globalThis.__gotchaTest!.induction().embeddingsReady)).toBe(true)
    expect((await fakeLlm()).requests).toBe(0)
    // 采集默认暂停（A3 红线）：此刻还没有任何时刻被补出来
    expect(await onlineState()).toEqual({ moments: 0, themes: 0, owners: 0 })

    await app.evaluate(() => globalThis.__gotchaTest!.toggle())
    await expect.poll(captureStatus, { timeout: 8_000 }).toBe('running')

    // moment-runtime 立刻补时刻，theme-online-runtime 同一轮建主题 + 排命名
    await expect.poll(onlineState, { timeout: 20_000 }).toEqual({
      moments: 2,
      themes: 2,
      owners: 2
    })

    // 命名是队列异步回写的：轮询到标题 / 摘要换成模型命名、待命名标记清掉再断言
    const namedThemes = (): Promise<
      Array<{ title: string; summary: string; type: string; pending: boolean }>
    > =>
      Promise.resolve(
        withDb((db) =>
          (
            db
              .prepare(
                'SELECT title, summary, type, meta_json FROM nodes WHERE level = 1 ORDER BY id ASC'
              )
              .all() as Array<{
              title: string
              summary: string
              type: string
              meta_json: string | null
            }>
          ).map((row) => ({
            title: row.title,
            summary: row.summary,
            type: row.type,
            pending: (row.meta_json ?? '').includes('"namePending":true')
          }))
        )
      )
    // 命名来自假 LLM（`模拟主题 <eventId>`），不是本地兜底标题（窗口标题 a.ts / 文档）
    await expect.poll(namedThemes, { timeout: 20_000 }).toEqual([
      { title: `模拟主题 ${e1}`, summary: '来自 Code 的模拟命名', type: 'knowledge', pending: false },
      { title: `模拟主题 ${e2}`, summary: '来自 Chrome 的模拟命名', type: 'knowledge', pending: false }
    ])

    const memberships = withDb(
      (db) =>
        db
          .prepare('SELECT theme_id, moment_id, source FROM theme_moments ORDER BY moment_id ASC')
          .all() as Array<{ theme_id: number; moment_id: number; source: string }>
    )
    expect(memberships).toEqual([
      { theme_id: 1, moment_id: 1, source: 'owner' },
      { theme_id: 2, moment_id: 2, source: 'owner' }
    ])
    // 追溯字段：主题的 source_events 覆盖自己的成员事件
    const sourceEvents = withDb(
      (db) =>
        db
          .prepare('SELECT source_events FROM nodes WHERE level = 1 ORDER BY id ASC')
          .all() as Array<{ source_events: string | null }>
    )
    expect(JSON.parse(sourceEvents[0].source_events ?? '[]')).toEqual([e1])
    expect(JSON.parse(sourceEvents[1].source_events ?? '[]')).toEqual([e2])

    // 向量全部来自假实现：真模型名（bge-small-zh-v1.5）一条都不该出现。
    // 标题向量是 tick 末尾异步补的（命名回调可能刚把主题标脏），只要求「已有行都是假模型」。
    const vectorModels = withDb((db) => ({
      events: (db.prepare('SELECT DISTINCT model FROM event_embeddings').all() as Array<{ model: string }>)
        .map((row) => row.model),
      titles: (db.prepare('SELECT DISTINCT model FROM node_embeddings').all() as Array<{ model: string }>)
        .map((row) => row.model),
      centroids: (db.prepare('SELECT DISTINCT model FROM theme_centroids').all() as Array<{ model: string }>)
        .map((row) => row.model),
      centroidRows: count(db, 'SELECT COUNT(*) AS n FROM theme_centroids')
    }))
    expect(vectorModels.events).toEqual(['fake-embedding-v1'])
    expect(vectorModels.centroids).toEqual(['fake-embedding-v1'])
    expect(vectorModels.centroidRows).toBe(2)
    for (const model of vectorModels.titles) expect(model).toBe('fake-embedding-v1')

    // 在线路径可用时自动批量归纳让位：两次请求都是命名，不是一次批量归纳
    await expect.poll(fakeLlm, { timeout: 10_000 }).toEqual({ requests: 2, aborted: 0 })
  })

  test('打开图谱后新时刻归到已有主题：零额外 LLM，画布就地刷新', async () => {
    const opened = app.waitForEvent('window')
    await app.evaluate(() => globalThis.__gotchaTest!.openGraph())
    graph = await opened
    await graph.waitForLoadState('domcontentloaded')
    await graph.waitForSelector('#status')
    await graph.waitForSelector('foam-graph')

    await expect(graph.locator('#node-count')).toContainText('2 个主题 · 2 个时刻', {
      timeout: 15_000
    })
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '4')
    // 模型目录指向不存在的路径，但假向量注入让“就绪”成立 → 不该出现模型缺失黄条
    await expect(graph.locator('#model-warning')).toBeHidden()

    // 自动刷新有 1.5s 去重窗口（刚全量拉过图），等它过去再制造变化
    await graph.waitForTimeout(1_600)

    // 新时刻：文本与时刻 1 完全一致 → 假向量余弦 1，应归到主题 1，不再建主题
    const ts = Date.now() - 5 * 60_000
    const e3 = withWriteDb((db) =>
      insertEvent(db, { ts, app: 'Code', windowTitle: 'a.ts', ocrText: '改按钮样式' })
    )
    const moment3 = insertMoment({ ts, app: 'Code', title: 'a.ts', ocr: '改按钮样式', eventId: e3 })

    const tick = await onlineTickDone()
    expect(tick).toMatchObject({ status: 'done', assigned: 1, created: 0, ambiguous: 0 })
    expect(tick.moments).toBe(1)

    const after = withDb((db) => ({
      themes: count(db, 'SELECT COUNT(*) AS n FROM nodes WHERE level = 1'),
      memberships: db
        .prepare('SELECT theme_id, source FROM theme_moments WHERE moment_id = ?')
        .all(moment3) as Array<{ theme_id: number; source: string }>,
      sourceEvents: JSON.parse(
        (db.prepare('SELECT source_events FROM nodes WHERE id = 1').get() as { source_events: string })
          .source_events
      ) as number[],
      moments: count(db, 'SELECT COUNT(*) AS n FROM moments')
    }))
    expect(after.themes).toBe(2)
    expect(after.moments).toBe(3)
    expect(after.memberships).toEqual([{ theme_id: 1, source: 'owner' }])
    // 主归属要同步扩展追溯字段（G1）
    expect(after.sourceEvents).toContain(e1)
    expect(after.sourceEvents).toContain(e3)
    // 「已有主题的直接归属」不该再花钱：请求数保持不变
    expect((await fakeLlm()).requests).toBe(2)

    // 主进程推 `graph:changed` → 渲染层就地刷新（不重开窗口）：时刻从 2 变 3
    await expect(graph.locator('#node-count')).toContainText('2 个主题 · 3 个时刻', {
      timeout: 15_000
    })
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '5')
    expect(await visibleCounts()).toMatchObject({ nodes: 5, themes: 2, moments: 3 })
  })

  test('暂停采集后再跑一轮：skipped: paused，零出网', async () => {
    await app.evaluate(() => globalThis.__gotchaTest!.toggle())
    await expect.poll(captureStatus, { timeout: 8_000 }).toBe('paused')
    const before = await fakeLlm()

    const ts = Date.now() - 4 * 60_000
    const e4 = withWriteDb((db) =>
      insertEvent(db, { ts, app: 'Code', windowTitle: 'c.ts', ocrText: '暂停时的新内容' })
    )
    const moment4 = insertMoment({ ts, app: 'Code', title: 'c.ts', ocr: '暂停时的新内容', eventId: e4 })
    void e4

    const tick = await onlineTick()
    expect(tick).toMatchObject({ status: 'skipped', reason: 'paused', moments: 0 })
    expect((await fakeLlm()).requests).toBe(before.requests)

    // 暂停期间不归属：这条时刻仍是「待归纳」（日历空心点口径）
    const owners = withDb(
      (db) => db.prepare('SELECT COUNT(*) AS n FROM theme_moments WHERE moment_id = ?').get(moment4) as { n: number }
    )
    expect(owners.n).toBe(0)
  })
})
