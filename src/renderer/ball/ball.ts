/**
 * 悬浮球视觉与指针交互（m1b-plan §3 Phase 1）
 *
 * - 运行 = 常态半透明；暂停 = 灰暗 + 斜杠（B3；默认暂停在 Phase 2 接 settings）。
 * - 窗口默认穿透，靠转发的 pointer 事件做圆形命中检测：进圆内关穿透，出圆恢复。
 * - 拖动：pointerdown 记录起点 → pointermove 节流上报屏幕坐标（主进程 setPosition）
 *   → pointerup 松手吸附；未移动的按下-释放按点击处理（打开时间线，Q3）。
 * - 不直接碰采集：状态与开关都经主进程，renderer 只发通道消息（§4.1）。
 */

type BallStatus = 'paused' | 'starting' | 'running' | 'stopping'

interface BallScreenPoint {
  screenX: number
  screenY: number
}

interface BallApi {
  getStatus(): Promise<BallStatus>
  onStatus(callback: (status: BallStatus) => void): () => void
  setPointerInside(inside: boolean): void
  dragStart(point: BallScreenPoint): void
  dragMove(point: BallScreenPoint): void
  dragEnd(payload: BallScreenPoint & { moved: boolean }): void
  openTimeline(): void
  openContextMenu(): void
}

declare global {
  interface Window {
    gotchaBall: BallApi
  }
}

/** 球体直径 48 → 命中半径 24（窗口 64 居中，圆心 32,32） */
const BALL_RADIUS = 24
const CENTER = 32
const DRAG_THRESHOLD = 3
const MOVE_THROTTLE_MS = 16

const ballElement = document.getElementById('ball')
if (!ballElement) throw new Error('找不到 #ball')
const ball: HTMLElement = ballElement

let pointerInside = false
let dragging = false
let dragMoved = false
let dragOrigin: BallScreenPoint | null = null
let lastMoveAt = 0

function distanceFromCenter(clientX: number, clientY: number): number {
  return Math.hypot(clientX - CENTER, clientY - CENTER)
}

function onBall(clientX: number, clientY: number): boolean {
  return distanceFromCenter(clientX, clientY) <= BALL_RADIUS
}

function setInside(next: boolean): void {
  if (next === pointerInside) return
  pointerInside = next
  ball.classList.toggle('hover', next)
  window.gotchaBall.setPointerInside(next)
}

function applyStatus(status: BallStatus): void {
  const running = status === 'running'
  ball.classList.toggle('running', running)
  ball.classList.toggle('paused', !running)
}

function releasePointer(event: PointerEvent): void {
  try {
    ball.releasePointerCapture(event.pointerId)
  } catch {
    // 指针已释放（窗口隐藏 / 系统取消），忽略
  }
}

ball.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !onBall(event.clientX, event.clientY)) return
  dragging = true
  dragMoved = false
  dragOrigin = { screenX: event.screenX, screenY: event.screenY }
  lastMoveAt = 0
  ball.setPointerCapture(event.pointerId)
  window.gotchaBall.dragStart({ screenX: event.screenX, screenY: event.screenY })
  event.preventDefault()
})

window.addEventListener('pointermove', (event) => {
  if (dragging) {
    if (
      dragOrigin &&
      (Math.abs(event.screenX - dragOrigin.screenX) > DRAG_THRESHOLD ||
        Math.abs(event.screenY - dragOrigin.screenY) > DRAG_THRESHOLD)
    ) {
      dragMoved = true
    }
    const now = performance.now()
    if (now - lastMoveAt >= MOVE_THROTTLE_MS) {
      lastMoveAt = now
      window.gotchaBall.dragMove({ screenX: event.screenX, screenY: event.screenY })
    }
    return
  }
  setInside(onBall(event.clientX, event.clientY))
})

window.addEventListener('pointerup', (event) => {
  if (!dragging) return
  dragging = false
  releasePointer(event)
  window.gotchaBall.dragEnd({
    screenX: event.screenX,
    screenY: event.screenY,
    moved: dragMoved
  })
  dragOrigin = null
})

window.addEventListener('pointercancel', (event) => {
  if (!dragging) return
  dragging = false
  releasePointer(event)
  // 系统取消（如切换桌面）按拖动结束处理，避免球停半路
  window.gotchaBall.dragEnd({
    screenX: event.screenX,
    screenY: event.screenY,
    moved: dragMoved
  })
  dragOrigin = null
})

window.addEventListener('pointerleave', () => {
  if (!dragging) setInside(false)
})

ball.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (dragging) return
  window.gotchaBall.openContextMenu()
})

void window.gotchaBall.getStatus().then(applyStatus).catch(() => {})
window.gotchaBall.onStatus(applyStatus)

export {}
