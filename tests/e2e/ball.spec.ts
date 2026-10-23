/**
 * M1b Phase 1 E2E：球窗口存在且透明置顶 / 默认暂停视觉 / 停靠缩入 + 悬停滑出 /
 * 点击打开图谱（D20）/ 拖动松手（近边吸附、中间自由）/ 离开宽限与兜底缩回（D16）
 *
 * 隔离：GOTCHA_USER_DATA 指向临时目录，不碰真实 userData，也不启动真实采集
 * （默认暂停，A3：球壳与时间线都不应建库、不写 ball.json）。
 *
 * 指针有两路：
 * - renderer 看到的是 Playwright/CDP 注入的合成指针（position 由 mouse.move 决定）；
 * - 主进程兜底用 screen.getCursorScreenPoint() 读真实 OS 指针，合成指针不会移动它。
 *   需要稳定验证兜底时，用 setFallbackCursor 在测试进程里改写该函数（仅测试内）。
 */

import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dockedPosition,
  freePosition,
  positionOnPixelGrid,
  type BallEdge,
  type BallRect
} from '../../src/main/ball-position'

const APP_ARGS = ['.'] as const

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

interface BallMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
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

/** 球体当前 transform 矩阵（缩进 = e/f，悬停放大 = a/d） */
async function ballMatrix(): Promise<BallMatrix> {
  return ballPage.locator('#ball').evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform)
    return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f }
  })
}

/** 悬停到缩入后露出的半颗球上，等过渡结束 */
async function hoverVisibleHalf(): Promise<void> {
  const box = await ballPage.locator('#ball').boundingBox()
  if (!box) throw new Error('找不到球体包围盒')
  // 缩入态：可见的是靠窗口内侧的半颗，取可见半区的中心
  const visibleX = box.width > 48 ? box.x + box.width / 2 : box.x + box.width / 4
  await ballPage.mouse.move(visibleX, box.y + box.height / 2)
  await ballPage.waitForTimeout(350)
}

/**
 * 模拟「指针离开球窗口」：CDP 注入的鼠标移动不会像真实 OS 光标那样由浏览器侧
 * 生成 pointerleave（离开事件是原生窗口层产生的），这里显式派发一次。
 */
async function leaveBallWindow(): Promise<void> {
  await ballPage.mouse.move(-20, -20)
  await ballPage.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerleave'))
  })
}

/**
 * 改写主进程兜底读取的「真实指针」位置（null = 还原）。
 * 只影响 screen.getCursorScreenPoint()，即 D16 的主进程兜底；renderer 仍用合成指针。
 */
async function setFallbackCursor(cursor: { x: number; y: number } | null): Promise<void> {
  await app.evaluate(({ screen }, point) => {
    const holder = globalThis as unknown as {
      __gotchaCursorPoint?: () => { x: number; y: number }
    }
    if (!holder.__gotchaCursorPoint) {
      holder.__gotchaCursorPoint = screen.getCursorScreenPoint.bind(screen)
    }
    screen.getCursorScreenPoint = point ? () => ({ x: point.x, y: point.y }) : holder.__gotchaCursorPoint
  }, cursor)
}

