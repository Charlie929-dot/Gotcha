/**
 * 自动归纳完成后画布自动刷新（P3-b 余下）
 *
 * 场景：图谱开着，后台按调度自动归纳落库（**不点「立即归纳」**）→ 主进程推 `graph:changed` →
 * 渲染层就地刷新：新主题出现在画布上，且相机 / 时间筛选不被重置。
 *
 * 隔离：`GOTCHA_USER_DATA` 临时目录 + 假采集 / 假 LLM；不启动真实录屏 / OCR / 网络。
 * 种子：1 个已归纳主题（含 1 个时刻、归属）＋ 1 条「够旧但没归纳」的事件（超出 5 分钟批滞后）。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertEvent, openDatabase } from '../../src/db'
import { setSetting } from '../../src/db/settings'

const APP_ARGS = ['.'] as const
const DAY_MS = 24 * 60 * 60 * 1000

let userDataDir: string
let app: ElectronApplication
let graph: Page
let otherKey: string

interface GraphDebug {
  dimmedCount(): number
  focusDays(): string[] | null
  setDays(list: string[] | null): void
}

interface GraphWindowApi {
  setConsent(consented: boolean): Promise<unknown>
}

function localDayKey(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function focusDays(): Promise<string[] | null> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.focusDays()
  )
}

function dimmedCount(): Promise<number> {
  return graph.evaluate(() =>
    (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.dimmedCount()
  )
}

test.beforeAll(async () => {
  // DSH 宿主会注入 ELECTRON_RUN_AS_NODE=1，子进程里必须清掉（gotchas.md）
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-auto-refresh-e2e-'))

  const now = Date.now()
  // e1 已归纳；e2 够旧（早于 5 分钟批滞后）但没进任何主题 → 自动归类会为它建主题
  const t1 = now - 20 * 60_000
  const t2 = now - 12 * 60_000
  const dayKey = localDayKey(t1)
  otherKey = localDayKey(t1 - DAY_MS)

  const db = openDatabase(join(userDataDir, 'memory.db'))
  const e1 = insertEvent(db, { ts: t1, app: 'Code', windowTitle: 'a.ts', ocrText: '改按钮样式' })
  const e2 = insertEvent(db, { ts: t2, app: 'Chrome', windowTitle: '文档', ocrText: '待归纳的新内容' })

  // 已归纳主题 + 时刻 + 归属（时刻只在有归属时才会画出来）
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'knowledge', '按钮调试', '修复悬停态', t1, t1 + 60_000, JSON.stringify([e1]))
  db.prepare(
    `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(1, t1, t1 + 60_000, dayKey, 'Code', 'a.ts', '改按钮样式', JSON.stringify([e1]))
  db.prepare(
    'INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at) VALUES (?, ?, 1, ?, 1)'
  ).run(1, 1, 'owner')
  void e2

  // 自动归纳的开关必须显式打开（缺省视为关）；确认门不种，测试里从 UI 之外的同一入口开
  setSetting(db, 'graph.auto', '1')
  // D37 之后模型随仓库分发，dev 跑会直接命中 resources/models；这里指到不存在的路径，
  // 让回填只做结构、不真的算向量（否则会和种子数据抢写入、测试不确定）。
  setSetting(db, 'graph.embedding_model_dir', join(userDataDir, 'no-model-for-e2e'))
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

test.describe.serial('自动归纳完成后的画布自动刷新', () => {
  test('不点「立即归纳」，新主题也会自己出现；时间筛选不被重置', async () => {
    await expect(graph.locator('#node-count')).toHaveText(
      '1 个主题 · 1 个时刻 · 0 条相似连线',
      { timeout: 20_000 }
    )
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '2')

    // 先按「昨天」筛掉全部节点：刷新若把筛选重置成「全部」，这条断言会失败
    await graph.evaluate(
      (day) =>
        (window as unknown as { __gotchaGraphView: GraphDebug }).__gotchaGraphView.setDays([day]),
      otherKey
    )
    await expect(graph.locator('#node-count')).toContainText('0/1 个主题')
    expect(await dimmedCount()).toBe(2)

    // 采集默认暂停（A3 红线）：先启动假采集，否则运行时把归纳判成 paused
    await app.evaluate(() => globalThis.__gotchaTest!.toggle())
    await expect
      .poll(() => app.evaluate(() => globalThis.__gotchaTest!.status()), { timeout: 8_000 })
      .toBe('running')

    // 只开确认门（自动调度的同一入口），**不点「立即归纳」**：5s 后后台跑第一批
    await graph.evaluate(() =>
      (window as unknown as { gotchaGraph: GraphWindowApi }).gotchaGraph.setConsent(true)
    )

    // 新主题走到画布上：主题 1 → 2，节点总数 2 → 3（时刻归属要等下一次回填，仍是 1）
    await expect(graph.locator('#node-count')).toContainText('0/2 个主题', { timeout: 30_000 })
    await expect(graph.locator('#node-count')).toHaveAttribute('data-nodes', '3')

    // 筛选没被重置：仍然按「昨天」看，所以三个节点全是调暗状态
    expect(await focusDays()).toEqual([otherKey])
    expect(await dimmedCount()).toBe(3)
  })
})
