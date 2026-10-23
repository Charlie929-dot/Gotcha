/**
 * M2 Phase 2 E2E：图谱画布 + 下钻 + 设置 + 归纳接线（D20 / D24 / C3 / C4）
 *
 * 隔离：`GOTCHA_USER_DATA` 临时目录 + `GOTCHA_FAKE_CAPTURE=1` + `GOTCHA_FAKE_LLM=1`
 * （三者都要求非打包态）——不启动真实录屏 / OCR、不发真实网络。
 *
 * 覆盖：
 * 1. 未确认出网时自动归纳零请求；确认后「立即归纳」落库，画布出现节点；
 * 2. 节点 source_events 全部可解析回事件行（C4 可溯）；
 * 3. 点击节点 → 侧栏成员事件 →「在时间线中查看」定位到节点日期；
 * 4. 设置抽屉保存归纳参数（D22）；
 * 5. 暂停后「立即归纳」零新增请求、不落库（D18）。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertEvent, openDatabase } from '../../src/db'

const APP_ARGS = ['.'] as const

let userDataDir: string
let app: ElectronApplication
let graph: Page

interface FakeLlmCounter {
  requests: number
  aborted: number
}

interface GraphNodeLite {
  id: number
  tsStart: number
}

interface GraphWindowApi {
  query(
    from: number,
    to: number
  ): Promise<{ nodes: GraphNodeLite[]; edges: Array<{ id: number }> }>
  nodeEvents(nodeId: number): Promise<{ found: boolean; events: unknown[]; missingIds: number[] }>
  induceNow(dayStart?: number): Promise<{ status: string; reason?: string }>
  settings(): Promise<{ intervalMinutes: number }>
}

interface GraphDebug {
  count(): number
  select(nodeId: number): Promise<void>
  focus(nodeId: number | string): void
  clearFocus(): void
  position(nodeId: number): { x: number; y: number } | null
  filters(): Record<string, boolean>
  visibleCounts(): { nodes: number; edges: number }
}

async function fakeLlm(): Promise<FakeLlmCounter> {
  return app.evaluate(() => globalThis.__gotchaTest!.fakeLlm()!) as Promise<FakeLlmCounter>
}

async function captureStatus(): Promise<string> {
  return app.evaluate(() => globalThis.__gotchaTest!.status())
}

/** 取当天节点 id + ts（与 UI 同一天窗口） */
async function nodesToday(): Promise<GraphNodeLite[]> {
  return graph.evaluate(async () => {
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    const to = new Date(from)
    to.setDate(to.getDate() + 1)
    const data = await (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.query(
      from.getTime(),
      to.getTime() - 1
    )
    return data.nodes
  })
}

async function visibleCounts(): Promise<{ nodes: number; edges: number }> {
  return graph.evaluate(
    () =>
      (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.visibleCounts()
  )
}

function dateStamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

test.beforeAll(async () => {
  // DSH 宿主会注入 ELECTRON_RUN_AS_NODE=1，子进程里必须清掉（gotchas.md）
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-graph-e2e-'))

  const now = Date.now()
  const db = openDatabase(join(userDataDir, 'memory.db'))
  insertEvent(db, {
    ts: now - 10 * 60_000,
    app: 'notepad',
    windowTitle: '会议纪要.txt',
    ocrText: '项目计划与待办事项'
  })
  insertEvent(db, {
    ts: now - 9 * 60_000,
    app: 'chrome',
    windowTitle: '示例页面',
    ocrText: '页面内容'
  })
  db.close()

  app = await electron.launch({
    args: [...APP_ARGS],
    env: {
      ...process.env,
      // 隔离宿主机环境变量：密钥状态测试要求从空 .env 开始
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
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test.describe.serial('图谱闭环（假采集 + 假 LLM）', () => {
  test('未确认出网：自动归纳零请求，图谱显示确认门', async () => {
    await expect(graph.locator('#status')).toHaveAttribute('data-kind', 'consent')
    await expect(graph.locator('#consent')).toBeVisible()

    // 启动假采集：没有确认门时 runtime 不启动，等超过首跑延迟也必须是 0 请求
    await app.evaluate(() => globalThis.__gotchaTest!.toggle())
    await expect.poll(captureStatus, { timeout: 5_000 }).toBe('running')
    await graph.waitForTimeout(1_000)
    expect((await fakeLlm()).requests).toBe(0)
    await expect(graph.locator('#consent')).toBeVisible()
  })

  test('确认后立即归纳：节点落库、画布渲染、来源 100% 可溯', async () => {
    await graph.locator('#consent-btn').click()

    await expect.poll(async () => (await fakeLlm()).requests, { timeout: 10_000 }).toBe(1)
    await expect(graph.locator('#consent')).toBeHidden()
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '2', {
      timeout: 15_000
    })
    await expect(graph.locator('#node-count')).toContainText('2 个节点')
    await expect(graph.locator('#node-count')).toContainText('1 条边')
    await expect(graph.locator('#sigma-container canvas')).toBeVisible({ timeout: 15_000 })
    await expect(graph.locator('#empty')).toBeHidden()

    const count = await graph.evaluate(
      () => (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.count()
    )
    expect(count).toBe(2)

    const nodes = await nodesToday()
    expect(nodes.length).toBe(2)
    for (const node of nodes) {
      const result = await graph.evaluate(
        async (id) =>
          (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.nodeEvents(id),
        node.id
      )
      expect(result.found).toBe(true)
      expect(result.events.length).toBeGreaterThan(0)
      expect(result.missingIds).toEqual([])
    }
  })

  test('点击节点下钻：侧栏成员事件 + 在时间线中查看定位到节点日期', async () => {
    const nodes = await nodesToday()
    const target = nodes[0]
    await graph.evaluate(
      (id) =>
        (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.select(id),
      target.id
    )

    await expect(graph.locator('#panel')).toBeVisible()
    await expect(graph.locator('#panel-title')).not.toHaveText('')
    await expect(graph.locator('#panel-events li').first()).toContainText('notepad')

    const timelinePromise = app.waitForEvent('window')
    await graph.locator('#panel-timeline').click()
    const timeline = await timelinePromise
    await timeline.waitForLoadState('domcontentloaded')

    await expect(timeline.locator('#date')).toContainText(dateStamp(target.tsStart))
    await expect(timeline.locator('li')).toHaveCount(2)
    await timeline.close()

    await graph.locator('#panel-close').click()
    await expect(graph.locator('#panel')).toBeHidden()
  })

  test('设置抽屉：读取并保存归纳参数，供应商 API Key 直接填写即生效', async () => {
    await graph.locator('#settings').click()
    await expect(graph.locator('#drawer')).toBeVisible()
    await expect(graph.locator('#set-interval')).toHaveValue('10')

    const keyStatus = graph.locator('[data-role="provider"] [data-role="key-status"]').first()
    await expect(keyStatus).toHaveText('未配置密钥')
    await graph.locator('[data-role="provider"] [data-field="apiKey"]').first().fill('sk-e2e-test-key')

    await graph.locator('#set-interval').fill('15')
    await graph.locator('#settings-save').click()
    await expect(graph.locator('#settings-msg')).toHaveText('已保存')

    const saved = await graph.evaluate(async () =>
      (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.settings()
    )
    expect(saved.intervalMinutes).toBe(15)

    // 直接填写的密钥写入 userData/.env（不是 settings 表），界面只显示来源不回显值
    await expect(keyStatus).toHaveText('已配置（userData/.env）')
    expect(readFileSync(join(userDataDir, '.env'), 'utf8')).toContain(
      'DEEPSEEK_API_KEY=sk-e2e-test-key'
    )
    await expect(graph.locator('#set-hotkey-status')).not.toHaveText('')
    await graph.locator('#settings-close').click()
    await expect(graph.locator('#drawer')).toBeHidden()
  })

  test('局部图与类型显隐：聚焦节点、返回全图、事件开关', async () => {
    const nodes = await nodesToday()
    const target = nodes[0]
    await graph.evaluate(
      (id) =>
        (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.focus(id),
      target.id
    )
    await expect(graph.locator('#focus-bar')).toBeVisible()
    await expect(graph.locator('#focus-label')).not.toHaveText('')

    await graph.locator('#focus-exit').click()
    await expect(graph.locator('#focus-bar')).toBeHidden()

    const eventFilter = graph.locator('[data-type-filter="event"]')
    await expect(eventFilter).toBeChecked()
    expect(await visibleCounts()).toEqual({ nodes: 4, edges: 3 })
    await eventFilter.uncheck()
    expect(await visibleCounts()).toEqual({ nodes: 2, edges: 1 })
    expect(
      await graph.evaluate(
        () =>
          (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.filters()
            .event
      )
    ).toBe(false)
    await eventFilter.check()
    expect(await visibleCounts()).toEqual({ nodes: 4, edges: 3 })
  })

  test('单击节点进局部图，双击开详情抽屉（语义不串）', async () => {
    const nodes = await nodesToday()

    // 选一个不压在工具栏 / 侧栏 / 窗口边缘上的节点，按真实鼠标坐标点击
    const candidates = await graph.evaluate((ids) => {
      const api = (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView
      const result: Array<{ id: number; x: number; y: number }> = []
      for (const id of ids) {
        const point = api.position(id)
        if (
          point &&
          point.x > 260 &&
          point.x < window.innerWidth - 300 &&
          point.y > 160 &&
          point.y < window.innerHeight - 140
        ) {
          result.push({ id, ...point })
        }
      }
      return result
    }, nodes.map((node) => node.id))
    expect(candidates.length).toBeGreaterThan(0)
    const target = candidates[0]

    await graph.mouse.click(target.x, target.y)
    // 单击有 320ms 双击判定延迟，之后才进入局部图；不应打开抽屉
    await expect(graph.locator('#focus-bar')).toBeVisible({ timeout: 2_000 })
    await expect(graph.locator('#focus-label')).not.toHaveText('')
    await expect(graph.locator('#panel')).toBeHidden()

    await graph.locator('#focus-exit').click()
    await expect(graph.locator('#focus-bar')).toBeHidden()
    // 聚焦时相机会移动到该节点，退出后等动画结束再取新坐标
    await graph.waitForTimeout(450)

    const point = await graph.evaluate(
      (id) => (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.position(id),
      target.id
    )
    expect(point).not.toBeNull()
    await graph.mouse.dblclick(point!.x, point!.y, { delay: 40 })
    await expect(graph.locator('#panel')).toBeVisible({ timeout: 3_000 })
    // 双击不应顺带进入局部图
    await expect(graph.locator('#focus-bar')).toBeHidden()
    await graph.locator('#panel-close').click()
    await expect(graph.locator('#panel')).toBeHidden()
  })

  test('暂停后立即归纳：零新增请求、不落库（D18），图谱仍可浏览', async () => {
    const before = await fakeLlm()
    await app.evaluate(() => globalThis.__gotchaTest!.toggle())
    await expect.poll(captureStatus, { timeout: 5_000 }).toBe('paused')

    const outcome = await graph.evaluate(async () =>
      (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.induceNow()
    )
    expect(outcome).toEqual({ status: 'skipped', reason: 'paused' })
    expect((await fakeLlm()).requests).toBe(before.requests)

    await graph.locator('#refresh').click()
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '2')
    await expect(graph.locator('#sigma-container canvas')).toBeVisible()
  })
})
