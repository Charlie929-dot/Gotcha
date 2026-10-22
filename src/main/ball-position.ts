/**
 * 悬浮球几何（m1b-plan §3 Phase 1 / §0 B1–B2，2026-10-22 拍板改为腾讯管家式停靠）
 *
 * 停靠语义（D15）：
 * - docked：窗口贴齐工作区边缘（窗口不出屏），球体在窗口内平移 32px 缩进 → 只露出半颗
 *   （24px）；悬停由 renderer 把球滑回窗口中心（全显），移开缩回。
 * - free：拖动松手停在原地，球完整可见。
 * - 吸附：松手位置离边缘 ≤ 24px 才停靠，否则保持自由位。
 *
 * 纯函数，不含 Electron：单测直接跑（tests/unit/ball-position.test.ts）。
 */

export type BallEdge = 'left' | 'right' | 'top' | 'bottom'

export const BALL_EDGES: readonly BallEdge[] = ['left', 'right', 'top', 'bottom']

/** 球窗口尺寸（球体 48 + 悬停放大余量） */
export const BALL_WINDOW_SIZE = 64

/** 球体直径（缩进后露出半径 = 24px） */
export const BALL_SIZE = 48

/** 停靠时球体相对窗口中心的平移量 = 窗口一半，露出半颗球 */
export const BALL_TUCK_OFFSET = BALL_WINDOW_SIZE / 2

/** 松手点到边缘的距离阈值：在此范围内才吸附停靠 */
export const DOCK_THRESHOLD = 24

export interface BallRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BallPoint {
  x: number
  y: number
}

/**
 * `userData/ball.json` 落盘结构（Q2 / Q8 / D15）。
 *
 * - `edge` 非 null：停靠在边缘，位置由 `edge` + `offset_ratio` 决定；
 * - `edge` 为 null：自由停在某处，位置由 `x_ratio` / `y_ratio` 决定（相对工作区跨度）；
 * - 都不含任何采集内容。
 */
export interface BallSavedState {
  edge: BallEdge | null
  offset_ratio: number
  x_ratio: number
  y_ratio: number
  display_id: number
}

export interface BallDisplay {
  id: number
  workArea: BallRect
}

export interface BallLayout {
  displayId: number
  docked: boolean
  edge: BallEdge | null
  offsetRatio: number
  position: BallPoint
}

export function isBallEdge(value: unknown): value is BallEdge {
  return typeof value === 'string' && (BALL_EDGES as readonly string[]).includes(value)
}

/**
 * 把 DIP 坐标吸附到显示器物理像素网格。
 *
 * 为什么需要（真机坑，见 gotchas「非整数缩放下窗口变胖」）：Electron 的
 * `setPosition` 只接受整数 DIP；在 125% / 175% 这类非整数缩放下，非整数物理像素的
 * 位置会让 Windows/Chromium 取整窗口尺寸，64px 的球窗口每移动一次就宽 1px（64→68→69…）。
 * 吸附到「DIP × scale 为整数」的最近整数坐标后尺寸保持稳定。
 */
export function snapToPixelGrid(value: number, scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return Math.round(value)
  const base = Math.round(value)
  for (let delta = 0; delta <= 16; delta++) {
    const candidates = delta === 0 ? [base] : [base - delta, base + delta]
    for (const candidate of candidates) {
      const physical = candidate * scaleFactor
      if (Math.abs(physical - Math.round(physical)) < 1e-6) return candidate
    }
  }
  return base
}

/** 把整点吸附到像素网格（窗口位置落点统一走这里） */
export function positionOnPixelGrid(position: BallPoint, scaleFactor: number): BallPoint {
  return {
    x: snapToPixelGrid(position.x, scaleFactor),
    y: snapToPixelGrid(position.y, scaleFactor)
  }
}

/** 比例夹到 [0, 1]；非有限数按 0 处理（文件损坏时不抛错） */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0
  return Math.min(1, Math.max(0, ratio))
}

/** 把窗口完整夹回工作区（窗口比工作区还大时贴左上，不产生负坐标） */
export function clampPosition(
  position: BallPoint,
  workArea: BallRect,
  size: number = BALL_WINDOW_SIZE
): BallPoint {
  const maxX = workArea.x + Math.max(0, workArea.width - size)
  const maxY = workArea.y + Math.max(0, workArea.height - size)
  return {
    x: Math.min(Math.max(position.x, workArea.x), maxX),
    y: Math.min(Math.max(position.y, workArea.y), maxY)
  }
}

/**
 * 停靠位：窗口贴齐工作区边缘（球体由 renderer 平移缩进，窗口本身不出屏）。
 *
 * 左右边缘：y = workArea.y + ratio * (height - size)；上下边缘：x 同理。
 */
