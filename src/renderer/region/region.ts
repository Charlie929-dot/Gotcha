/**
 * 选区遮罩（段二 A）
 *
 * 跟系统截图工具一样：**底下是活的屏幕**，canvas 只负责「压暗 + 把选区抠亮」。
 * 窗口是 transparent 的，所以：
 * - 画面 = 真实桌面（不是截图），随便滚动 / 播放都看得见；
 * - 选区靠 `clearRect` 抠出全透明，露出下面的实时画面；
 * - 裁图用的是点球那一刻抓的那一帧（遮罩不参与截图）。
 *
 * 只发两种结果：确认（选区非空）或取消（Esc / 右键 / 空选区）。
 */

interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

interface RegionApi {
  confirm(rect: RegionRect): Promise<boolean>
  cancel(): void
}

declare global {
  interface Window {
    gotchaRegion?: RegionApi
  }
}

const DIM_ALPHA = 0.45
const MIN_SIZE = 8

const api = window.gotchaRegion
const canvasElement = document.getElementById('stage')
if (!(canvasElement instanceof HTMLCanvasElement)) throw new Error('选区页面缺少 #stage')
const canvas: HTMLCanvasElement = canvasElement
const context = canvas.getContext('2d')
if (!context) throw new Error('canvas 2d 不可用')
const ctx: CanvasRenderingContext2D = context
const hint = document.getElementById('hint')

let dragStart: { x: number; y: number } | null = null
let current: RegionRect | null = null
let settled = false

function dpr(): number {
  return Math.max(1, window.devicePixelRatio || 1)
}

/** 画布按 DPR 放大，坐标仍用 CSS 像素（drag 坐标就是 DIP） */
function resize(): void {
  const ratio = dpr()
  canvas.width = Math.round(window.innerWidth * ratio)
  canvas.height = Math.round(window.innerHeight * ratio)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  render()
}

function render(): void {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  // 整屏压暗（窗口是透明的，暗层之外就是实时画面）
  ctx.fillStyle = `rgb(0 0 0 / ${DIM_ALPHA})`
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight)

  if (!current) return
  const { x, y, width, height } = current
  if (width <= 0 || height <= 0) return
  // 选区抠成全透明 = 透出下面的实时画面
  ctx.clearRect(x, y, width, height)
  ctx.strokeStyle = 'rgb(124 196 255)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(x + 0.75, y + 0.75, Math.max(0, width - 1.5), Math.max(0, height - 1.5))
}

function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): RegionRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y)
  }
}

function point(event: PointerEvent): { x: number; y: number } {
  return { x: event.clientX, y: event.clientY }
}

function reset(): void {
  dragStart = null
  current = null
  render()
}

function cancel(): void {
  if (settled) return
  settled = true
  api?.cancel()
}

function finish(): void {
  if (settled || !current) return
  if (current.width < MIN_SIZE || current.height < MIN_SIZE) {
    reset()
    return
  }
  settled = true
  void api?.confirm(current)
}

window.addEventListener('resize', resize)
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancel()
})
window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  cancel()
})

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  dragStart = point(event)
  current = { x: dragStart.x, y: dragStart.y, width: 0, height: 0 }
  canvas.setPointerCapture(event.pointerId)
  if (hint) hint.style.opacity = '0'
})

canvas.addEventListener('pointermove', (event) => {
  if (!dragStart) return
  current = rectBetween(dragStart, point(event))
  render()
})

canvas.addEventListener('pointerup', (event) => {
  if (event.button !== 0 || !dragStart) return
  current = rectBetween(dragStart, point(event))
  dragStart = null
  render()
  finish()
})

resize()

export {}
