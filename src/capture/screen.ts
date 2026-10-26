/**
 * 截屏几何计算（m1a-plan §3 Phase 2b）
 *
 * 屏幕捕获本身由隐藏采集窗口的持久流完成（见 screen-stream.ts）；这里只保留
 * 可单测的纯逻辑：按物理像素找到窗口所在显示器、把窗口 bounds 映射成视频像素的
 * 裁剪区域，并按 OCR 策略算 2× 目标尺寸。
 */

import { captureTargetSize, type CaptureTargetOptions } from './ocr-scaling'

/** dHash 输入尺寸（90x80，便于整数降到 9x8） */
export const DIFF_WIDTH = 90
export const DIFF_HEIGHT = 80

/**
 * DWM 不可见边框宽度（屏幕物理像素，2026-10-24 本机实测）。
 *
 * `active-win` 用 `GetWindowRect` 取窗口矩形，而可见窗口边缘是 DWM 的
 * `DWMWA_EXTENDED_FRAME_BOUNDS`：本机同一批窗口实测 L/R/B 各多 8px、顶边 0
 * （125% 缩放下 8px；100% 缩放下 8–9px，测的是 Process Lasso 的自绘边框）。
 * 直接按 GetWindowRect 裁剪，会把这圈「窗口背后」的 8px 一起送进 OCR——
 * 邻窗 / 桌面的文字就是这样混进事件里的（拍板人真机反馈）。
 *
 * 顶边不内缩：正常窗口的 GetWindowRect 顶边就是可见边（实测差 0），
 * 内缩反而会切掉标题栏最上面几像素。
 */
export const WINDOW_FRAME_INSET = 8

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

/** 裁剪区下限：宽或高不足这个值就没法做有意义的 OCR */
const MIN_CROP_SIZE = 8

/**
 * 把 GetWindowRect 的 bounds 内缩成「可见窗口」：左 / 右 / 下各去掉
 * `WINDOW_FRAME_INSET`，顶边不动（见常量注释）。
 *
 * 小窗口自适应：内缩后必须仍有 ≥ MIN_CROP_SIZE 的宽度，否则就按窗口尺寸
 * 少缩一点——绝不能因为「内缩后太小」而走到整帧回退（那等于把整屏送去 OCR）。
 */
export function insetWindowBounds(bounds: Rect, inset: number = WINDOW_FRAME_INSET): Rect {
  if (!(inset > 0) || bounds.width <= 0 || bounds.height <= 0) return bounds
  const maxInset = Math.max(
    0,
    Math.floor((Math.min(bounds.width, bounds.height) - MIN_CROP_SIZE) / 2)
  )
  const amount = Math.min(Math.round(inset), maxInset)
  if (amount <= 0) return bounds
  return {
    x: bounds.x + amount,
    y: bounds.y,
    width: bounds.width - amount * 2,
    height: bounds.height - amount
  }
}

/**
 * 与视频帧求交：窗口部分在屏幕外时只保留真正在屏内的那部分。
 * 旧实现先把原点夹到 0、再夹宽度，等于把窗口右/下多截了一段屏幕外内容。
 */
function intersectWithVideo(rect: Rect, videoWidth: number, videoHeight: number): Rect | null {
  const x = Math.max(0, Math.round(rect.x))
  const y = Math.max(0, Math.round(rect.y))
  const right = Math.min(videoWidth, Math.round(rect.x + rect.width))
  const bottom = Math.min(videoHeight, Math.round(rect.y + rect.height))
  const width = right - x
  const height = bottom - y
  if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) return null
  return { x, y, width, height }
}

/**
 * 窗口 bounds（物理像素）→ 视频帧像素裁剪区。
 * 视频尺寸通常等于显示器物理尺寸，但 Electron/Chromium 可能缩略，故按比例换算。
 *
 * 裁剪区只覆盖「可见窗口」：先按 `WINDOW_FRAME_INSET` 去掉 DWM 不可见边框，
 * 再与视频求交。窗口几乎整块在屏幕外（或尺寸过小）时**抛错跳过本帧**，
 * 不回退整帧——回退整帧会把整屏内容送进 OCR（隐私 + 噪声双重问题）。
 *
 * `target` 决定输出尺寸：不传就是 OCR 口径（2× 放大、封顶 3840）；信息链证据图传
 * `{ upscale: 1, maxWidth: 1920 }`，不放大、超宽的窗直接缩到 1920（见 `chain-shot.ts`）。
 */
export function computeCaptureGeometry(
  bounds: Rect,
  display: DisplayInfo,
  video: { width: number; height: number },
  inset: number = WINDOW_FRAME_INSET,
  target?: CaptureTargetOptions
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
  const visible = insetWindowBounds(bounds, inset)
  const relative: Rect = {
    x: (visible.x - displayPhysical.x) * ratioX,
    y: (visible.y - displayPhysical.y) * ratioY,
    width: visible.width * ratioX,
    height: visible.height * ratioY
  }
  const crop = intersectWithVideo(relative, video.width, video.height)
  if (!crop) {
    throw new RangeError(
      `窗口可见区域不在屏幕内或过小（${Math.round(relative.x)},${Math.round(relative.y)} ${Math.round(relative.width)}x${Math.round(relative.height)}）`
    )
  }
  const targetSize = captureTargetSize(crop.width, crop.height, target)
  return { crop, target: targetSize }
}
