import { describe, expect, it } from 'vitest'
import { dHash, hammingDistance, rgbaToGray, resizeGray } from '../../src/capture/frame-diff'

const W = 90
const H = 80

/** 10x10 棋盘块：便于精确预期的合成图 */
function checkerboard(inverted = false): Uint8Array {
  const gray = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cell = (Math.floor(x / 10) + Math.floor(y / 10)) % 2
      gray[y * W + x] = (cell === 1) !== inverted ? 255 : 0
    }
  }
  return gray
}

/** 确定性伪随机噪声（避免测试抖动） */
function noise(seed: number): Uint8Array {
  const gray = new Uint8Array(W * H)
  let state = seed
  for (let i = 0; i < gray.length; i++) {
    state = (state * 1664525 + 1013904223) % 4294967296
    gray[i] = state % 256
  }
  return gray
}

describe('dHash · 帧差指纹', () => {
  it('同一张图距离为 0', () => {
    const a = dHash(checkerboard(), W, H)
    const b = dHash(checkerboard(), W, H)
    expect(hammingDistance(a, b)).toBe(0)
  })

  it('微改（翻转一个 10x10 块）距离很小', () => {
    const base = checkerboard()
    const edited = Uint8Array.from(base)
    for (let y = 40; y < 50; y++) {
      for (let x = 40; x < 50; x++) {
        edited[y * W + x] = 255 - edited[y * W + x]
      }
    }
    const distance = hammingDistance(dHash(base, W, H), dHash(edited, W, H))
    expect(distance).toBeGreaterThan(0)
    expect(distance).toBeLessThanOrEqual(16)
  })

  it('换图（噪声 vs 棋盘）距离大', () => {
    const distance = hammingDistance(dHash(checkerboard(), W, H), dHash(noise(42), W, H))
    expect(distance).toBeGreaterThan(20)
  })

  it('同图案不同分辨率（等比放大）指纹一致', () => {
    const small = new Uint8Array(90 * 80)
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 90; x++) {
        small[y * 90 + x] = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 1 ? 255 : 0
      }
    }
    const big = new Uint8Array(180 * 160)
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 180; x++) {
        big[y * 180 + x] = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 1 ? 255 : 0
      }
    }
    expect(hammingDistance(dHash(small, 90, 80), dHash(big, 180, 160))).toBe(0)
  })

  it('缓冲区小于声明尺寸时抛错，不得静默返回同值指纹（真机回归）', () => {
    // 曾经的真实 bug：截图层把 OCR 图尺寸（如 1280x1029）传给 dHash，而灰度只有 90x80，
    // 越界读到 undefined → 所有帧指纹相同 → 帧差永不触发（34 分钟只入 1 条事件）
    expect(() => dHash(new Uint8Array(W * H), 1280, 1029)).toThrow(RangeError)
    expect(() => dHash(new Uint8Array(W * H), 1280, 1029)).toThrow(/缓冲区不足/)
    expect(() => dHash(new Uint8Array(W * H), 0, 80)).toThrow(RangeError)
  })
})

describe('灰度与缩放', () => {
  it('RGBA → 灰度按亮度权重', () => {
    const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255])
    const gray = rgbaToGray(rgba, 2, 1)
    expect(Array.from(gray)).toEqual([255, 0])
  })

  it('最近邻降采样保持块状特征', () => {
    const gray = new Uint8Array(10 * 10)
    gray.fill(0)
    for (let i = 0; i < 5; i++) gray[i] = 255 // 第一行左半
    const resized = resizeGray(gray, 10, 10, 2, 2)
    expect(resized[0]).toBe(255)
    expect(resized[1]).toBe(0)
  })
})
