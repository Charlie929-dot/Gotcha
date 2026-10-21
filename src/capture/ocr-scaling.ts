/**
 * OCR 输入尺寸策略（m1a-plan §3 Phase 2b）
 *
 * WinRT 的字检测对**字号**敏感：同一张真实窗口截图，原生尺寸 15 个关键词命中 11/15，
 * 放大 2 倍后 15/15（2026-10-21 真机实验，见 gotchas.md）。所以 OCR 输入统一放大 2 倍，
 * 只在超过上限时封顶，不再为了省耗时而降采样到 1280。
 */

/** OCR 输入放大倍数 */
export const OCR_UPSCALE = 2

/**
 * 单帧 OCR 输入宽度上限。
 * 1920 物理像素宽的全屏窗口 ×2 = 3840；实测该量级单帧 OCR 约 120–200ms（1152 宽窗口 2× = 118ms）。
 */
export const MAX_OCR_WIDTH = 3840

export interface Size {
  width: number
  height: number
}

/** 由裁剪后的窗口尺寸推算送给 OCR 的尺寸（等比、封顶、至少 1px） */
export function ocrTargetSize(width: number, height: number): Size {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const targetWidth = Math.min(MAX_OCR_WIDTH, Math.max(1, Math.round(safeWidth * OCR_UPSCALE)))
  const targetHeight = Math.max(1, Math.round((safeHeight * targetWidth) / safeWidth))
  return { width: targetWidth, height: targetHeight }
}
