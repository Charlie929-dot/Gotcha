/**
 * 选区截图：选择框（DIP）→ 整屏帧像素坐标的纯几何
 *
 * 只做坐标换算，不碰 Electron、不读写文件——单测可以直接跑（`tests/unit/ask-region.test.ts`）。
 * 口径：遮罩窗口就在被选的那块显示器上，所以传进来的 rect 是**显示器内局部坐标**（从 0 起）；
 * 整屏帧是这块显示器的物理像素尺寸，两者用 bounds.width / frame.width 的比例换算。
 */

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayBox {
  width: number
  height: number
}

export interface FrameBox {
  width: number
  height: number
}

/** 选区下限（DIP）：宽或高不足这个值就当「没选」——十来个像素的框没有信息量 */
export const MIN_SELECTION_DIP = 8

/** 帧裁剪区下限（物理像素）：换算后太小的直接丢掉 */
export const MIN_FRAME_CROP_PX = 4

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 选择框 → 帧裁剪区。
 *
 * - 尺寸不合法 / 小于下限 / 显示器或帧尺寸非法 → null（调用方按「用户没选」处理）；
 * - 换算后越出帧边界就夹回帧内（拖动时滑出边缘很常见，夹一下比拒绝更好）；
 * - 结果取整：`nativeImage.crop()` 只接受整数。
 */
export function selectionToFrameCrop(
  rect: ScreenRect,
  display: DisplayBox,
  frame: FrameBox
): ScreenRect | null {
  if (
    !finite(rect.x) ||
    !finite(rect.y) ||
    !finite(rect.width) ||
    !finite(rect.height) ||
    !finite(display.width) ||
    !finite(display.height) ||
    !finite(frame.width) ||
    !finite(frame.height)
  ) {
    return null
  }
  if (display.width <= 0 || display.height <= 0 || frame.width <= 0 || frame.height <= 0) return null
  if (rect.width < MIN_SELECTION_DIP || rect.height < MIN_SELECTION_DIP) return null

  const scaleX = frame.width / display.width
  const scaleY = frame.height / display.height
  const left = Math.max(0, Math.round(rect.x * scaleX))
  const top = Math.max(0, Math.round(rect.y * scaleY))
  const right = Math.min(frame.width, Math.round((rect.x + rect.width) * scaleX))
  const bottom = Math.min(frame.height, Math.round((rect.y + rect.height) * scaleY))
  const width = right - left
  const height = bottom - top
  if (width < MIN_FRAME_CROP_PX || height < MIN_FRAME_CROP_PX) return null
  return { x: left, y: top, width, height }
}

/** 选区归一化：拖动可以从右下往左上，最终给成左上角 + 正尺寸（局部坐标） */
export function normalizeSelection(
  start: { x: number; y: number },
  end: { x: number; y: number }
): ScreenRect {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}
