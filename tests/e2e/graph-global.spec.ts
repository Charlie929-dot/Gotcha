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
 * 5. 日历日格计数（热力档位 + tooltip）；
 * 6. 「只看主题」；
 * 7. 经典 sigma 页互切。
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
  clock(): { fromMinute: number; toMinute: number }
  setClock(fromMinute: number, toMinute: number): void
  searchHits(): number[] | null
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

function searchHits(): Promise<number[] | null> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.searchHits()
  )
}

function clock(): Promise<{ fromMinute: number; toMinute: number }> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.clock()
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
  // e1 故意用 OCR 的逐字空格形态：检索必须在归一化索引上命中连续中文词
  const e1 = insertEvent(db, { ts: t1, app: 'Code', windowTitle: 'a.ts', ocrText: '改 按 钮 样 式' })
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

  test('模型缺失：顶部黄条提示「新主题暂无法计算」，已有图照画', async () => {
    // E2E 的 userData 里没有 bge 模型 → isModelReady=false
    await expect(graph.locator('#model-warning')).toBeVisible({ timeout: 15_000 })
    await expect(graph.locator('#model-warning')).toContainText('新主题暂无法计算')
    await expect(graph.locator('#model-warning-text')).toContainText('bge-small-zh-v1.5')

    // 不清图、不改计数：黄条只说明「新的算不出来」
    await expect(graph.locator('#node-count')).toContainText('2 个主题 · 2 个时刻')
    expect((await nodeIds()).length).toBe(4)
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
    await expect(graph.locator('#empty')).toContainText('所选时间范围没有主题或时刻')

    await graph.evaluate(() => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays(null)
    })
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)
    expect(await focusDays()).toBeNull()
  })

  test('日历真实鼠标：点日期不关弹层 / 拖拽涂抹 / × 只关弹层', async () => {
    const resetDays = (): Promise<void> =>
      graph.evaluate(() => {
        ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays(null)
      })
    await resetDays()

    await graph.locator('#calendar-btn').click()
    await expect(graph.locator('#calendar')).toBeVisible()

    const cells = graph.locator('#cal-grid button:not(.dim)')
    const firstKey = await cells.first().getAttribute('data-key')
    expect(firstKey).toBeTruthy()

    // 单击一天：弹层必须留着（回归：mousedown 里重建 DOM → 外部点击判断误判成「点在外面」）
    const firstBox = (await cells.first().boundingBox())!
    await graph.mouse.click(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2)
    await expect(graph.locator('#calendar')).toBeVisible()
    expect(await focusDays()).toEqual([firstKey!])
    await expect(graph.locator(`#cal-grid button[data-key="${firstKey}"]`)).toHaveClass(/\bon\b/)

    // 涂抹：从某天按住拖到相邻的另一天，两次落在同一选择范围里
    const boxes = await cells.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        const element = node as HTMLElement
        return { key: element.dataset.key ?? '', x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      })
    )
    const pair = boxes
      .flatMap((from, i) => boxes.slice(i + 1).map((to) => ({ from, to })))
      .find(
        ({ from, to }) =>
          Math.abs(from.y - to.y) < 1.5 && to.x - from.x > from.w * 0.9 && to.x - from.x < from.w * 1.6
      )
    expect(pair, '日历里应能找到同一行的相邻两格').toBeTruthy()
    const { from, to } = pair!

    await graph.mouse.move(from.x + from.w / 2, from.y + from.h / 2)
    await graph.mouse.down()
    await graph.mouse.move(to.x + to.w / 2, to.y + to.h / 2, { steps: 8 })
    await graph.mouse.up()

    await expect(graph.locator('#calendar')).toBeVisible()
    const smeared = await focusDays()
    expect(smeared).toEqual([from.key, to.key].sort())
    await expect(graph.locator(`#cal-grid button[data-key="${from.key}"]`)).toHaveClass(/\bon\b/)
    await expect(graph.locator(`#cal-grid button[data-key="${to.key}"]`)).toHaveClass(/\bon\b/)
    await expect(graph.locator('#day-label')).toHaveText(`${from.key} ~ ${to.key}`)

    // 快捷范围不改弹层开合，× 只关弹层、不关图谱窗口
    await graph.locator('#calendar [data-preset="7d"]').click()
    await expect(graph.locator('#calendar')).toBeVisible()
    expect((await focusDays())?.length).toBe(7)

    await graph.locator('#cal-close').click()
    await expect(graph.locator('#calendar')).toBeHidden()
    await expect(graph.locator('#calendar-btn')).toBeVisible()

    // 重新打开后仍是原选择；点工具栏按钮可再次收起
    await graph.locator('#calendar-btn').click()
    await expect(graph.locator('#calendar')).toBeVisible()
    await graph.locator('#calendar-btn').click()
    await expect(graph.locator('#calendar')).toBeHidden()

    await resetDays()
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)
  })

  test('日历日格：事件百分比 → 连续热力，满量可在设置抽屉调', async () => {
    await graph.evaluate(() => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays(null)
    })
    await graph.locator('#calendar-btn').click()
    await expect(graph.locator('#calendar')).toBeVisible()

    const todayCell = (): ReturnType<typeof graph.locator> =>
      graph.locator(`#cal-grid button[data-key="${todayKey}"]`)
    const heatAlphaOf = async (): Promise<number> =>
      Number(
        await todayCell().evaluate((node) => (node as HTMLElement).style.getPropertyValue('--heat-alpha'))
      )

    // 种子：今天 3 条事件 / 2 个时刻 / 2 个主题；默认满量 4000 → 0%，但颜色仍要有一点点
    await expect(todayCell()).toHaveAttribute(
      'title',
      `${todayKey} · 3 条事件（0%）· 2 个时刻 · 2 个主题`
    )
    const before = await heatAlphaOf()
    expect(before).toBeGreaterThan(0)

    // 没有记录的日子不着色，tooltip 明说「无记录」
    const empty = graph.locator('#cal-grid button').first()
    await expect(empty).toHaveAttribute('title', /· 无记录$/)
    expect(
      await empty.evaluate((node) => (node as HTMLElement).style.getPropertyValue('--heat-alpha'))
    ).toBe('')

    // 满量调到 100 → 同一天变 3%，颜色更深（设置抽屉 → 保存 → 重开日历生效）
    await graph.locator('#cal-close').click()
    await graph.locator('#settings').click()
    await expect(graph.locator('#set-day-heat')).toHaveValue('4000')
    await graph.locator('#set-day-heat').fill('100')
    await graph.locator('#settings-save').click()
    await expect(graph.locator('#settings-msg')).toHaveText('已保存', { timeout: 15_000 })
    await graph.locator('#settings-close').click()

    await graph.locator('#calendar-btn').click()
    await expect(graph.locator('#calendar')).toBeVisible()
    await expect(todayCell()).toHaveAttribute(
      'title',
      `${todayKey} · 3 条事件（3%）· 2 个时刻 · 2 个主题`
    )
    expect(await heatAlphaOf()).toBeGreaterThan(before)

    // 翻月不重建失败：仍按同一份计数渲染（切月后格子还在、今天的颜色还在）
    await graph.locator('#cal-next').click()
    await expect(graph.locator('#cal-grid button')).toHaveCount(42)
    await graph.locator('#cal-prev').click()
    expect(await heatAlphaOf()).toBeGreaterThan(before)

    await graph.locator('#cal-close').click()
    await expect(graph.locator('#calendar')).toBeHidden()
  })

  test('日历时段滚轮：选起时立即调暗，全天一键复位', async () => {
    await graph.evaluate((day) => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays([day])
    }, todayKey)
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)

    await graph.locator('#calendar-btn').click()
    await expect(graph.locator('#calendar')).toBeVisible()
    await expect(graph.locator('#clock-label')).toHaveText('全天')

    // 点「10」时：起 10:00 → 09:00 的时刻与主题调暗（种子：09:00 Code / 10:00 Chrome）
    await graph.locator('#from-hour .time-item[data-value="10"]').click()
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(2)
    await expect(graph.locator('#clock-label')).toHaveText('10:00–23:59')
    await expect(graph.locator('#day-label')).toHaveText(`${todayKey} · 10:00–23:59`)
    expect(await clock()).toEqual({ fromMinute: 600, toMinute: 1439 })

    // 滚回 00 时 → 恢复全天（不用点按钮）
    await graph.locator('#from-hour .time-item[data-value="00"]').click()
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)
    await expect(graph.locator('#clock-label')).toHaveText('全天')

    // 09:00–18:00（E2E 钩子设置）→ 一键全天
    await graph.evaluate(() => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setClock(540, 1080)
    })
    await expect(graph.locator('#clock-label')).toHaveText('09:00–18:00')
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)
    await graph.locator('#clock-all').click()
    await expect(graph.locator('#clock-label')).toHaveText('全天')
    expect(await clock()).toEqual({ fromMinute: 0, toMinute: 1439 })

    await graph.locator('#cal-close').click()
    await graph.evaluate(() => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays(null)
    })
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)
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

  test('门一检索：输入只筛图谱，点「检索」/回车才出文字卡片', async () => {
    // app 过滤器候选项（全部应用 + 种子的两个 app）
    await expect(graph.locator('#search-app option')).toHaveCount(3, { timeout: 15_000 })

    // 输入即筛（不按回车）：连续 4 字 → trigram MATCH；原文是「改 按 钮 样 式」
    await graph.locator('#search-input').fill('按钮样式')
    await expect.poll(searchHits, { timeout: 15_000 }).toEqual([1])
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(2)
    await expect(graph.locator('#search-status')).toContainText('1 条命中')
    // 没点检索：结果卡片不出现
    await expect(graph.locator('#search-results')).toBeHidden()

    // 点「检索」：同一查询列出时刻卡片
    await graph.locator('#search-submit').click()
    await expect(graph.locator('#search-results')).toBeVisible()
    await expect(graph.locator('#search-list li')).toHaveCount(1, { timeout: 15_000 })
    const card = graph.locator('#search-list li').first()
    await expect(card).toContainText('Code')
    await expect(card).toContainText('a.ts')
    await expect(card).toContainText('按钮样式')
    await expect(card).toHaveAttribute('data-moment-id', '1')

    // 卡片点开 → 侧栏原始事件（时刻 1 含同窗口 2 条事件）
    await card.click()
    await expect(graph.locator('#panel')).toBeVisible()
    await expect(graph.locator('#panel-title')).toContainText('Code')
    await expect(graph.locator('#panel-events li')).toHaveCount(2)
    await expect(graph.locator('#panel-events li').first()).toContainText('改 按 钮 样 式')

    // 改输入 → 旧卡片立即收起，图谱继续即时筛选（两字词走 LIKE 兜底）
    await graph.locator('#search-input').fill('按钮')
    await expect(graph.locator('#search-results')).toBeHidden()
    await expect.poll(searchHits, { timeout: 15_000 }).toEqual([1])

    // app 过滤：Chrome 下「用法」命中时刻 2（同时属于两个主题）→ 只调暗时刻 1
    await graph.locator('#search-input').fill('用法')
    await graph.locator('#search-app').selectOption('Chrome')
    await expect.poll(searchHits, { timeout: 15_000 }).toEqual([2])
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(1)
    await graph.locator('#search-submit').click()
    await expect(graph.locator('#search-list li').first()).toContainText('文档')

    // app 换成 Code → 没命中：图谱全暗 + 空态；点检索给空卡片
    await graph.locator('#search-app').selectOption('Code')
    await expect(graph.locator('#search-results')).toBeHidden()
    await expect.poll(searchHits, { timeout: 15_000 }).toEqual([])
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(4)
    await expect(graph.locator('#empty')).toContainText('没有找到这段记忆')
    await graph.locator('#search-submit').click()
    await expect(graph.locator('#search-list li.empty')).toContainText('没有找到这段记忆')

    // 标题过滤 + 时间窗：检索结果同样受时间筛选约束
    await graph.locator('#search-app').selectOption('')
    await graph.locator('#search-title').fill('文档')
    await expect.poll(searchHits, { timeout: 15_000 }).toEqual([2])
    await graph.evaluate((day) => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays([day])
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setClock(540, 570)
    }, todayKey)
    // 09:00–09:30 内没有「用法」（e3 在 10:00）→ 卡片为空
    await expect(graph.locator('#search-results')).toBeHidden()
    await expect.poll(searchHits, { timeout: 15_000 }).toEqual([])
    await graph.locator('#search-submit').click()
    await expect(graph.locator('#search-list li.empty')).toBeVisible()

    // 清掉时间筛选：文字筛选与卡片恢复
    await graph.evaluate(() => {
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setDays(null)
      ;(window as unknown as { __gotchaGraphView: GlobalDebug }).__gotchaGraphView.setClock(0, 1439)
    })
    await expect.poll(searchHits, { timeout: 15_000 }).toEqual([2])
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(1)
    await graph.locator('#search-submit').click()
    await expect(graph.locator('#search-list li')).toHaveCount(1)

    // Esc：先关卡片（筛选保留），再按一次清筛选；都不关窗口
    await graph.locator('#search-input').press('Escape')
    await expect(graph.locator('#search-results')).toBeHidden()
    expect(await searchHits()).toEqual([2])
    await graph.locator('#search-input').press('Escape')
    await expect.poll(searchHits, { timeout: 5_000 }).toBeNull()
    await expect.poll(dimmedCount, { timeout: 5_000 }).toBe(0)
    await expect(graph.locator('#search-status')).toHaveText('')
    await expect(graph.locator('foam-graph')).toBeVisible()
  })

  test('经典视图互切：全局 Foam 页 ↔ 旧 sigma 按日页', async () => {
    await graph.locator('#view-classic').click()
    await graph.waitForSelector('#sigma-container')
    await expect(graph.locator('#view-global')).toBeVisible()
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '2', {
      timeout: 15_000
    })

    // 回归：两页共用同一个设置面板，经典页没有「视图」段；保存必须成功，
    // 且不能把全局页的日格满量（上一条用例改成 100）用空值覆盖回 4000
    await graph.locator('#settings').click()
    await expect(graph.locator('#set-day-heat')).toHaveCount(0)
    await graph.locator('#settings-save').click()
    await expect(graph.locator('#settings-msg')).toHaveText('已保存', { timeout: 15_000 })
    await graph.locator('#settings-close').click()

    await graph.locator('#view-global').click()
    await graph.waitForSelector('foam-graph')
    await expect(graph.locator('#node-count')).toContainText('2 个主题 · 2 个时刻', {
      timeout: 15_000
    })
    await expect.poll(async () => (await nodeIds()).length, { timeout: 15_000 }).toBe(4)

    // 满量仍是 100（没被经典页的保存清掉）
    await graph.locator('#calendar-btn').click()
    await expect(graph.locator(`#cal-grid button[data-key="${todayKey}"]`)).toHaveAttribute(
      'title',
      `${todayKey} · 3 条事件（3%）· 2 个时刻 · 2 个主题`
    )
    await graph.locator('#cal-close').click()
  })
})
