/**
 * M1b Phase 1 E2E：球窗口存在且透明置顶 / 默认暂停视觉 / 点击打开时间线 / 拖动吸附落盘
 *
 * 隔离：GOTCHA_USER_DATA 指向临时目录，不碰真实 userData，也不启动真实采集
 * （默认暂停，A3：球壳与时间线都不应建库、不写 ball.json）。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { positionFor, positionOnPixelGrid, type BallEdge, type BallRect } from '../../src/main/ball-position'

const APP_ARGS = ['.'] as const
const BALL_TITLE = 'Gotcha 球'

let userDataDir: string
let app: ElectronApplication
let ballPage: Page

interface BallWindowInfo {
  bounds: { x: number; y: number; width: number; height: number }
  workArea: BallRect
  scaleFactor: number
  alwaysOnTop: boolean
  visible: boolean
  focusable: boolean
}

async function readBallWindow(): Promise<BallWindowInfo> {
  const info = await app.evaluate(
    ({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === 'Gotcha 球'
      )
      if (!win) return null
      const display = screen.getPrimaryDisplay()
      return {
        bounds: win.getBounds(),
        workArea: {
          x: display.workArea.x,
          y: display.workArea.y,
          width: display.workArea.width,
          height: display.workArea.height
        },
        scaleFactor: display.scaleFactor,
        alwaysOnTop: win.isAlwaysOnTop(),
        visible: win.isVisible(),
        focusable: win.isFocusable()
      }
    }
  )
  if (!info) throw new Error('找不到球窗口')
  return info
}

test.beforeAll(async () => {
  // DSH 宿主会注入 ELECTRON_RUN_AS_NODE=1，子进程里必须清掉（gotchas.md）
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-ball-e2e-'))

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

test('球窗口：64×64、置顶、不聚焦，默认暂停视觉（A3）', async () => {
  const ball = await readBallWindow()
  expect(ball.bounds.width).toBe(64)
  expect(ball.bounds.height).toBe(64)
  expect(ball.alwaysOnTop).toBe(true)
  expect(ball.visible).toBe(true)
  expect(ball.focusable).toBe(false)

  await expect(ballPage.locator('#ball')).toHaveClass(/paused/)
  await expect(ballPage.locator('#ball')).not.toHaveClass(/running/)
})

test('默认位置：主屏右边缘垂直居中、贴边 6px，且落在工作区内', async () => {
  const { bounds, workArea, scaleFactor } = await readBallWindow()
  // 125% 等非整数缩放下位置吸附到像素网格，贴边会落在 6±2 DIP（见 gotchas）
  const expected = positionOnPixelGrid(positionFor('right', 0.5, workArea), scaleFactor)
  expect(bounds.x).toBe(expected.x)
  expect(bounds.y).toBe(expected.y)
  const edgeGap = workArea.x + workArea.width - (bounds.x + bounds.width)
  expect(edgeGap).toBeGreaterThanOrEqual(2)
  expect(edgeGap).toBeLessThanOrEqual(10)
})

test('点击球打开时间线窗口（Q3）；默认暂停不建库（A3 红线）', async () => {
  const timelinePromise = app.waitForEvent('window')
  await ballPage.mouse.click(32, 32)
  const timeline = await timelinePromise
  await timeline.waitForLoadState('domcontentloaded')
  await expect(timeline.locator('#list')).toBeVisible()

  // 默认暂停：没有采集就不应产生 memory.db 或 ball.json
  await timeline.waitForTimeout(500)
  expect(existsSync(join(userDataDir, 'memory.db'))).toBe(false)
  expect(existsSync(join(userDataDir, 'ball.json'))).toBe(false)
})

test('拖动后吸附最近边缘，ball.json 只写边缘/比例/显示器（Q8）', async () => {
  await ballPage.mouse.move(32, 32)
  await ballPage.mouse.down()
  await ballPage.mouse.move(32, 260, { steps: 8 })
  await ballPage.mouse.up()

  const statePath = join(userDataDir, 'ball.json')
  await expect.poll(() => existsSync(statePath), { timeout: 5_000 }).toBe(true)

  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
    edge: BallEdge
    offset_ratio: number
    display_id: number
  }
  expect(['left', 'right', 'top', 'bottom']).toContain(saved.edge)
  expect(saved.offset_ratio).toBeGreaterThanOrEqual(0)
  expect(saved.offset_ratio).toBeLessThanOrEqual(1)
  expect(typeof saved.display_id).toBe('number')
  // 只含位置三键，不含任何采集内容
  expect(Object.keys(saved).sort()).toEqual(['display_id', 'edge', 'offset_ratio'])

  // 吸附后的窗口位置 = 纯函数按落盘状态算出的位置（再吸附到像素网格）
  const { bounds, workArea, scaleFactor } = await readBallWindow()
  expect(bounds).toEqual({
    ...positionOnPixelGrid(positionFor(saved.edge, saved.offset_ratio, workArea), scaleFactor),
    width: 64,
    height: 64
  })
})
