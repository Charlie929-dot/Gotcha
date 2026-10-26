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
  it('视频与显示器物理尺寸一致时按物理像素裁剪，且去掉 DWM 不可见边框', () => {
    const geometry = computeCaptureGeometry(
      { x: 100, y: 80, width: 1375, height: 1000 },
      primary,
      { width: 1920, height: 1080 }
    )
    // 左 / 右 / 下各内缩 8px，顶边不动
    expect(geometry.crop).toEqual({ x: 108, y: 80, width: 1359, height: 992 })
    expect(geometry.target).toEqual({ width: 2718, height: 1984 })
  })

  it('视频被 Chromium 缩略时按比例换算裁剪与目标尺寸', () => {
    const geometry = computeCaptureGeometry(
      { x: 100, y: 80, width: 1375, height: 1000 },
      primary,
      { width: 960, height: 540 }
    )
    expect(geometry.crop).toEqual({ x: 54, y: 40, width: 680, height: 496 })
    expect(geometry.target).toEqual({ width: 1360, height: 992 })
  })

  it('窗口部分在屏幕外时只保留在屏内那部分（不再多截屏幕外内容）', () => {
    const geometry = computeCaptureGeometry(
      { x: -50, y: -50, width: 100, height: 100 },
      primary,
      { width: 1920, height: 1080 }
    )
    expect(geometry.crop).toEqual({ x: 0, y: 0, width: 42, height: 42 })
    expect(geometry.target).toEqual({ width: 84, height: 84 })
  })

  it('最大化窗口（bounds 在负坐标）按可见区域裁剪', () => {
    const geometry = computeCaptureGeometry(
      { x: -9, y: -9, width: 1938, height: 1038 },
      primary,
      { width: 1920, height: 1080 }
    )
    expect(geometry.crop).toEqual({ x: 0, y: 0, width: 1920, height: 1021 })
  })

  it('小窗口自适应内缩，绝不因为内缩后太小而回退整帧', () => {
    const geometry = computeCaptureGeometry(
      { x: 20, y: 20, width: 20, height: 20 },
      primary,
      { width: 1920, height: 1080 }
    )
    // 宽度 20 → 每边最多缩 (20-8)/2 = 6px
    expect(geometry.crop).toEqual({ x: 26, y: 20, width: 8, height: 14 })
  })

  it('inset=0 时保持旧口径（不内缩）', () => {
    const geometry = computeCaptureGeometry(
      { x: 100, y: 80, width: 1375, height: 1000 },
      primary,
      { width: 1920, height: 1080 },
      0
    )
    expect(geometry.crop).toEqual({ x: 100, y: 80, width: 1375, height: 1000 })
  })

  it('证据图口径（upscale 1 + 封顶 1920）：裁剪区不变，输出不放大', () => {
    const geometry = computeCaptureGeometry(
      { x: 100, y: 80, width: 1375, height: 1000 },
      primary,
      { width: 1920, height: 1080 },
      undefined,
      { upscale: 1, maxWidth: 1920 }
    )
    // 裁剪区与 OCR 口径一致；只有输出尺寸不同（1359 宽 < 1920，所以保持原生 1359×992）
    expect(geometry.crop).toEqual({ x: 108, y: 80, width: 1359, height: 992 })
    expect(geometry.target).toEqual({ width: 1359, height: 992 })
  })

  it('证据图口径下超宽窗口缩到 1920（不放大）', () => {
    const geometry = computeCaptureGeometry(
      { x: -9, y: -9, width: 1938, height: 1038 },
      primary,
      { width: 1920, height: 1080 },
      undefined,
      { upscale: 1, maxWidth: 1920 }
    )
    expect(geometry.crop).toEqual({ x: 0, y: 0, width: 1920, height: 1021 })
    expect(geometry.target).toEqual({ width: 1920, height: 1021 })
  })

  it('窗口几乎整块在屏幕外时抛错（不回退整帧，避免把整屏送进 OCR）', () => {
    expect(() =>
      computeCaptureGeometry({ x: 1916, y: 1076, width: 10, height: 10 }, primary, {
        width: 1920,
        height: 1080
      })
    ).toThrow(RangeError)
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
