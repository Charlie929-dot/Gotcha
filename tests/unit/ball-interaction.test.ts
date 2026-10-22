/**
 * 悬浮球交互状态机单测（D16）
 *
 * 覆盖：停靠热区展开、安全区（窗口内）不收起、离开宽限、拖动优先、兜底强制缩回、
 * 自由位不展开。纯函数，不依赖 DOM。
 */

import { describe, expect, it } from 'vitest'
import {
  BALL_GRACE_MS,
  BALL_HIT_RADIUS,
  BALL_HOT_RADIUS,
  initialSnapshot,
  isExpanded,
  reduceInteraction,
  type BallInteractionSnapshot
} from '../../src/renderer/ball/ball-interaction'

const docked = (distance: number) => ({ docked: true, distance })
const free = (distance: number) => ({ docked: false, distance })

function run(
  events: Parameters<typeof reduceInteraction>[1][],
  start: BallInteractionSnapshot = initialSnapshot()
): BallInteractionSnapshot {
  return events.reduce((snapshot, event) => reduceInteraction(snapshot, event), start)
}

describe('停靠展开入口（热区 24 + 8px 容差）', () => {
  it('缩入态指针进入可见半球 → 展开，且不靠距离收起', () => {
    const expanded = run([{ type: 'pointer-move', geometry: docked(BALL_HIT_RADIUS - 1) }])
    expect(expanded.state).toBe('expanded')
    expect(expanded.pointerInside).toBe(true)

    // 热区外圈（24–32px）只触发展开，不算球体命中
    const edge = run([{ type: 'pointer-move', geometry: docked(BALL_HOT_RADIUS - 1) }])
    expect(edge.state).toBe('expanded')
    expect(edge.pointerInside).toBe(false)

    // 展开后指针在窗口内移动（即使离球心 > 旧收拢阈值 40）：仍保持展开
    const stay = run([{ type: 'pointer-move', geometry: docked(45) }], expanded)
    expect(stay.state).toBe('expanded')

    expect(BALL_GRACE_MS).toBe(600)
  })

  it('热区外不展开', () => {
    const snapshot = run([{ type: 'pointer-move', geometry: docked(BALL_HOT_RADIUS + 1) }])
    expect(snapshot.state).toBe('idle')
    expect(snapshot.pointerInside).toBe(false)
  })

  it('自由位不展开，只更新球体命中', () => {
    expect(run([{ type: 'pointer-move', geometry: free(10) }])).toEqual({
      state: 'idle',
      pointerInside: true
    })
    expect(run([{ type: 'pointer-move', geometry: free(30) }])).toEqual({
      state: 'idle',
      pointerInside: false
    })
  })
})

describe('离开宽限（grace）', () => {
  const expanded = run([{ type: 'pointer-move', geometry: docked(10) }])

  it('展开后指针离开窗口 → 进入宽限，仍全显', () => {
    const grace = run([{ type: 'pointer-leave' }], expanded)
    expect(grace.state).toBe('grace')
    expect(isExpanded(grace)).toBe(true)
    expect(grace.pointerInside).toBe(false)
  })

  it('宽限内回到窗口 → 取消缩回', () => {
    const grace = run([{ type: 'pointer-leave' }], expanded)
    expect(run([{ type: 'pointer-move', geometry: docked(30) }], grace).state).toBe('expanded')
  })

  it('宽限到期 → 缩回；非宽限态的 grace-expired 不生效', () => {
    const grace = run([{ type: 'pointer-leave' }], expanded)
    expect(run([{ type: 'grace-expired' }], grace)).toEqual({
      state: 'idle',
      pointerInside: false
    })
    expect(run([{ type: 'grace-expired' }], expanded).state).toBe('expanded')
  })

  it('缩入态离开窗口不会进入宽限', () => {
    expect(run([{ type: 'pointer-leave' }])).toEqual({ state: 'idle', pointerInside: false })
  })
})

describe('拖动', () => {
  it('按下命中球体才进入拖动；拖动中忽略离开与宽限到期', () => {
    const idle = initialSnapshot()
    expect(run([{ type: 'pointer-down', geometry: docked(BALL_HIT_RADIUS + 1) }], idle).state).toBe(
      'idle'
    )

    const dragging = run([{ type: 'pointer-down', geometry: docked(10) }], idle)
    expect(dragging).toEqual({ state: 'dragging', pointerInside: true })
    expect(run([{ type: 'pointer-leave' }], dragging).state).toBe('dragging')
    expect(run([{ type: 'grace-expired' }], dragging).state).toBe('dragging')
    expect(run([{ type: 'pointer-move', geometry: docked(50) }], dragging).state).toBe('dragging')
  })

  it('松手：停靠态保持展开（等 placement），自由位回到常态；取消则缩回', () => {
    const dragging = run([{ type: 'pointer-down', geometry: docked(10) }])
    expect(run([{ type: 'pointer-up', docked: true }], dragging).state).toBe('expanded')
    expect(run([{ type: 'pointer-up', docked: false }], dragging).state).toBe('idle')
    expect(run([{ type: 'pointer-cancel' }], dragging)).toEqual({
      state: 'idle',
      pointerInside: false
    })
  })
})

describe('落位与兜底', () => {
  it('placement 重置为缩入 / 常态', () => {
    const expanded = run([{ type: 'pointer-move', geometry: docked(10) }])
    expect(run([{ type: 'placement', docked: true }], expanded)).toEqual({
      state: 'idle',
      pointerInside: false
    })
  })

  it('强制缩回只作用于展开 / 宽限', () => {
    const expanded = run([{ type: 'pointer-move', geometry: docked(10) }])
    expect(run([{ type: 'force-retract' }], expanded)).toEqual({
      state: 'idle',
      pointerInside: false
    })

    const grace = run([{ type: 'pointer-leave' }], expanded)
    expect(run([{ type: 'force-retract' }], grace).state).toBe('idle')

    expect(run([{ type: 'force-retract' }]).state).toBe('idle')
    const dragging = run([{ type: 'pointer-down', geometry: docked(10) }])
    expect(run([{ type: 'force-retract' }], dragging).state).toBe('dragging')
  })
})
