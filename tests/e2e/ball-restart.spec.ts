/**
 * M1b Phase 1 E2E：ball.json 重启恢复（B2 / Q8 / D15）
 *
 * 预置一份合法 ball.json（停靠 / 自由两种）→ 启动 → 球落在对应位置、缩入状态正确；
 * 启动本身不得改写 ball.json（惰性写入：只在拖动/吸附后写）。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dockedPosition,
  freePosition,
  positionOnPixelGrid,
  type BallRect
} from '../../src/main/ball-position'

const APP_ARGS = ['.'] as const

interface DisplayInfo {
  id: number
  scaleFactor: number
  workArea: BallRect
}

interface Geometry {
  bounds: { x: number; y: number; width: number; height: number }
  displays: DisplayInfo[]
  primaryId: number
}

let userDataDir: string
let app: ElectronApplication | null = null
let displays: DisplayInfo[] = []
let primaryId = 0

function statePath(): string {
  return join(userDataDir, 'ball.json')
}

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [...APP_ARGS],
    env: { ...process.env, GOTCHA_USER_DATA: userDataDir }
  })
}

async function readGeometry(target: ElectronApplication): Promise<Geometry> {
  const info = await target.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === 'Gotcha 球'
    )
    if (!win) return null
    return {
      bounds: win.getBounds(),
      displays: screen.getAllDisplays().map((display) => ({
        id: display.id,
        scaleFactor: display.scaleFactor,
        workArea: display.workArea
      })),
      primaryId: screen.getPrimaryDisplay().id
    }
  })
  if (!info) throw new Error('找不到球窗口')
  return info
}

async function launchAndRead(): Promise<Geometry> {
  app = await launch()
  const ballPage = await app.firstWindow()
  await ballPage.waitForSelector('#ball')
  // 等 placement 消息与缩入过渡（160ms）结束
  await ballPage.waitForTimeout(400)
  return readGeometry(app)
}

async function closeApp(): Promise<void> {
  await app?.close()
  app = null
  await new Promise((resolve) => setTimeout(resolve, 500))
}

test.beforeAll(async () => {
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-restart-'))

  // 第一次启动只为拿到真实显示器 id / 工作区 / 缩放
  const geometry = await launchAndRead()
  displays = geometry.displays
  primaryId = geometry.primaryId
  await closeApp()
})

test.afterAll(async () => {
  await closeApp()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('ball.json 停靠态重启恢复：贴边 + 缩入，且启动不改写文件', async () => {
  const display = displays.find((candidate) => candidate.id === primaryId)
  if (!display) throw new Error('找不到主显示器')

  writeFileSync(
    statePath(),
    JSON.stringify({
      edge: 'left',
      offset_ratio: 0.25,
      x_ratio: 0.5,
      y_ratio: 0.5,
      display_id: display.id
    })
  )
  const before = readFileSync(statePath(), 'utf8')

  const geometry = await launchAndRead()
  const expected = positionOnPixelGrid(
    dockedPosition('left', 0.25, display.workArea),
    display.scaleFactor
  )
  expect(geometry.bounds).toEqual({ ...expected, width: 64, height: 64 })

  const ballPage = await app!.firstWindow()
  await expect(ballPage.locator('#ball')).toHaveClass(/dock-left/)
  const matrix = await ballPage.locator('#ball').evaluate((element) => {
    const m = new DOMMatrix(getComputedStyle(element).transform)
    return { e: m.e, f: m.f }
  })
  expect(matrix.e).toBeCloseTo(-32, 1)

  // 启动不写文件：惰性写入（A3/Q8）
  expect(readFileSync(statePath(), 'utf8')).toBe(before)

  await closeApp()
})

test('ball.json 自由态重启恢复：停在记录的位置，不缩入', async () => {
  const display = displays.find((candidate) => candidate.id === primaryId)
  if (!display) throw new Error('找不到主显示器')

  writeFileSync(
    statePath(),
    JSON.stringify({
      edge: null,
      offset_ratio: 0,
      x_ratio: 0.2,
      y_ratio: 0.3,
      display_id: display.id
    })
  )
  const before = readFileSync(statePath(), 'utf8')

  const geometry = await launchAndRead()
  const expected = positionOnPixelGrid(
    freePosition(0.2, 0.3, display.workArea),
    display.scaleFactor
  )
  expect(geometry.bounds).toEqual({ ...expected, width: 64, height: 64 })

  const ballPage = await app!.firstWindow()
  await expect(ballPage.locator('#ball')).not.toHaveClass(/dock-/)
  expect(readFileSync(statePath(), 'utf8')).toBe(before)

  await closeApp()
})
