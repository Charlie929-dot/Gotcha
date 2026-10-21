import { describe, expect, it } from 'vitest'
import { MAX_OCR_WIDTH, OCR_UPSCALE, ocrTargetSize } from '../../src/capture/ocr-scaling'

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
