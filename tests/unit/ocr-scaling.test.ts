import { describe, expect, it } from 'vitest'
import {
  captureTargetSize,
  EVIDENCE_MAX_WIDTH,
  MAX_OCR_WIDTH,
  OCR_UPSCALE,
  ocrTargetSize
} from '../../src/capture/ocr-scaling'

describe('OCR 输入尺寸策略', () => {
  it('放大 2 倍并等比保持宽高', () => {
    expect(ocrTargetSize(1152, 592)).toEqual({ width: 2304, height: 1184 })
    expect(ocrTargetSize(100, 50)).toEqual({ width: 200, height: 100 })
  })

  it('全屏 1920 宽放大到 3840（正好等于上限）', () => {
    expect(MAX_OCR_WIDTH).toBe(3840)
    expect(OCR_UPSCALE).toBe(2)
    expect(ocrTargetSize(1920, 1080)).toEqual({ width: 3840, height: 2160 })
  })

  it('超过上限时封顶且保持比例', () => {
    expect(ocrTargetSize(4000, 2000)).toEqual({ width: 3840, height: 1920 })
  })

  it('奇数尺寸四舍五入，高度至少 1px', () => {
    const { width, height } = ocrTargetSize(1023, 1023)
    expect(width).toBe(2046)
    expect(height).toBe(2046)
    expect(ocrTargetSize(3, 1)).toEqual({ width: 6, height: 2 })
  })

  it('异常尺寸不抛错，仍给出正数尺寸', () => {
    for (const [w, h] of [
      [0, 0],
      [-10, 5]
    ]) {
      const size = ocrTargetSize(w, h)
      expect(size.width).toBeGreaterThan(0)
      expect(size.height).toBeGreaterThan(0)
    }
  })
})

describe('证据截图尺寸策略（不喂 OCR，不放大）', () => {
  it('upscale 1 = 原生像素，不放大', () => {
    expect(captureTargetSize(1152, 592, { upscale: 1, maxWidth: EVIDENCE_MAX_WIDTH })).toEqual({
      width: 1152,
      height: 592
    })
  })

  it('超过上限时缩到 1920 并保持比例', () => {
    expect(captureTargetSize(2560, 1440, { upscale: 1, maxWidth: EVIDENCE_MAX_WIDTH })).toEqual({
      width: 1920,
      height: 1080
    })
  })

  it('默认参数与 ocrTargetSize 完全一致（旧路径不受影响）', () => {
    for (const [w, h] of [
      [1152, 592],
      [1920, 1080],
      [4000, 2000],
      [1023, 1023]
    ]) {
      expect(captureTargetSize(w, h)).toEqual(ocrTargetSize(w, h))
    }
  })

  it('非法参数回落到默认值（不放大到 0，也不缩到 0）', () => {
    expect(captureTargetSize(1000, 500, { upscale: 0, maxWidth: 0 })).toEqual(
      ocrTargetSize(1000, 500)
    )
    expect(captureTargetSize(1000, 500, { upscale: Number.NaN, maxWidth: -1 })).toEqual(
      ocrTargetSize(1000, 500)
    )
  })
})
