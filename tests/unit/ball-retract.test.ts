/**
 * 主进程自动缩回兜底判定单测（D16）
 *
 * 覆盖：安全区（窗口 + 8px）边界、离开计时、宽限内不缩回、到点强制缩回、
 * 重新进入重置计时、只在展开 / 宽限态生效。
 */

import { describe, expect, it } from 'vitest'
import {
  BALL_RETRACT_GRACE_MS,
  BALL_RETRACT_FALLBACK_MARGIN_MS,
  BALL_SAFE_MARGIN,
  decideRetract,
  isPointInSafeArea,
  type BallRetractInput
} from '../../src/main/ball-retract'

const bounds = { x: 100, y: 200, width: 64, height: 64 }
const inside = { x: 130, y: 230 }

function input(overrides: Partial<BallRetractInput> = {}): BallRetractInput {
  return {
    state: 'expanded',
    cursor: inside,
    bounds,
    outsideSince: null,
    now: 1_000,
    ...overrides
  }
}

describe('安全区判定', () => {
  it('窗口内与 8px 容差内算安全，超出算离开', () => {
    expect(isPointInSafeArea({ x: 100, y: 200 }, bounds)).toBe(true)
    expect(isPointInSafeArea({ x: 92, y: 192 }, bounds)).toBe(true)
    expect(isPointInSafeArea({ x: 91, y: 192 }, bounds)).toBe(false)
    expect(isPointInSafeArea({ x: 164 + BALL_SAFE_MARGIN, y: 264 }, bounds)).toBe(true)
    expect(isPointInSafeArea({ x: 164 + BALL_SAFE_MARGIN + 1, y: 264 }, bounds)).toBe(false)
  })
})

describe('兜底判定', () => {
  const deadline = BALL_RETRACT_GRACE_MS + BALL_RETRACT_FALLBACK_MARGIN_MS

  it('指针在安全区内不缩回，并清空离开计时', () => {
    expect(decideRetract(input({ outsideSince: 500 }))).toEqual({
      outsideSince: null,
      forceRetract: false
    })
  })

  it('离开安全区后开始计时，未到点不缩回', () => {
    const first = decideRetract(input({ cursor: { x: 0, y: 0 }, now: 1_000 }))
    expect(first).toEqual({ outsideSince: 1_000, forceRetract: false })

    const nearly = decideRetract(
      input({ cursor: { x: 0, y: 0 }, outsideSince: 1_000, now: 1_000 + deadline - 1 })
    )
    expect(nearly.forceRetract).toBe(false)
  })

  it('离开达到宽限 + 余量后强制缩回', () => {
    expect(
      decideRetract(input({ cursor: { x: 0, y: 0 }, outsideSince: 1_000, now: 1_000 + deadline }))
        .forceRetract
    ).toBe(true)
  })

  it('离开途中回到安全区会重置计时', () => {
    const back = decideRetract(input({ outsideSince: 1_000, now: 1_500 }))
    expect(back.outsideSince).toBeNull()

    const again = decideRetract(input({ cursor: { x: 0, y: 0 }, now: 2_000 }))
    expect(again.outsideSince).toBe(2_000)
  })

  it('只有展开 / 宽限态需要兜底；缩入与拖动不触发', () => {
    for (const state of ['idle', 'dragging'] as const) {
      expect(decideRetract(input({ state, cursor: { x: 0, y: 0 }, outsideSince: 1_000 }))).toEqual({
        outsideSince: null,
        forceRetract: false
      })
    }
    expect(
      decideRetract(
        input({ state: 'grace', cursor: { x: 0, y: 0 }, outsideSince: 1_000, now: 1_000 + deadline })
      ).forceRetract
    ).toBe(true)
  })
})
