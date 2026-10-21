import { describe, expect, it } from 'vitest'
import {
  computeCaptureGeometry,
  DIFF_HEIGHT,
  DIFF_WIDTH,
  findDisplayForPhysicalPoint,
  type DisplayInfo
} from '../../src/capture/screen'

const primary: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1536, height: 864 },
  scaleFactor: 1.25
}

const secondary: DisplayInfo = {
  id: 2,
  bounds: { x: 1536, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1
}

describe('findDisplayForPhysicalPoint', () => {
  it('按物理像素命中主屏', () => {
    expect(findDisplayForPhysicalPoint([primary, secondary], primary, { x: 100, y: 100 })).toBe(
      primary
    )
  })

  it('按物理像素命中副屏（DIP 原点 × scaleFactor）', () => {
    // 副屏 DIP 起点 1536，scale=1 → 物理起点 1536；点 2000 落在副屏
    expect(findDisplayForPhysicalPoint([primary, secondary], primary, { x: 2000, y: 500 })).toBe(
      secondary
    )
  })

  it('点落在所有屏幕外时回退主屏', () => {
    expect(findDisplayForPhysicalPoint([primary, secondary], primary, { x: -1, y: -1 })).toBe(
      primary
    )
  })
})

describe('computeCaptureGeometry', () => {
  it('视频与显示器物理尺寸一致时按物理像素裁剪', () => {
    const geometry = computeCaptureGeometry(
      { x: 100, y: 80, width: 1375, height: 1000 },
      primary,
      { width: 1920, height: 1080 }
    )
    expect(geometry.crop).toEqual({ x: 100, y: 80, width: 1375, height: 1000 })
    expect(geometry.target).toEqual({ width: 2750, height: 2000 })
  })

  it('视频被 Chromium 缩略时按比例换算裁剪与目标尺寸', () => {
    const geometry = computeCaptureGeometry(
      { x: 100, y: 80, width: 1375, height: 1000 },
      primary,
      { width: 960, height: 540 }
    )
    expect(geometry.crop).toEqual({ x: 50, y: 40, width: 688, height: 500 })
    expect(geometry.target).toEqual({ width: 1376, height: 1000 })
  })

  it('窗口部分在屏幕外时裁剪到视频边界', () => {
    const geometry = computeCaptureGeometry(
      { x: -50, y: -50, width: 100, height: 100 },
      primary,
      { width: 1920, height: 1080 }
    )
    expect(geometry.crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(geometry.target).toEqual({ width: 200, height: 200 })
  })

  it('裁剪区过小时回退整帧', () => {
    const geometry = computeCaptureGeometry(
      { x: 1916, y: 1076, width: 10, height: 10 },
      primary,
      { width: 1920, height: 1080 }
    )
    expect(geometry.crop).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('视频尺寸非法时抛错', () => {
    expect(() =>
      computeCaptureGeometry({ x: 0, y: 0, width: 10, height: 10 }, primary, {
        width: 0,
        height: 0
      })
    ).toThrow(RangeError)
  })

  it('dHash 输入尺寸保持 90x80', () => {
    expect(DIFF_WIDTH).toBe(90)
    expect(DIFF_HEIGHT).toBe(80)
  })
})