/** 把兜底指针钉在当前球窗口中心：正常用例里让兜底保持安静 */
async function pinFallbackCursorToWindow(): Promise<void> {
  const { bounds } = await readBallWindow()
  await setFallbackCursor({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
}

/**
 * 合成指针拖拽：Playwright 的 mouse.move 只给视口坐标，Chromium 会用「当前窗口位置
 * + clientX」反推 screenX；窗口跟着鼠标移动时这会形成反馈、放大位移。这里直接派发带
 * 绝对 screenX/screenY 的 PointerEvent，等价于真实鼠标（真实事件就是绝对屏幕坐标）。
 */
async function dispatchDrag(
  page: Page,
  from: { screenX: number; screenY: number; clientX: number; clientY: number },
  to: { screenX: number; screenY: number; clientX: number; clientY: number }
): Promise<void> {
  await page.evaluate(
    (payload) => {
      const ball = document.getElementById('ball')
      if (!ball) throw new Error('找不到 #ball')
      const make = (
        type: string,
        point: { screenX: number; screenY: number; clientX: number; clientY: number }
      ): PointerEvent =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: point.clientX,
          clientY: point.clientY,
          screenX: point.screenX,
          screenY: point.screenY
        })
      ball.dispatchEvent(make('pointerdown', payload.from))
      window.dispatchEvent(make('pointermove', payload.to))
      window.dispatchEvent(make('pointerup', payload.to))
    },
    { from, to }
  )
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
  // 等 did-finish-load 的 placement 消息 + 缩入过渡结束（160ms）
  await ballPage.waitForTimeout(400)
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('球窗口：64×64、置顶、不聚焦，默认停靠右缘且球缩入半颗（D15）', async () => {
  const ball = await readBallWindow()
  expect(ball.bounds.width).toBe(64)
  expect(ball.bounds.height).toBe(64)
  expect(ball.alwaysOnTop).toBe(true)
  expect(ball.visible).toBe(true)
  expect(ball.focusable).toBe(false)

  // 窗口贴齐工作区右缘（不缩窗口，缩的是球）
  const expected = positionOnPixelGrid(dockedPosition('right', 0.5, ball.workArea), ball.scaleFactor)
  expect(ball.bounds.x).toBe(expected.x)
  expect(ball.bounds.y).toBe(expected.y)

  await expect(ballPage.locator('#ball')).toHaveClass(/paused/)
  await expect(ballPage.locator('#ball')).toHaveClass(/dock-right/)

  // 缩入 32px：球心贴屏幕边缘，只露半颗
  const matrix = await ballMatrix()
  expect(matrix.e).toBeCloseTo(32, 1)
})

test('悬停滑出全显；窗口内移动不收起；离开 600ms 宽限后缩回（D15/D16）', async () => {
  await pinFallbackCursorToWindow()
  await hoverVisibleHalf()
  await expect(ballPage.locator('#ball')).toHaveClass(/expanded/)
  expect((await ballMatrix()).e).toBeCloseTo(0, 1)

  // 指针仍在窗口内（安全区，离球心 > 旧收拢阈值）：不得按半径收起
  await ballPage.mouse.move(2, 2)
  await ballPage.waitForTimeout(200)
  await expect(ballPage.locator('#ball')).toHaveClass(/expanded/)

  // 离开窗口：宽限期内保持全显，避免「刚移开又滑回来」的闪烁
  await leaveBallWindow()
  await ballPage.waitForTimeout(250)
  await expect(ballPage.locator('#ball')).toHaveClass(/expanded/)

  // 宽限到期 + 160ms 过渡 → 缩回（D16 上限 ≤900ms）
  await expect.poll(async () => (await ballMatrix()).e, { timeout: 2_500 }).toBeCloseTo(32, 1)
  await expect(ballPage.locator('#ball')).not.toHaveClass(/expanded/)
})

test('点击球打开图谱窗口（D20）；默认暂停不建库（A3 红线）', async () => {
  await hoverVisibleHalf()
  const graphPromise = app.waitForEvent('window')
  await ballPage.mouse.click(32, 32)
  const graph = await graphPromise
  await graph.waitForLoadState('domcontentloaded')
  await expect(graph.locator('#status')).toBeVisible()
  // 空日显示空状态（#node-count 无内容时为 0 高，不能用 toBeVisible）
  await expect(graph.locator('#empty')).toBeVisible()

  // 默认暂停：没有采集就不应产生 memory.db 或 ball.json
  await graph.waitForTimeout(500)
  expect(existsSync(join(userDataDir, 'memory.db'))).toBe(false)
  expect(existsSync(join(userDataDir, 'ball.json'))).toBe(false)
})

test('拖动：松手停在原地；靠近边缘才吸附缩入（D15）', async () => {
  const statePath = join(userDataDir, 'ball.json')

  // ① 从缩入态往中间拖（偏移 -96 / +100）：松手停在原地（自由位，不吸附）
  await hoverVisibleHalf()
  const start = await readBallWindow()
  const fromX = start.bounds.x + 32
  const fromY = start.bounds.y + 32

  await dispatchDrag(
    ballPage,
    { screenX: fromX, screenY: fromY, clientX: 32, clientY: 32 },
    { screenX: fromX - 96, screenY: fromY + 100, clientX: 10, clientY: 132 }
  )
  await expect.poll(() => existsSync(statePath), { timeout: 5_000 }).toBe(true)
  await ballPage.waitForTimeout(300)

  let saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
    edge: BallEdge | null
    offset_ratio: number
    x_ratio: number
    y_ratio: number
    display_id: number
  }
  expect(saved.edge).toBeNull()
  expect(typeof saved.display_id).toBe('number')
  expect(saved.x_ratio).toBeGreaterThan(0)
  expect(saved.y_ratio).toBeGreaterThan(0)
  // 自由位：球完整可见，不再缩入
  await expect(ballPage.locator('#ball')).not.toHaveClass(/dock-/)
  expect((await ballMatrix()).e).toBeCloseTo(0, 1)

  const free = await readBallWindow()
  const expectedFree = positionOnPixelGrid(
    freePosition(saved.x_ratio, saved.y_ratio, free.workArea),
    free.scaleFactor
  )
  expect(free.bounds.x).toBe(expectedFree.x)
  expect(free.bounds.y).toBe(expectedFree.y)

  // ② 从自由位往右缘拖（偏移 +92 / +52，落点距右缘 4px）：≤24px → 吸附并缩入
  const mid = await readBallWindow()
  const midX = mid.bounds.x + 32
  const midY = mid.bounds.y + 32
  await dispatchDrag(
    ballPage,
    { screenX: midX, screenY: midY, clientX: 32, clientY: 32 },
    { screenX: midX + 92, screenY: midY + 52, clientX: 52, clientY: 132 }
  )
  await ballPage.waitForTimeout(400)

  saved = JSON.parse(readFileSync(statePath, 'utf8'))
  expect(saved.edge).toBe('right')
  await expect(ballPage.locator('#ball')).toHaveClass(/dock-right/)
  expect((await ballMatrix()).e).toBeCloseTo(32, 1)

  const docked = await readBallWindow()
  expect(docked.bounds.x + docked.bounds.width).toBe(docked.workArea.x + docked.workArea.width)
  expect(docked.bounds).toEqual({
    ...positionOnPixelGrid(
      dockedPosition('right', saved.offset_ratio, docked.workArea),
      docked.scaleFactor
    ),
    width: 64,
    height: 64
  })
})

