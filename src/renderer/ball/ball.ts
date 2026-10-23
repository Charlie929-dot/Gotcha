/**
 * 悬浮球视觉与指针交互（m1b-plan §3 Phase 1，D15 停靠 + D16 自动缩回）
 *
 * - 停靠（docked）：窗口贴齐屏幕边缘，球体用 CSS translate 缩进 32px → 只露半颗；
 *   指针进入固定热区（可见半球 + 8px）后滑回中心全显（`expanded`）；离开窗口后
 *   600ms 宽限（`grace`）到期才缩回。距离不再决定收起——旧实现的中间带会丢事件，
 *   球卡在展开态（gotchas「展开态提前恢复穿透」）。
 * - 自由（free）：球完整可见，跟随主进程窗口位置，不展开、不自动缩回。
 * - 穿透：窗口默认穿透；`pointerInside` 与交互状态一起决定是否可交互——展开 / 宽限 /
 *   拖动期间必须保持可交互（否则收不到 `pointerleave`），缩回后才恢复穿透。
 * - 拖动：pointerdown 记录起点并临时展开球，pointermove 节流上报屏幕坐标（主进程
 *   setPosition），pointerup 交给主进程判定吸附/原地；未移动的按下-释放按点击处理。
 * - 兜底：主进程发现指针离开窗口安全区超时后发 `ball:force-retract`，这里立刻缩回。
 * - 不直接碰采集：状态与开关都经主进程，renderer 只发通道消息（§4.1）。
 *
 * 状态机在 `ball-interaction.ts`（纯函数、单测覆盖），这里只做 DOM / IPC 接线。
 */

import {
  BALL_GRACE_MS,
  BALL_HIT_RADIUS,
  initialSnapshot,
  isExpanded,
  reduceInteraction,
  type BallInteractionEvent,
  type BallInteractionSnapshot,
  type BallInteractionState,
  type BallPointerGeometry
} from './ball-interaction'

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

/** 角标（与 main/ball.ts 的 BallNotice 同构，Phase 2） */
type BallNotice =
  | { kind: 'countdown'; seconds: number }
  | { kind: 'error'; text: string }
  | { kind: 'hotkey-unavailable'; text: string }

interface BallApi {
  getStatus(): Promise<BallStatus>
  onStatus(callback: (status: BallStatus) => void): () => void
  onPlacement(callback: (placement: BallPlacement) => void): () => void
  onForceRetract(callback: () => void): () => void
  onNotice(callback: (notice: BallNotice | null) => void): () => void
  setPointerInside(inside: boolean): void
  setInteractionState(state: BallInteractionState): void
  dragStart(point: BallScreenPoint): void
  dragMove(point: BallScreenPoint): void
  dragEnd(payload: BallScreenPoint & { moved: boolean }): void
  openGraph(): void
  openTimeline(): void
  openContextMenu(): void
}

declare global {
  interface Window {
    gotchaBall: BallApi
  }
}

const DRAG_THRESHOLD = 3
const MOVE_THROTTLE_MS = 16

const ballElement = document.getElementById('ball')
if (!ballElement) throw new Error('找不到 #ball')
const ball: HTMLElement = ballElement

const noticeNode = document.getElementById('notice')
if (!noticeNode) throw new Error('找不到 #notice')
const noticeElement: HTMLElement = noticeNode

let docked = false
let dockEdge: BallEdge | null = null
let snapshot: BallInteractionSnapshot = initialSnapshot()
let graceTimer: ReturnType<typeof setTimeout> | null = null
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

function geometryAt(clientX: number, clientY: number): BallPointerGeometry {
  return { docked, distance: distanceToBall(clientX, clientY) }
}

function clearGraceTimer(): void {
  if (graceTimer === null) return
  clearTimeout(graceTimer)
  graceTimer = null
}

function dispatch(event: BallInteractionEvent): void {
  applySnapshot(reduceInteraction(snapshot, event))
}

function applySnapshot(next: BallInteractionSnapshot): void {
  const prev = snapshot
  snapshot = next
  ball.classList.toggle('expanded', isExpanded(next))
  if (next.pointerInside !== prev.pointerInside) {
    ball.classList.toggle('hover', next.pointerInside)
    window.gotchaBall.setPointerInside(next.pointerInside)
  }
  if (next.state === prev.state) return
  window.gotchaBall.setInteractionState(next.state)
  clearGraceTimer()
  // 宽限期由 renderer 计时（主进程另有游标兜底）；回到展开或缩回都会取消
  if (next.state === 'grace') {
    graceTimer = setTimeout(() => dispatch({ type: 'grace-expired' }), BALL_GRACE_MS)
  }
}

function applyPlacement(placement: BallPlacement): void {
  docked = placement.docked
  dockEdge = placement.edge
  ball.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom')
  if (docked && dockEdge) ball.classList.add(`dock-${dockEdge}`)
  dispatch({ type: 'placement', docked })
}

function applyStatus(status: BallStatus): void {
  const running = status === 'running'
  ball.classList.toggle('running', running)
  ball.classList.toggle('paused', !running)
}

/**
 * 角标（Phase 2）：倒计时显示剩余秒数，失败 / 热键被占用显示「!」并把原因放进 title。
 * null = 清除（draft 里角标不参与交互，pointer-events: none）。
 */
function applyNotice(notice: BallNotice | null): void {
  if (!notice) {
    noticeElement.hidden = true
    noticeElement.textContent = ''
    noticeElement.removeAttribute('data-kind')
    noticeElement.removeAttribute('title')
    return
  }
  noticeElement.hidden = false
  noticeElement.dataset.kind = notice.kind
  if (notice.kind === 'countdown') {
    noticeElement.textContent = String(notice.seconds)
    noticeElement.title = `${notice.seconds} 秒后开始记录（Alt+P 可取消）`
    return
  }
  noticeElement.textContent = '!'
  noticeElement.title = notice.text
}

function releasePointer(event: PointerEvent): void {
  try {
    ball.releasePointerCapture(event.pointerId)
  } catch {
    // 指针已释放（窗口隐藏 / 系统取消），忽略
  }
}

ball.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || distanceToBall(event.clientX, event.clientY) > BALL_HIT_RADIUS) return
  dragging = true
  dragMoved = false
  dragOrigin = { screenX: event.screenX, screenY: event.screenY }
  lastMoveAt = 0
  dispatch({ type: 'pointer-down', geometry: geometryAt(event.clientX, event.clientY) })
  ball.setPointerCapture?.(event.pointerId)
  ball.classList.add('dragging')
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
  dispatch({ type: 'pointer-move', geometry: geometryAt(event.clientX, event.clientY) })
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
  // 松手后由主进程 placement 消息决定缩入 / 自由；这里先按停靠态保持展开
  dispatch({ type: 'pointer-up', docked })
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
  dispatch({ type: 'pointer-cancel' })
})

window.addEventListener('pointerleave', () => {
  if (dragging) return
  dispatch({ type: 'pointer-leave' })
})

ball.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (dragging) return
  window.gotchaBall.openContextMenu()
})

void window.gotchaBall.getStatus().then(applyStatus).catch(() => {})
window.gotchaBall.onStatus(applyStatus)
window.gotchaBall.onPlacement(applyPlacement)
window.gotchaBall.onForceRetract(() => dispatch({ type: 'force-retract' }))
window.gotchaBall.onNotice(applyNotice)

export {}