export function dockedPosition(
  edge: BallEdge,
  offsetRatio: number,
  workArea: BallRect,
  size: number = BALL_WINDOW_SIZE
): BallPoint {
  const ratio = clampRatio(offsetRatio)
  const spanX = Math.max(0, workArea.width - size)
  const spanY = Math.max(0, workArea.height - size)
  const alongX = workArea.x + ratio * spanX
  const alongY = workArea.y + ratio * spanY

  const position: BallPoint =
    edge === 'left'
      ? { x: workArea.x, y: alongY }
      : edge === 'right'
        ? { x: workArea.x + workArea.width - size, y: alongY }
        : edge === 'top'
          ? { x: alongX, y: workArea.y }
          : { x: alongX, y: workArea.y + workArea.height - size }

  return clampPosition(position, workArea, size)
}

/** 自由位：按工作区跨度比例还原窗口左上角（分辨率 / 拔屏后仍可还原） */
export function freePosition(
  xRatio: number,
  yRatio: number,
  workArea: BallRect,
  size: number = BALL_WINDOW_SIZE
): BallPoint {
  const spanX = Math.max(0, workArea.width - size)
  const spanY = Math.max(0, workArea.height - size)
  const position = {
    x: workArea.x + clampRatio(xRatio) * spanX,
    y: workArea.y + clampRatio(yRatio) * spanY
  }
  return clampPosition(position, workArea, size)
}

/** 吸附判定：窗口任一方向离工作区边缘 ≤ threshold 时返回最近边缘，否则 null */
export function nearestEdgeWithin(
  position: BallPoint,
  workArea: BallRect,
  threshold: number = DOCK_THRESHOLD,
  size: number = BALL_WINDOW_SIZE
): BallEdge | null {
  const distances: Array<[BallEdge, number]> = [
    ['left', position.x - workArea.x],
    ['right', workArea.x + workArea.width - (position.x + size)],
    ['top', position.y - workArea.y],
    ['bottom', workArea.y + workArea.height - (position.y + size)]
  ]
  let best: BallEdge | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [edge, distance] of distances) {
    if (distance <= threshold && distance < bestDistance) {
      best = edge
      bestDistance = distance
    }
  }
  return best
}

/** 当前窗口位置在指定边缘上的比例（停靠落盘用） */
export function ratioFor(
  edge: BallEdge,
  position: BallPoint,
  workArea: BallRect,
  size: number = BALL_WINDOW_SIZE
): number {
  const spanX = Math.max(0, workArea.width - size)
  const spanY = Math.max(0, workArea.height - size)
  const raw =
    edge === 'left' || edge === 'right'
      ? spanY === 0
        ? 0
        : (position.y - workArea.y) / spanY
      : spanX === 0
        ? 0
        : (position.x - workArea.x) / spanX
  return clampRatio(raw)
}

/** 自由位落盘用的 x / y 比例（反算 freePosition） */
export function ratiosForFree(
  position: BallPoint,
  workArea: BallRect,
  size: number = BALL_WINDOW_SIZE
): { xRatio: number; yRatio: number } {
  const spanX = Math.max(0, workArea.width - size)
  const spanY = Math.max(0, workArea.height - size)
  return {
    xRatio: spanX === 0 ? 0 : clampRatio((position.x - workArea.x) / spanX),
    yRatio: spanY === 0 ? 0 : clampRatio((position.y - workArea.y) / spanY)
  }
}

/**
 * 从落盘状态（或默认态）解析出目标显示器与窗口位置。
 *
 * 默认：主屏右边缘垂直居中、半缩入（B1 / D15）。
 * `display_id` 找不到（拔屏 / 分辨率变化后 id 失效）回退主屏并记日志由调用方负责。
 */
export function resolveLayout(
  saved: BallSavedState | null,
  displays: readonly BallDisplay[],
  primaryId: number,
  size: number = BALL_WINDOW_SIZE
): BallLayout {
  const fallbackArea: BallRect = { x: 0, y: 0, width: 0, height: 0 }
  const primary =
    displays.find((display) => display.id === primaryId) ??
    displays[0] ?? { id: primaryId, workArea: fallbackArea }
  const target =
    (saved ? displays.find((display) => display.id === saved.display_id) : undefined) ?? primary

  if (saved && saved.edge === null) {
    const xRatio = clampRatio(saved.x_ratio)
    const yRatio = clampRatio(saved.y_ratio)
    return {
      displayId: target.id,
      docked: false,
      edge: null,
      offsetRatio: 0,
      position: freePosition(xRatio, yRatio, target.workArea, size)
    }
  }

  const edge: BallEdge = saved?.edge ?? 'right'
  const offsetRatio = saved ? clampRatio(saved.offset_ratio) : 0.5
  return {
    displayId: target.id,
    docked: true,
    edge,
    offsetRatio,
    position: dockedPosition(edge, offsetRatio, target.workArea, size)
  }
}
