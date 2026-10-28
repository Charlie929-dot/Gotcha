import { describe, expect, it } from 'vitest'
import { MIN_SELECTION_DIP, normalizeSelection, selectionToFrameCrop } from '../../src/capture/full-frame'

describe('selectionToFrameCrop：选区（DIP）→ 帧像素', () => {
  const display = { width: 1920, height: 1080 }

  it('同尺寸（1× DPI）原样取整', () => {
    expect(
      selectionToFrameCrop({ x: 10, y: 20, width: 300, height: 200 }, display, display)
    ).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })

  it('2× DPI：帧是物理像素，坐标乘 2', () => {
    expect(
      selectionToFrameCrop(
        { x: 100, y: 50, width: 200, height: 100 },
        display,
        { width: 3840, height: 2160 }
      )
    ).toEqual({ x: 200, y: 100, width: 400, height: 200 })
  })

  it('拖出屏幕的选区夹回帧内', () => {
    expect(
      selectionToFrameCrop({ x: 1800, y: 1000, width: 400, height: 300 }, display, display)
    ).toEqual({ x: 1800, y: 1000, width: 120, height: 80 })
  })

  it('太小（< 8 DIP）返回 null', () => {
    expect(
      selectionToFrameCrop({ x: 0, y: 0, width: MIN_SELECTION_DIP - 1, height: 100 }, display, display)
    ).toBeNull()
  })

  it('负坐标夹到 0', () => {
    expect(
      selectionToFrameCrop({ x: -20, y: -10, width: 100, height: 100 }, display, display)
    ).toEqual({ x: 0, y: 0, width: 80, height: 90 })
  })

  it('非法尺寸 / 零尺寸显示器返回 null', () => {
    expect(selectionToFrameCrop({ x: 0, y: 0, width: Number.NaN, height: 10 }, display, display)).toBeNull()
    expect(selectionToFrameCrop({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, display)).toBeNull()
    expect(selectionToFrameCrop({ x: 0, y: 0, width: 10, height: 10 }, display, { width: 0, height: 0 })).toBeNull()
  })
})

describe('normalizeSelection：反向拖动', () => {
  it('从右下往左上拖也得到左上角 + 正尺寸', () => {
    expect(normalizeSelection({ x: 300, y: 200 }, { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150
    })
  })

  it('零距离得零尺寸（由调用方按太小处理）', () => {
    expect(normalizeSelection({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0
    })
  })
})
