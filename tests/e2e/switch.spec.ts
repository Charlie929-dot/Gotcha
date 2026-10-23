/**
 * M1b Phase 2 E2E：总开关（Alt+P 等价切换）/ 两键落盘 / 启动 3s 自动恢复与取消（D13）
 *
 * 隔离与安全：`GOTCHA_USER_DATA` 临时目录 + `GOTCHA_FAKE_CAPTURE=1` 假采集
 * （非打包态才生效，§3 Phase 2）——不启动真实录屏与 OCR，events 行数必须保持 0。
 *
 * 热键无法用合成按键触发（globalShortcut 只响应真实 OS 按键），E2E 通过假采集模式下的
 * 测试钩子 `globalThis.__gotchaTest.toggle()` 走同一个 `toggleCapture()` 入口；
 * `Alt+P` 注册/失败分支由 tests/unit/hotkeys.test.ts 覆盖。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import {
  SWITCH_ENABLED_KEY,
  SWITCH_RESUME_ON_START_KEY
} from '../../src/main/capture-switch'

const APP_ARGS = ['.'] as const

interface Launched {
  app: ElectronApplication
  ball: Page
  dir: string
}

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function dbPath(dir: string): string {
  return join(dir, 'memory.db')
}

/** 预置两键（模拟上次显式开启 / 暂停后的持久化状态） */
function seedSwitch(dir: string, enabled: boolean, resumeOnStart: boolean): void {
  const db = openDatabase(dbPath(dir))
  try {
    setSetting(db, SWITCH_ENABLED_KEY, enabled ? '1' : '0')
    setSetting(db, SWITCH_RESUME_ON_START_KEY, resumeOnStart ? '1' : '0')
  } finally {
    db.close()
  }
}

function readSettings(dir: string): Record<string, string> {
  if (!existsSync(dbPath(dir))) return {}
  const db = new Database(dbPath(dir), { readonly: true })
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((row) => [row.key, row.value]))
  } finally {
    db.close()
  }
}

function countEvents(dir: string): number {
  if (!existsSync(dbPath(dir))) return 0
  const db = new Database(dbPath(dir), { readonly: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
  } finally {
    db.close()
  }
}

async function launch(dir: string, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const app = await electron.launch({
    args: [...APP_ARGS],
    env: {
      ...process.env,
      GOTCHA_USER_DATA: dir,
      GOTCHA_FAKE_CAPTURE: '1',
      ...extraEnv
    }
  })
  const ball = await app.firstWindow()
  await ball.waitForSelector('#ball')
  await ball.waitForTimeout(400)
  return { app, ball, dir }
}

async function close(launched: Launched): Promise<void> {
  await launched.app.close()
  rmSync(launched.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** 假采集模式下切开关（Alt+P / 托盘共用同一入口） */
async function toggle(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => globalThis.__gotchaTest!.toggle())
}

/** 悬停到缩入后露出的半颗球上，等 160ms 过渡结束 */
async function hoverVisibleHalf(ball: Page): Promise<void> {
  const box = await ball.locator('#ball').boundingBox()
  if (!box) throw new Error('找不到球体包围盒')
  const visibleX = box.width > 48 ? box.x + box.width / 2 : box.x + box.width / 4
  await ball.mouse.move(visibleX, box.y + box.height / 2)
  await ball.waitForTimeout(350)
}

/**
 * 点击球并等图谱窗口出现：全量跑时主进程偶发在「hover → down」之间恢复穿透，
 * mousedown 落到下层窗口（2026-10-23 观察到）。有界重试，避免把偶发穿透当功能回归。
 */
async function clickBallExpectWindow(ball: Page, app: ElectronApplication): Promise<Page> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await hoverVisibleHalf(ball)
    const nextWindow = app.waitForEvent('window', { timeout: 4_000 }).catch(() => null)
    await ball.mouse.click(32, 32)
    const page = await nextWindow
    if (page) {
      await page.waitForLoadState('domcontentloaded')
      return page
    }
    await ball.waitForTimeout(250)
  }
  throw new Error('点击球后 3 次都未打开窗口')
}

test.beforeAll(() => {
  // DSH 宿主会注入 ELECTRON_RUN_AS_NODE=1，子进程里必须清掉（gotchas.md）
  delete process.env.ELECTRON_RUN_AS_NODE
})

test('总开关：暂停 → 运行（1/1）→ 暂停（0/0），视觉切换且 events 不增长', async () => {
  const launched = await launch(freshDir('gotcha-switch-'))
  const { app, ball, dir } = launched
  try {
    // 首次启动：无设置 → 暂停（A3 / B3），也不写任何键
    await expect(ball.locator('#ball')).toHaveClass(/paused/)
    expect(readSettings(dir)).toEqual({})

    await toggle(app)
    await expect(ball.locator('#ball')).toHaveClass(/running/, { timeout: 5_000 })
    await expect.poll(() => readSettings(dir)[SWITCH_ENABLED_KEY]).toBe('1')
    await expect.poll(() => readSettings(dir)[SWITCH_RESUME_ON_START_KEY]).toBe('1')
    // 假采集：不录屏、不写事件
    expect(countEvents(dir)).toBe(0)

    await toggle(app)
    await expect(ball.locator('#ball')).toHaveClass(/paused/, { timeout: 5_000 })
    await expect.poll(() => readSettings(dir)[SWITCH_ENABLED_KEY]).toBe('0')
    await expect.poll(() => readSettings(dir)[SWITCH_RESUME_ON_START_KEY]).toBe('0')
    expect(countEvents(dir)).toBe(0)
  } finally {
    await close(launched)
  }
})

