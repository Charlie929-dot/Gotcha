/**
 * M2 Phase 2a E2E：图谱数据通道 + 归纳接线（D20 / D24）
 *
 * 隔离：`GOTCHA_USER_DATA` 临时目录 + `GOTCHA_FAKE_CAPTURE=1` + `GOTCHA_FAKE_LLM=1`
 * （三者都要求非打包态）——不启动真实录屏 / OCR、不发真实网络。
 *
 * 覆盖：
 * 1. 未确认出网时自动归纳零请求；确认后「立即归纳」落库，图谱出现节点；
 * 2. 节点 source_events 全部可解析回事件行（C4 可溯）；
 * 3. 暂停后「立即归纳」零新增请求、不落库（D18）。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
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

interface GraphWindowApi {
  nodeEvents(nodeId: number): Promise<{ found: boolean; events: unknown[]; missingIds: number[] }>
  induceNow(): Promise<{ status: string; reason?: string }>
}

async function fakeLlm(): Promise<FakeLlmCounter> {
  return app.evaluate(() => globalThis.__gotchaTest!.fakeLlm()!) as Promise<FakeLlmCounter>
}

async function captureStatus(): Promise<string> {
  return app.evaluate(() => globalThis.__gotchaTest!.status())
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

test.describe.serial('图谱归纳闭环（假采集 + 假 LLM）', () => {
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

  test('确认后立即归纳：节点落库可在图谱看到，来源事件 100% 可溯', async () => {
    await graph.locator('#consent-btn').click()

    await expect.poll(async () => (await fakeLlm()).requests, { timeout: 10_000 }).toBe(1)
    await expect(graph.locator('#node-list li')).toHaveCount(2, { timeout: 10_000 })
    await expect(graph.locator('#consent')).toBeHidden()
    await expect(graph.locator('#node-count')).toContainText('2 个节点')
    await expect(graph.locator('#node-count')).toContainText('1 条边')

    const nodeIds = await graph
      .locator('#node-list li')
      .evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset.id)))
    expect(nodeIds.length).toBe(2)

    for (const nodeId of nodeIds) {
      const result = await graph.evaluate(
        async (id) => (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.nodeEvents(id),
        nodeId
      )
      expect(result.found).toBe(true)
      expect(result.events.length).toBeGreaterThan(0)
      expect(result.missingIds).toEqual([])
    }
  })

  test('暂停后立即归纳：零新增请求、不落库（D18）', async () => {
    const before = await fakeLlm()
    await app.evaluate(() => globalThis.__gotchaTest!.toggle())
    await expect.poll(captureStatus, { timeout: 5_000 }).toBe('paused')

    const outcome = await graph.evaluate(async () =>
      (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.induceNow()
    )
    expect(outcome).toEqual({ status: 'skipped', reason: 'paused' })
    expect((await fakeLlm()).requests).toBe(before.requests)

    // 图谱仍可浏览已有节点（暂停不影响只读）
    await graph.locator('#refresh').click()
    await expect(graph.locator('#node-list li')).toHaveCount(2)
  })
})
