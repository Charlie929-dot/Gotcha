/**
 * M1b Phase 1 E2E：单实例锁（B8）
 *
 * 双开场景：第一个实例持有锁并起球窗口；第二个实例（同一 GOTCHA_USER_DATA）必须
 * 立即退出，且已有实例只把时间线窗口打开/聚焦，不再新建球、不重复采集。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_ARGS = ['.'] as const

function electronBinary(): string {
  const dist = join(process.cwd(), 'node_modules', 'electron', 'dist')
  return join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron')
}

let userDataDir: string
let app: ElectronApplication
let ballPage: Page

test.beforeAll(async () => {
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-single-'))
  app = await electron.launch({
    args: [...APP_ARGS],
    env: { ...process.env, GOTCHA_USER_DATA: userDataDir }
  })
  ballPage = await app.firstWindow()
  await ballPage.waitForSelector('#ball')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('双开只起一个实例：第二个进程退出，已有实例打开时间线', async () => {
  const timelinePromise = app.waitForEvent('window')

  const second = spawn(electronBinary(), [...APP_ARGS], {
    cwd: process.cwd(),
    env: { ...process.env, GOTCHA_USER_DATA: userDataDir },
    stdio: 'ignore'
  })
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      second.kill()
      resolve(-1)
    }, 20_000)
    second.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  expect(exitCode).toBe(0)

  // second-instance 只聚焦已有实例的时间线窗口
  const timeline = await timelinePromise
  await timeline.waitForLoadState('domcontentloaded')
  await expect(timeline.locator('#list')).toBeVisible()

  // 第二个实例不得再起一个球
  const ballCount = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.getTitle() === 'Gotcha 球').length
  )
  expect(ballCount).toBe(1)
})
