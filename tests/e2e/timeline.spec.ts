/**
 * M1a Phase 3 E2E：预置合成 events（固定时间戳）→ 启动应用 → 点击球打开时间线
 * → 时间线渲染出对应行（M1b Phase 1 起时间线由球点击打开，Q3）
 *
 * 隔离：GOTCHA_USER_DATA 指向临时目录（main 里 app.setPath 覆盖），不碰真实 userData。
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
let page: Page

function todayAt(hour: number, minute: number): number {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

test.beforeAll(async () => {
  // DSH 宿主会注入 ELECTRON_RUN_AS_NODE=1，子进程里必须清掉（gotchas.md）
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-e2e-'))

  const db = openDatabase(join(userDataDir, 'memory.db'))
  insertEvent(db, {
    ts: todayAt(9, 30),
    app: 'notepad',
    windowTitle: '会议纪要.txt',
    ocrText: '项目计划与待办事项'
  })
  insertEvent(db, {
    ts: todayAt(9, 31),
    app: 'chrome',
    windowTitle: '示例页面',
    ocrText: 'x'.repeat(120)
  })
  insertEvent(db, {
    ts: todayAt(9, 32),
    app: 'chrome',
    windowTitle: '登录页',
    ocrText: 'api_key: abcdef123456',
    sensitive: 1
  })
  db.close()

  app = await electron.launch({
    args: [...APP_ARGS],
    env: { ...process.env, GOTCHA_USER_DATA: userDataDir }
  })
  // M1b Phase 1：启动只有球（常驻外壳），点击球打开时间线窗口（Q3）
  const ballPage = await app.firstWindow()
  await ballPage.waitForSelector('#ball')
  // 停靠缩入态先悬停展开再点：窗口穿透时「move → down」几乎同时到达，
  // 不给 pointermove 的穿透开关留时间，mousedown 会落到下层窗口（2026-10-23 全量跑偶发）
  await ballPage.waitForTimeout(400)
  const box = await ballPage.locator('#ball').boundingBox()
  if (!box) throw new Error('找不到球体包围盒')
  const visibleX = box.width > 48 ? box.x + box.width / 2 : box.x + box.width / 4
  await ballPage.mouse.move(visibleX, box.y + box.height / 2)
  await ballPage.waitForTimeout(350)
  const timelinePromise = app.waitForEvent('window')
  await ballPage.mouse.click(32, 32)
  page = await timelinePromise
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('时间线按日渲染合成事件（A1 的可视化前置）', async () => {
  await expect(page.locator('li')).toHaveCount(3)

  const first = page.locator('li').first()
  await expect(first).toContainText('09:30')
  await expect(first).toContainText('notepad')
  await expect(first).toContainText('会议纪要.txt')
  await expect(first).toContainText('项目计划与待办事项')

  // OCR 摘要截断到 80 字 + 省略号
  const longText = await page.locator('li').nth(1).locator('.ocr').textContent()
  expect(longText?.length).toBe(81)

  // 敏感标记可见
  await expect(page.locator('li').nth(2).locator('.badge')).toHaveText('敏感')
})

test('日期切换：前一天无数据时显示空态', async () => {
  await page.locator('#prev').click()
  await expect(page.locator('.state')).toContainText('这一天还没有记录')

  await page.locator('#today').click()
  await expect(page.locator('li')).toHaveCount(3)
})

test('实时同步徽标展示与手动刷新按钮存在可用', async () => {
  await expect(page.locator('#live')).toBeVisible()
  await page.locator('#refresh').click()
  await expect(page.locator('li')).toHaveCount(3)
})

test('暗色模式按钮悬停不再是近纯白（回归：悬停闪白）', async () => {
  const box = await page.locator('#prev').boundingBox()
  if (!box) throw new Error('找不到 #prev 按钮')

  const hoverColor = async (): Promise<string> => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    return await page
      .locator('#prev')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
  }

  await page.emulateMedia({ colorScheme: 'dark' })
  // 背景过渡 120ms；用 poll 等终态（2026-10-22 全量跑时固定等待偶发不足）
  // 暗色悬停应为深色（#2f2f37），而不是旧版漏写暗色覆盖时的 #f0f0f4
  await expect.poll(hoverColor, { timeout: 3_000 }).toBe('rgb(47, 47, 55)')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(hoverColor, { timeout: 3_000 }).toBe('rgb(240, 240, 244)')
  await page.emulateMedia({ colorScheme: 'no-preference' })
})
