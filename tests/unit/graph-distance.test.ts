import { describe, expect, it } from 'vitest'
import { distanceFromSim } from '../../src/renderer/foam/lib/distance'

describe('distanceFromSim（方案 §6.2）', () => {
  it('相似度 = 阈值时最远，= 1 时最近', () => {
    expect(distanceFromSim(0.64, 0.64, 18, 140)).toBe(140)
    expect(distanceFromSim(1, 0.64, 18, 140)).toBe(18)
  })

  it('相似度越高距离越近（单调）', () => {
    const values = [0.64, 0.7, 0.8, 0.9, 1].map(sim => distanceFromSim(sim, 0.64, 18, 140))
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeLessThan(values[i - 1])
    }
  })

  it('越界输入夹取，非法输入按最远处理', () => {
    expect(distanceFromSim(-1, 0.64, 18, 140)).toBe(140)
    expect(distanceFromSim(2, 0.64, 18, 140)).toBe(18)
    expect(distanceFromSim(Number.NaN, 0.64, 18, 140)).toBe(140)
  })

  it('阈值 ≥ 1 时退化为常数最远距离，不产生除零', () => {
    expect(distanceFromSim(0.9, 1, 18, 140)).toBe(140)
    expect(distanceFromSim(0.9, 1.2, 18, 140)).toBe(140)
  })

  it('中点位于两端之间', () => {
    const mid = distanceFromSim((0.64 + 1) / 2, 0.64, 18, 140)
    expect(mid).toBeGreaterThan(18)
    expect(mid).toBeLessThan(140)
  })
})
