/**
 * v0.3 全局图谱页 E2E（P3-a）
 *
 * 隔离：`GOTCHA_USER_DATA` 临时目录 + 假采集/假 LLM；不启动真实录屏 / OCR / 网络。
 * 数据：beforeAll 直接种 2 个主题 / 2 个时刻 / 3 条归属 / 1 条 embedding 边，
 * 并让事件分组与 `moments` 行完全一致，避免打开图谱时的结构回填再插入时刻。
 *
 * 覆盖：
 * 1. 全局计数（主题 + 时刻 + 相似连线）与 Foam 画布；
 * 2. 主题下钻（成员事件）；
 * 3. 多归属时刻侧栏「也属于」+ 原始事件；
 * 4. 日历调暗不删节点；
 * 5. 「只看主题」；
 * 6. 经典 sigma 页互切。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertEvent, openDatabase } from '../../src/db'

const APP_ARGS = ['.'] as const
const DAY_MS = 24 * 60 * 60 * 1000

let userDataDir: string
let app: ElectronApplication
let graph: Page
let todayKey: string
let otherKey: string

interface GlobalDebug {
  count(): number
  select(nodeId: number | string): Promise<void>
  focus(nodeId: number | string): void
  clearFocus(): void
  position(nodeId: number | string): { x: number; y: number } | null
  filters(): Record<string, boolean>
  visibleCounts(): { nodes: number; edges: number; themes?: number; moments?: number }
  dimmedCount(): number
  focusDays(): string[] | null
  setDays(list: string[] | null): void
  onlyThemes(): boolean
  setOnlyThemes(value: boolean): void
  nodeIds(): string[]
}

interface GraphWindowApi {
  global(): Promise<{
    stats: { themes: number; moments: number; memberships: number; edges: number; positions: number }
  }>
  nodeEvents(nodeId: number): Promise<{ found: boolean; events: Array<{ id: number }>; missingIds: number[] }>
  momentEvents(
    momentId: number
  ): Promise<{ found: boolean; events: Array<{ id: number; app: string }>; missingIds: number[] }>
}

function localDayKey(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function nodeIds(): Promise<string[]> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.nodeIds()
  )
}

function dimmedCount(): Promise<number> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.dimmedCount()
  )
}

function focusDays(): Promise<string[] | null> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.focusDays()
  )
}

function filters(): Promise<Record<string, boolean>> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.filters()
  )
}

function visibleCounts(): Promise<{ nodes: number; edges: number; themes?: number; moments?: number }> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.visibleCounts()
  )
}

test.beforeAll(async () => {
  // DSH 宿主会注入 ELECTRON_RUN_AS_NODE=1，子进程里必须清掉（gotchas.md）
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-global-e2e-'))

  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const t1 = dayStart.getTime() + 9 * 60 * 60_000
  const t3 = dayStart.getTime() + 10 * 60 * 60_000
  todayKey = localDayKey(t1)
  otherKey = localDayKey(t1 - 3 * DAY_MS)

  const db = openDatabase(join(userDataDir, 'memory.db'))
  const e1 = insertEvent(db, { ts: t1, app: 'Code', windowTitle: 'a.ts', ocrText: '改按钮样式' })
  const e2 = insertEvent(db, {
    ts: t1 + 30_000,
    app: 'Code',
    windowTitle: 'a.ts',
    ocrText: '调试悬停状态'
  })
  const e3 = insertEvent(db, { ts: t3, app: 'Chrome', windowTitle: '文档', ocrText: '查 API 用法' })

  // 主题（level=1；source_events 与主题 1/2 一致，回填 owner 归属幂等）
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'knowledge', '按钮调试', '修复悬停态', t1, t1 + 30 * 60_000, JSON.stringify([e1, e2]))
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  ).run(2, 'activity', '查文档', '翻 API 文档', t3, t3 + 30 * 60_000, JSON.stringify([e3]))

  // 时刻：分组口径与 groupMoments 完全一致（同 app+标题、≤90s；day_key 当天）
  db.prepare(
    `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(1, t1, t1 + 30_000, todayKey, 'Code', 'a.ts', '改按钮样式 / 调试悬停状态', JSON.stringify([e1, e2]))
  db.prepare(
    `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(2, t3, t3, todayKey, 'Chrome', '文档', '查 API 用法', JSON.stringify([e3]))

  // 时刻 2 同时属于两个主题（owner=查文档，secondary=按钮调试）
  db.prepare(
    'INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at) VALUES (?, ?, 1, ?, 1)'
  ).run(1, 1, 'owner')
  db.prepare(
    'INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at) VALUES (?, ?, 1, ?, 1)'
  ).run(2, 2, 'owner')
  db.prepare(
    'INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at) VALUES (?, ?, 0.9, ?, 1)'
  ).run(1, 2, 'secondary')

  db.prepare(
    'INSERT INTO edges (id, src, dst, weight, kind, evidence) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(100, 1, 2, 0.82, 'embedding', '{"model":"bge"}')
  db.close()

  app = await electron.launch({
    args: [...APP_ARGS],
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      GOTCHA_USER_DATA: userDataDir,
      GOTCHA_FAKE_CAPTURE: '1',
      GOTCHA_FAKE_LLM: '1'
    }
  })
  const ball = await app.firstWindow()
  await ball.waitForSelector('#ball')
  await ball.waitForTimeout(400)

  const graphPromise = app.waitForEvent('window')
  await app.evaluate(() => globalThis.__gotchaTest!.openGraph())
  graph = await graphPromise
  await graph.waitForLoadState('domcontentloaded')
  await graph.waitForSelector('#status')
  await graph.waitForSelector('foam-graph')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test.describe.serial('全局图谱（主题 + 时刻 + 日历调暗）', () => {
  test('全局计数：2 主题 / 2 时刻 / 1 条相似连线，Foam 画布出现', async () => {
    await expect(graph.locator('#node-count')).toContainText('2 个主题 · 2 个时刻 · 1 条相似连线', {
      timeout: 15_000
    })
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '4')
    await expect(graph.locator('#node-count')).toHaveAttribute('data-edges', '4')
    await expect.poll(async () => (await nodeIds()).length, { timeout: 15_000 }).toBe(4)
    expect(await visibleCounts()).toEqual({ nodes: 4, edges: 4, themes: 2, moments: 2 })

    const stats = await graph.evaluate(async () =>
      (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.global()
    )
    expect(stats.stats).toEqual({ themes: 2, moments: 2, memberships: 3, edges: 1, positions: 0 })
  })

  test('点击主题下钻：侧栏成员事件，来源 100% 可溯', async () => {
    await graph.evaluate(async () => {
      await (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.select(1)
    })
    await expect(graph.locator('#panel')).toBeVisible()
    await expect(graph.locator('#panel-title')).toHaveText('按钮调试')
    await expect(graph.locator('#panel-events li')).toHaveCount(2)
    await expect(graph.locator('#panel-events li').first()).toContainText('Code')
    await expect(graph.locator('#panel-events li').first()).toContainText('a.ts')

    const result = await graph.evaluate(async () =>
      (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.nodeEvents(1)
    )
    expect(result.found).toBe(true)
    expect(result.missingIds).toEqual([])
    expect(result.events).toHaveLength(2)
  })

  test('点击时刻：原始事件 +「也属于」另一个主题（多归属）', async () => {
    await graph.evaluate(async () => {
      await (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.select('m:2')
    })
    await expect(graph.locator('#panel')).toBeVisible()
    await expect(graph.locator('#panel-title')).toContainText('Chrome')
    await expect(graph.locator('#panel-related-title')).toBeVisible()
    await expect(graph.locator('#panel-related li')).toHaveCount(1)
    await expect(graph.locator('#panel-related li').first()).toContainText('按钮调试')
    await expect(graph.locator('#panel-events li').first()).toContainText('查 API 用法')

    const result = await graph.evaluate(async () =>
      (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.momentEvents(2)
    )
    expect(result.found).toBe(true)
    expect(result.events.map((event) => event.app)).toEqual(['Chrome'])

    // 从「也属于」跳到另一个主题
    await graph.locator('#panel-related li').first().click()
    await expect(graph.locator('#panel-title')).toHaveText('按钮调试')
  })

  test('日历调暗：节点数不变、只改 dimmed；空范围有提示', async () => {
    const before = await nodeIds()
    await graph.evaluate((day) => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays([day])
    }, otherKey)
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(4)
    expect(await nodeIds()).toEqual(before)
    expect(await visibleCounts()).toEqual({ nodes: 4, edges: 4, themes: 2, moments: 2 })
    await expect(graph.locator('#empty')).toBeVisible()
    await expect(graph.locator('#empty')).toContainText('所选日期没有主题或时刻')

    await graph.evaluate(() => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays(null)
    })
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)
    expect(await focusDays()).toBeNull()
  })

  test('「只看主题」：隐藏时刻层，连线只留主题相似边', async () => {
    await graph.locator('#only-themes').check()
    await expect.poll(async () => (await visibleCounts()).nodes).toBe(2)
    expect(await visibleCounts()).toEqual({ nodes: 2, edges: 1, themes: 2, moments: 0 })
    expect(await filters()).toEqual({ moment: false })

    await graph.locator('#only-themes').uncheck()
    await expect.poll(async () => (await visibleCounts()).nodes).toBe(4)
    expect(await visibleCounts()).toEqual({ nodes: 4, edges: 4, themes: 2, moments: 2 })
  })

  test('Foam 沉降后把主题坐标回写 node_positions（下次打开作 seed）', async () => {
    const openReadonly = (): Database.Database =>
      new Database(join(userDataDir, 'memory.db'), { readonly: true })
    let count = 0
    try {
      await expect
        .poll(
          () => {
            const db = openReadonly()
            try {
              const row = db.prepare('SELECT COUNT(*) AS n FROM node_positions').get() as {
                n: number
              }
              count = row.n
              return row.n
            } finally {
              db.close()
            }
          },
          { timeout: 20_000 }
        )
        .toBeGreaterThanOrEqual(2)
      const db = openReadonly()
      try {
        const rows = db
          .prepare('SELECT node_id, x, y FROM node_positions ORDER BY node_id')
          .all() as Array<{ node_id: number; x: number; y: number }>
        expect(rows.map((row) => row.node_id).sort()).toEqual([1, 2])
        for (const row of rows) {
          expect(Number.isFinite(row.x)).toBe(true)
          expect(Number.isFinite(row.y)).toBe(true)
        }
      } finally {
        db.close()
      }
    } finally {
      expect(count).toBeGreaterThanOrEqual(2)
    }
  })

  test('经典视图互切：全局 Foam 页 ↔ 旧 sigma 按日页', async () => {
    await graph.locator('#view-classic').click()
    await graph.waitForSelector('#sigma-container')
    await expect(graph.locator('#view-global')).toBeVisible()
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '2', {
      timeout: 15_000
    })

    await graph.locator('#view-global').click()
    await graph.waitForSelector('foam-graph')
    await expect(graph.locator('#node-count')).toContainText('2 个主题 · 2 个时刻', {
      timeout: 15_000
    })
    await expect.poll(async () => (await nodeIds()).length, { timeout: 15_000 }).toBe(4)
  })
})
