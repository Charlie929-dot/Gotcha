/**
 * 截屏几何计算（m1a-plan §3 Phase 2b）
 *
 * 屏幕捕获本身由隐藏采集窗口的持久流完成（见 screen-stream.ts）；这里只保留
 * 可单测的纯逻辑：按物理像素找到窗口所在显示器、把窗口 bounds 映射成视频像素的
 * 裁剪区域，并按 OCR 策略算 2× 目标尺寸。
 */

import { ocrTargetSize } from './ocr-scaling'

/** dHash 输入尺寸（90x80，便于整数降到 9x8） */
export const DIFF_WIDTH = 90
export const DIFF_HEIGHT = 80

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface CapturedFrame {
  imagePath: string
  /** OCR 图宽（放大 2×，上限 MAX_OCR_WIDTH） */
  width: number
  /** OCR 图高 */
  height: number
  /** 90x80 灰度图的 dHash 指纹；尺寸必须用 DIFF_WIDTH/DIFF_HEIGHT 算 */
  diffHash: bigint
}

/** 与 Electron Display 同形，便于单测注入 */
export interface DisplayInfo {
  id: number
  bounds: Rect
  scaleFactor: number
}

export interface CaptureGeometry {
  /** 在视频帧像素坐标系里的裁剪矩形 */
  crop: Rect
  /** 送给 OCR 的 2× 目标尺寸 */
  target: { width: number; height: number }
}

/**
 * active-win 在 Electron 主进程返回物理像素；display.bounds 是 DIP，
 * 先用 scaleFactor 换到物理像素再比较（gotchas.md「active-win 返回物理像素」）。
 */
export function findDisplayForPhysicalPoint(
  displays: readonly DisplayInfo[],
  primary: DisplayInfo,
  point: { x: number; y: number }
): DisplayInfo {
  return (
    displays.find((display) => {
      const left = display.bounds.x * display.scaleFactor
      const top = display.bounds.y * display.scaleFactor
      return (
        point.x >= left &&
        point.x < left + display.bounds.width * display.scaleFactor &&
        point.y >= top &&
        point.y < top + display.bounds.height * display.scaleFactor
      )
    }) ?? primary
  )
}

function clampRect(rect: Rect, maxWidth: number, maxHeight: number): Rect | null {
  const x = Math.max(0, Math.min(maxWidth - 1, Math.round(rect.x)))
  const y = Math.max(0, Math.min(maxHeight - 1, Math.round(rect.y)))
  const width = Math.min(maxWidth - x, Math.round(rect.width))
  const height = Math.min(maxHeight - y, Math.round(rect.height))
  if (width < 8 || height < 8) return null
  return { x, y, width, height }
}

/**
 * 窗口 bounds（物理像素）→ 视频帧像素裁剪区。
 * 视频尺寸通常等于显示器物理尺寸，但 Electron/Chromium 可能缩略，故按比例换算。
 */
export function computeCaptureGeometry(
  bounds: Rect,
  display: DisplayInfo,
  video: { width: number; height: number }
): CaptureGeometry {
  if (video.width <= 0 || video.height <= 0) {
    throw new RangeError(`视频尺寸非法: ${video.width}x${video.height}`)
  }
  const scale = display.scaleFactor
  const displayPhysical: Rect = {
    x: display.bounds.x * scale,
    y: display.bounds.y * scale,
    width: display.bounds.width * scale,
    height: display.bounds.height * scale
  }
  const ratioX = video.width / displayPhysical.width
  const ratioY = video.height / displayPhysical.height
  const relative: Rect = {
    x: (bounds.x - displayPhysical.x) * ratioX,
    y: (bounds.y - displayPhysical.y) * ratioY,
    width: bounds.width * ratioX,
    height: bounds.height * ratioY
  }
  const crop = clampRect(relative, video.width, video.height) ?? {
    x: 0,
    y: 0,
    width: video.width,
    height: video.height
  }
  const target = ocrTargetSize(crop.width, crop.height)
  return { crop, target }
}
