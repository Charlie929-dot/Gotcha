/**
 * 生命阶段（D99）：剩余百分比 → 阶段词的边界。
 *
 * 只测纯映射，不碰 `<now>` / `/life`（那两个在 chain-agent-life / main-commands 里验）。
 */

import { describe, expect, it } from 'vitest'

import { lifeStageOf } from '../../src/chain/agent/life-stage'

describe('生命阶段', () => {
  it('按剩余百分比分四段：>95 宝宝 / 86–95 少女 / 16–85 准妈妈 / ≤15 快要离开', () => {
    expect(lifeStageOf(100)).toBe('宝宝')
    expect(lifeStageOf(96)).toBe('宝宝')
    expect(lifeStageOf(95)).toBe('少女')
    expect(lifeStageOf(86)).toBe('少女')
    expect(lifeStageOf(85)).toBe('准妈妈')
    expect(lifeStageOf(16)).toBe('准妈妈')
    expect(lifeStageOf(15)).toBe('快要离开')
    expect(lifeStageOf(0)).toBe('快要离开')
  })

  it('越界 / 坏值先夹回 0–100 再判', () => {
    expect(lifeStageOf(-10)).toBe('快要离开')
    expect(lifeStageOf(150)).toBe('宝宝')
    expect(lifeStageOf(Number.NaN)).toBe('快要离开')
  })
})
