/**
 * 悬浮球视觉与指针交互（m1b-plan §3 Phase 1，D15 腾讯管家式停靠）
 *
 * - 停靠（docked）：窗口贴齐屏幕边缘，球体用 CSS translate 缩进 32px → 只露半颗；
 *   悬停滑回中心全显（`expanded`），移开缩回；不移动窗口，避免滑出/缩回时命中区抖动。
 * - 自由（free）：球完整可见，跟随主进程窗口位置。
 * - 穿透：窗口默认穿透，renderer 用实时球心做圆形命中检测，进圆关穿透、出圆恢复。
 * - 拖动：pointerdown 记录起点并临时展开球，pointermove 节流上报屏幕坐标（主进程
 *   setPosition），pointerup 交给主进程判定吸附/原地；未移动的按下-释放按点击处理。
 * - 不直接碰采集：状态与开关都经主进程，renderer 只发通道消息（§4.1）。
 */

type BallStatus = 'paused' | 'starting' | 'running' | 'stopping'
type BallEdge = 'left' | 'right' | 'top' | 'bottom'

interface BallScreenPoint {
  screenX: number
  screenY: number
}

interface BallPlacement {
  docked: boolean
  edge: BallEdge | null
}

interface BallApi {
  getStatus(): Promise<BallStatus>
  onStatus(callback: (status: BallStatus) => void): () => void
  onPlacement(callback: (placement: BallPlacement) => void): () => void
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

/** 球体直径 48 → 命中半径 24 */
const BALL_RADIUS = 24
/** 缩入后悬停展开的判定半径（球心到指针 ≤ 24 即悬停） */
const EXPAND_RADIUS = 24
/** 展开后离开的判定半径（留 16px 余量，避免滑出时指针「脱离」球体导致抖动） */
const COLLAPSE_RADIUS = 40
const DRAG_THRESHOLD = 3
const MOVE_THROTTLE_MS = 16

const ballElement = document.getElementById('ball')
if (!ballElement) throw new Error('找不到 #ball')
const ball: HTMLElement = ballElement

let docked = false
let dockEdge: BallEdge | null = null
let expanded = false
let pointerInside = false
let dragging = false
let dragMoved = false
let dragOrigin: BallScreenPoint | null = null
let lastMoveAt = 0

/** 用实时包围盒取球心：CSS 缩进 / 悬停缩放 / 过渡期间都准确 */
function ballCenter(): { x: number; y: number } {
  const rect = ball.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function distanceToBall(clientX: number, clientY: number): number {
  const center = ballCenter()
  return Math.hypot(clientX - center.x, clientY - center.y)
}

function applyExpanded(next: boolean): void {
  if (next === expanded) return
  expanded = next
  ball.classList.toggle('expanded', next)
}

function applyPlacement(placement: BallPlacement): void {
  docked = placement.docked
  dockEdge = placement.edge
  ball.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom', 'expanded')
  if (docked && dockEdge) ball.classList.add(`dock-${dockEdge}`)
  expanded = false
}

function setInside(next: boolean): void {
  if (next === pointerInside) return
  pointerInside = next
  ball.classList.toggle('hover', next)
  window.gotchaBall.setPointerInside(next)
}

function handlePointer(clientX: number, clientY: number): void {
  const distance = distanceToBall(clientX, clientY)
  if (docked && !expanded && distance <= EXPAND_RADIUS) applyExpanded(true)
  if (docked && expanded && distance > COLLAPSE_RADIUS) applyExpanded(false)
  setInside(distance <= BALL_RADIUS)
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
  if (event.button !== 0 || distanceToBall(event.clientX, event.clientY) > BALL_RADIUS) return
  dragging = true
  dragMoved = false
  dragOrigin = { screenX: event.screenX, screenY: event.screenY }
  lastMoveAt = 0
  ball.setPointerCapture?.(event.pointerId)
  ball.classList.add('dragging')
  // 拖动期间球完整可见，避免半颗球跟着窗口跑
  applyExpanded(true)
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
  handlePointer(event.clientX, event.clientY)
})

window.addEventListener('pointerup', (event) => {
  if (!dragging) return
  dragging = false
  releasePointer(event)
  ball.classList.remove('dragging')
  window.gotchaBall.dragEnd({
    screenX: event.screenX,
    screenY: event.screenY,
    moved: dragMoved
  })
  dragOrigin = null
  // 松手后由主进程 placement 消息决定重新缩入 / 自由；这里先保持当前视觉
  if (!docked) applyExpanded(false)
})

window.addEventListener('pointercancel', (event) => {
  if (!dragging) return
  dragging = false
  releasePointer(event)
  ball.classList.remove('dragging')
  window.gotchaBall.dragEnd({
    screenX: event.screenX,
    screenY: event.screenY,
    moved: dragMoved
  })
  dragOrigin = null
})

window.addEventListener('pointerleave', () => {
  if (dragging) return
  setInside(false)
  applyExpanded(false)
})

ball.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (dragging) return
  window.gotchaBall.openContextMenu()
})

void window.gotchaBall.getStatus().then(applyStatus).catch(() => {})
window.gotchaBall.onStatus(applyStatus)
window.gotchaBall.onPlacement(applyPlacement)

export {}
