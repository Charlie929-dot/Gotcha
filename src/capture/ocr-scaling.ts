/**
 * 抓帧输出尺寸策略（m1a-plan §3 Phase 2b + 信息链证据图）
 *
 * WinRT 的字检测对**字号**敏感：同一张真实窗口截图，原生尺寸 15 个关键词命中 11/15，
 * 放大 2 倍后 15/15（2026-10-21 真机实验，见 gotchas.md）。所以 **OCR 输入**统一放大 2 倍，
 * 只在超过上限时封顶，不再为了省耗时而降采样到 1280。
 *
 * 信息链的**证据截图**不喂 OCR（D44：采集即 JPEG q85，宽度按档位收敛到 1920 / 1440 / 1280），
 * 放大 2 倍纯属白烧：2560 宽的窗先变 5120 宽，再由主进程解码 + 缩回 1920，一次抓帧多几倍像素与
 * 编码时间（真机 2026-10-27 表现为「采集开着时鼠标隔几秒一顿」）。所以尺寸策略做成参数：
 * 默认仍是 OCR 口径，证据图传 `upscale: 1`。
 */

/** OCR 输入放大倍数 */
export const OCR_UPSCALE = 2

/**
 * 单帧 OCR 输入宽度上限。
 * 1920 物理像素宽的全屏窗口 ×2 = 3840；实测该量级单帧 OCR 约 120–200ms（1152 宽窗口 2× = 118ms）。
 */
export const MAX_OCR_WIDTH = 3840

/** 证据截图（不喂 OCR）的默认输出宽上限：D44 标定表里的 warm 档宽度 */
export const EVIDENCE_MAX_WIDTH = 1920

/** 抓帧尺寸参数；不传就是 OCR 口径（2×、封顶 3840） */
export interface CaptureTargetOptions {
  /** 相对裁剪区的放大倍数（1 = 原生像素、不放大；缺省 = OCR 的 2×） */
  upscale?: number
  /** 输出宽上限（等比缩放；缺省 = OCR 的 3840） */
  maxWidth?: number
}

export interface Size {
  width: number
  height: number
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 由裁剪后的窗口尺寸推算抓帧输出尺寸（等比、封顶、至少 1px）。
 *
 * 先按 `upscale` 放大，再封到 `maxWidth`——两者同时给出时以「不超过 maxWidth」为准
 * （证据图 `upscale: 1, maxWidth: 1920` = 不放大、超宽的窗缩到 1920）。
 */
export function captureTargetSize(
  width: number,
  height: number,
  options: CaptureTargetOptions = {}
): Size {
  const upscale = positiveOr(options.upscale, OCR_UPSCALE)
  const maxWidth = Math.round(positiveOr(options.maxWidth, MAX_OCR_WIDTH))
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const targetWidth = Math.min(maxWidth, Math.max(1, Math.round(safeWidth * upscale)))
  const targetHeight = Math.max(1, Math.round((safeHeight * targetWidth) / safeWidth))
  return { width: targetWidth, height: targetHeight }
}

/** OCR 口径的输出尺寸（`captureTargetSize` 的默认参数，保留旧入口） */
export function ocrTargetSize(width: number, height: number): Size {
  return captureTargetSize(width, height)
}
