/**
 * 悬浮球几何（m1b-plan §3 Phase 1 / §0 B1–B2）
 *
 * 纯函数，不含 Electron：贴边位置、边缘吸附、越界 clamp、比例位置、多屏回退都在这里，
 * 单测直接跑（tests/unit/ball-position.test.ts）。窗口 64 / 球体 48 / 贴边 6（Q2）。
 */

export type BallEdge = 'left' | 'right' | 'top' | 'bottom'

export const BALL_EDGES: readonly BallEdge[] = ['left', 'right', 'top', 'bottom']

/** 球窗口高度：球体 48 + 悬停放大 1.08 的余量（§3 Phase 1） */
export const BALL_WINDOW_SIZE = 64

/** 贴边内缩：窗口与屏幕工作区边缘的距离 */
export const BALL_EDGE_OFFSET = 6

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

/** `userData/ball.json` 的落盘结构（Q2 / Q8：只含边缘、比例、显示器 id） */
export interface BallSavedState {
  edge: BallEdge
  offset_ratio: number
  display_id: number
}

export interface BallDisplay {
  id: number
  workArea: BallRect
}

export interface BallLayout {
  displayId: number
  edge: BallEdge
  offsetRatio: number
  position: BallPoint
}

export function isBallEdge(value: unknown): value is BallEdge {
  return typeof value === 'string' && (BALL_EDGES as readonly string[]).includes(value)
}

/**
 * 把 DIP 坐标吸附到显示器物理像素网格。
 *
 * 为什么需要（真机坑，见 gotchas「125% 缩放下窗口变胖」）：Electron 的
 * `setPosition` 只接受整数 DIP；在 125% / 175% 这类非整数缩放下，非整数物理像素的
 * 位置会让 Windows/Chromium 取整窗口尺寸，64px 的球窗口每移动一次就宽 1px（64→68→69…）。
 * 吸附到「DIP × scale 为整数」的最近整数坐标后尺寸保持稳定；代价是边缘留白会有
 * 半个物理像素级的偏差（125% 下 6px 贴边会落成 4–8px）。
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
 * 按边缘 + 比例算窗口左上角。
 *
 * 左右边缘：y = workArea.y + ratio * (height - size)，即垂直居中时 ratio = 0.5；
 * 上下边缘：x = workArea.x + ratio * (width - size)。
 */
export function positionFor(
  edge: BallEdge,
  offsetRatio: number,
  workArea: BallRect,
  size: number = BALL_WINDOW_SIZE
): BallPoint {
  const ratio = clampRatio(offsetRatio)
  const spanX = Math.max(0, workArea.width - size)
  const spanY = Math.max(0, workArea.height - size)
  const centeredX = workArea.x + ratio * spanX
  const centeredY = workArea.y + ratio * spanY

  const position: BallPoint =
    edge === 'left'
      ? { x: workArea.x + BALL_EDGE_OFFSET, y: centeredY }
      : edge === 'right'
        ? { x: workArea.x + workArea.width - size - BALL_EDGE_OFFSET, y: centeredY }
        : edge === 'top'
          ? { x: centeredX, y: workArea.y + BALL_EDGE_OFFSET }
          : { x: centeredX, y: workArea.y + workArea.height - size - BALL_EDGE_OFFSET }

  return clampPosition(position, workArea, size)
}

/** 吸附：取窗口中心离哪条工作区边缘最近 */
export function nearestEdge(
  position: BallPoint,
  workArea: BallRect,
  size: number = BALL_WINDOW_SIZE
): BallEdge {
  const centerX = position.x + size / 2
  const centerY = position.y + size / 2
  const distances: Array<[BallEdge, number]> = [
    ['left', centerX - workArea.x],
    ['right', workArea.x + workArea.width - centerX],
    ['top', centerY - workArea.y],
    ['bottom', workArea.y + workArea.height - centerY]
  ]
  let best: BallEdge = 'left'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [edge, distance] of distances) {
    if (distance < bestDistance) {
      best = edge
      bestDistance = distance
    }
  }
  return best
}

/** 当前窗口位置在指定边缘上的比例（吸附后落盘用） */
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

/**
 * 从落盘状态（或默认态）解析出目标显示器与窗口位置。
 *
 * 默认：主屏右边缘垂直居中（B1）。display_id 找不到（拔屏 / 分辨率变化后 id 失效）
 * 回退主屏并记日志由调用方负责（§6「缺失 display_id 回退主屏」）。
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
  const edge: BallEdge = saved?.edge ?? 'right'
  const offsetRatio = saved ? clampRatio(saved.offset_ratio) : 0.5
  return {
    displayId: target.id,
    edge,
    offsetRatio,
    position: positionFor(edge, offsetRatio, target.workArea, size)
  }
}