test('resume_on_start=1：启动先暂停 + 3s 倒计时角标，到点自动运行且两键不变', async () => {
  const dir = freshDir('gotcha-resume-')
  seedSwitch(dir, true, true)
  const launched = await launch(dir)
  const { ball } = launched
  try {
    await expect(ball.locator('#ball')).toHaveClass(/paused/)
    const notice = ball.locator('#notice')
    await expect(notice).toBeVisible({ timeout: 3_000 })
    await expect(notice).toHaveAttribute('data-kind', 'countdown')
    await expect(notice).toHaveText(/^[123]$/)

    // 3s 到点才真正开始；成功后才切运行视觉
    await expect(ball.locator('#ball')).toHaveClass(/running/, { timeout: 8_000 })
    await expect(notice).toBeHidden()

    // 启动恢复不是新的显式授权：两键保持 1/1（D13 / A3）
    expect(readSettings(dir)[SWITCH_ENABLED_KEY]).toBe('1')
    expect(readSettings(dir)[SWITCH_RESUME_ON_START_KEY]).toBe('1')
    expect(countEvents(dir)).toBe(0)
  } finally {
    await close(launched)
  }
})

test('倒计时内点球即取消：保持暂停、两键置 0，3s 后也不自动开始', async () => {
  const dir = freshDir('gotcha-resume-cancel-')
  seedSwitch(dir, true, true)
  const launched = await launch(dir)
  const { app, ball } = launched
  try {
    await expect(ball.locator('#ball')).toHaveClass(/paused/)
    await expect(ball.locator('#notice')).toBeVisible({ timeout: 3_000 })

    // 停靠缩入态先悬停展开，再点击球心（未拖动 = 点击；D20 起打开图谱）
    await clickBallExpectWindow(ball, app)

    await expect(ball.locator('#notice')).toBeHidden()
    await expect
      .poll(() => readSettings(dir)[SWITCH_RESUME_ON_START_KEY], { timeout: 5_000 })
      .toBe('0')
    expect(readSettings(dir)[SWITCH_ENABLED_KEY]).toBe('0')

    // 过了原定的 3s 窗口也不得开始
    await ball.waitForTimeout(3_500)
    await expect(ball.locator('#ball')).toHaveClass(/paused/)
    expect(countEvents(dir)).toBe(0)
  } finally {
    await close(launched)
  }
})

test('倒计时到点且起流仍在 starting：点球仍取消并最终保持暂停', async () => {
  const dir = freshDir('gotcha-resume-starting-click-')
  seedSwitch(dir, true, true)
  const launched = await launch(dir, { GOTCHA_FAKE_CAPTURE_START_DELAY_MS: '1500' })
  const { app, ball } = launched
  try {
    await expect
      .poll(() => app.evaluate(() => globalThis.__gotchaTest!.status()), { timeout: 6_000 })
      .toBe('starting')

    await clickBallExpectWindow(ball, app)

    await expect
      .poll(() => app.evaluate(() => globalThis.__gotchaTest!.status()), { timeout: 5_000 })
      .toBe('paused')
    await expect.poll(() => readSettings(dir)[SWITCH_ENABLED_KEY]).toBe('0')
    expect(readSettings(dir)[SWITCH_RESUME_ON_START_KEY]).toBe('0')
    await expect(ball.locator('#notice')).toBeHidden()
  } finally {
    await close(launched)
  }
})

test('倒计时到点且起流仍在 starting：Alt+P 接管为显式开启并写 1/1', async () => {
  const dir = freshDir('gotcha-resume-starting-hotkey-')
  seedSwitch(dir, true, true)
  const launched = await launch(dir, { GOTCHA_FAKE_CAPTURE_START_DELAY_MS: '1500' })
  const { app, ball } = launched
  try {
    await expect
      .poll(() => app.evaluate(() => globalThis.__gotchaTest!.status()), { timeout: 6_000 })
      .toBe('starting')

    await toggle(app)
    await expect
      .poll(() => app.evaluate(() => globalThis.__gotchaTest!.status()), { timeout: 5_000 })
      .toBe('running')
    await expect.poll(() => readSettings(dir)[SWITCH_ENABLED_KEY]).toBe('1')
    expect(readSettings(dir)[SWITCH_RESUME_ON_START_KEY]).toBe('1')
    await expect(ball.locator('#notice')).toBeHidden()
  } finally {
    await close(launched)
  }
})

test('角标：热键被占用时显示「!」角标并可清除（B4 可见反馈）', async () => {
  const launched = await launch(freshDir('gotcha-notice-'))
  const { app, ball } = launched
  try {
    await app.evaluate(() =>
      globalThis.__gotchaTest!.notice({
        kind: 'hotkey-unavailable',
        text: 'Alt+P 被占用，可用托盘菜单切换记录'
      })
    )
    const notice = ball.locator('#notice')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveText('!')
    await expect(notice).toHaveAttribute('data-kind', 'hotkey-unavailable')

    await app.evaluate(() => globalThis.__gotchaTest!.notice(null))
    await expect(notice).toBeHidden()
  } finally {
    await close(launched)
  }
})
