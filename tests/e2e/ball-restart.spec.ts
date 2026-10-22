/**
 * M1b Phase 1 E2E：ball.json 重启恢复（B2 / Q8）
 *
 * 预置一份合法 ball.json（左缘 + 0.25 比例）→ 启动 → 球落在该位置；
 * 启动本身不得改写 ball.json（惰性写入：只在拖动/吸附后写）。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  positionFor,
  positionOnPixelGrid,
  type BallEdge,
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
let app: ElectronApplication

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

test.beforeAll(async () => {
  delete process.env.ELECTRON_RUN_AS_NODE
  userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-restart-'))
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('ball.json 重启后恢复位置，且启动不改写文件（惰性写入）', async () => {
  // 第一次启动只为拿到真实显示器 id / 工作区 / 缩放
  app = await launch()
  await (await app.firstWindow()).waitForSelector('#ball')
  const first = await readGeometry(app)
  await app.close()
  await new Promise((resolve) => setTimeout(resolve, 500))

  const display = first.displays.find((candidate) => candidate.id === first.primaryId)
  if (!display) throw new Error('找不到主显示器')

  const saved = { edge: 'left' as BallEdge, offset_ratio: 0.25, display_id: display.id }
  writeFileSync(statePath(), JSON.stringify(saved))
  const before = readFileSync(statePath(), 'utf8')

  // 第二次启动：按 ball.json 还原到左缘 1/4 处
  app = await launch()
  const ballPage = await app.firstWindow()
  await ballPage.waitForSelector('#ball')
  const second = await readGeometry(app)

  const expected = positionOnPixelGrid(positionFor('left', 0.25, display.workArea), display.scaleFactor)
  expect(second.bounds).toEqual({ ...expected, width: 64, height: 64 })

  // 启动不写文件：内容与启动前逐字一致（惰性写入，A3/Q8）
  expect(readFileSync(statePath(), 'utf8')).toBe(before)
})