test('连续 10 次「悬停展开 → 离开宽限 → 缩回」全部收回（D16）', async () => {
  await pinFallbackCursorToWindow()

  for (let round = 0; round < 10; round++) {
    await hoverVisibleHalf()
    await expect(ballPage.locator('#ball')).toHaveClass(/expanded/)
    expect((await ballMatrix()).e).toBeCloseTo(0, 1)

    await leaveBallWindow()
    await expect.poll(async () => (await ballMatrix()).e, { timeout: 2_500 }).toBeCloseTo(32, 1)
    await expect(ballPage.locator('#ball')).not.toHaveClass(/expanded/)
  }
})

test('renderer 丢失 pointerleave 时，主进程游标兜底仍会缩回（D16）', async () => {
  const { bounds } = await readBallWindow()
  // 真实 OS 指针钉在窗口外（合成指针仍会进入球体）：模拟 leave 事件丢失
  await setFallbackCursor({ x: bounds.x - 600, y: bounds.y - 600 })

  await hoverVisibleHalf()
  await expect(ballPage.locator('#ball')).toHaveClass(/expanded/)

  // 不派发 pointerleave：只靠 50ms 游标检查 + 宽限 + 100ms 兜底余量
  await expect.poll(async () => (await ballMatrix()).e, { timeout: 3_000 }).toBeCloseTo(32, 1)
  await expect(ballPage.locator('#ball')).not.toHaveClass(/expanded/)

  await setFallbackCursor(null)
})
