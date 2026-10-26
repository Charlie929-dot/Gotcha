import { describe, expect, it } from 'vitest'
import { ChainSegmenter, DEFAULT_SEGMENTER_OPTIONS, type ChainAction, type ChainInput } from '../../src/chain/segmenter'

const T0 = 1_760_000_000_000
const at = (seconds: number): number => T0 + seconds * 1000

function focus(seconds: number, pid: number, title: string, hwnd = pid * 10): ChainInput {
  return { kind: 'focus', ts: at(seconds), pid, exe: `app${pid}`, title, hwnd }
}
function tick(seconds: number): ChainInput {
  return { kind: 'tick', ts: at(seconds) }
}
function activity(seconds: number): ChainInput {
  return { kind: 'activity', ts: at(seconds) }
}
function click(seconds: number): ChainInput {
  return { kind: 'click', ts: at(seconds), button: 'left', x: 10, y: 10 }
}
function wheel(seconds: number): ChainInput {
  return { kind: 'wheel', ts: at(seconds), delta: 120, x: 10, y: 10 }
}
function move(seconds: number, x: number, y = 0): ChainInput {
  return { kind: 'move', ts: at(seconds), x, y }
}

function closed(actions: ChainAction[]): Array<Extract<ChainAction, { type: 'segment-closed' }>> {
  return actions.filter((action): action is Extract<ChainAction, { type: 'segment-closed' }> => action.type === 'segment-closed')
}
type EventAction = Extract<ChainAction, { type: 'event' }>
function events(actions: ChainAction[]): EventAction[] {
  return actions.filter((action): action is EventAction => action.type === 'event')
}
/** 真正会截图的那些事件 */
function shots(actions: ChainAction[]): EventAction[] {
  return events(actions).filter((action) => action.capture)
}
function opened(actions: ChainAction[]): Array<Extract<ChainAction, { type: 'segment-opened' }>> {
  return actions.filter((action): action is Extract<ChainAction, { type: 'segment-opened' }> => action.type === 'segment-opened')
}
function feedAll(segmenter: ChainSegmenter, inputs: ChainInput[]): ChainAction[] {
  return inputs.flatMap((input) => segmenter.feed(input))
}

describe('段的基本切分', () => {
  it('切到别的窗口就关段开新段，并各拍一张入场帧', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), focus(30, 2, 'B')])
    const segments = closed(actions)
    expect(segments).toHaveLength(1)
    expect(segments[0].segment).toMatchObject({ startTs: at(0), endTs: at(30), activeMs: 30_000, idleMs: 0 })
    expect(segments[0].reason).toBe('switch')
    expect(shots(actions).map((action) => action.kind)).toEqual(['enter', 'enter'])
    // 开段要在事件之前上报，子行才能立刻拿到 segment_id
    expect(opened(actions).map((action) => action.segment.title)).toEqual(['A', 'B'])
    expect(actions.findIndex((action) => action.type === 'segment-opened')).toBeLessThan(
      actions.findIndex((action) => action.type === 'event')
    )
  })

  it('同一窗口重复报焦点不切段', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), focus(10, 1, 'A'), focus(20, 1, 'A')])
    expect(closed(actions)).toHaveLength(0)
  })

  it('flush 把开着的段收口，原因为 stop', () => {
    const segmenter = new ChainSegmenter()
    feedAll(segmenter, [focus(0, 1, 'A')])
    const actions = segmenter.flush(at(15))
    const segments = closed(actions)
    expect(segments).toHaveLength(1)
    expect(segments[0].reason).toBe('stop')
    expect(segments[0].segment.activeMs).toBe(15_000)
  })
})

describe('标题抖动抑制', () => {
  it('1 秒内变回原值不切段', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [
      focus(0, 1, 'A'),
      focus(1, 1, 'A — 加载中'),
      focus(1.3, 1, 'A'),
      tick(10)
    ])
    expect(closed(actions)).toHaveLength(0)
  })

  it('抖动窗口过去后确认切换：段在标题变化那一刻收口', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), focus(10, 1, 'B'), tick(14)])
    const segments = closed(actions)
    expect(segments).toHaveLength(1)
    expect(segments[0].segment).toMatchObject({ endTs: at(10), titleFirst: 'A', titleLast: 'A' })
    expect(segmenter.openSegment?.titleFirst).toBe('B')
  })
})

describe('空闲与停采', () => {
  it('60s 没输入就报空闲开始，段在空闲起点收口', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), tick(61)])
    expect(actions.some((action) => action.type === 'idle-start' && action.at === at(60))).toBe(true)
    expect(segmenter.isIdle).toBe(true)
  })

  it('走开 3 分钟后回到同一窗口：接续成一段，空闲不计入占用时长', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), tick(61), focus(240, 1, 'A'), tick(300)])
    const segments = closed(segmenter.flush(at(300)))
    expect(segments).toHaveLength(1)
    const segment = segments[0].segment
    expect(segment.startTs).toBe(at(0))
    expect(segment.idleMs).toBe(at(240) - at(60))
    expect(segment.activeMs).toBe(segment.endTs - segment.startTs - segment.idleMs)
    expect(actions.some((action) => action.type === 'idle-end')).toBe(true)
  })

  it('走开超过接续上限就另起一段', () => {
    const segmenter = new ChainSegmenter({ mergeIdleCapMs: 60_000 })
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), tick(61), tick(130), focus(200, 1, 'A')])
    const segments = closed(actions)
    expect(segments).toHaveLength(1)
    expect(segments[0].reason).toBe('idle')
    expect(segments[0].segment.endTs).toBe(at(60))
  })

  it('走开后切到别的窗口：旧段收口，新段另起', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), tick(61), focus(100, 2, 'B')])
    const segments = closed(actions)
    expect(segments).toHaveLength(1)
    expect(segments[0].reason).toBe('switch')
  })
})

describe('截图触发（v0.11：从静默里发起的动作才拍）', () => {
  it('点击从 2s 静默里发起才拍；紧接着的连点不拍（事件照记）', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), click(5), click(5.5), click(6)])
    expect(shots(actions).map((shot) => shot.kind)).toEqual(['enter', 'click_left'])
    // 事件本身一个都不丢（锚点）
    expect(events(actions).filter((event) => event.kind.startsWith('click'))).toHaveLength(3)
  })

  it('滚轮停 2s 才拍「滚动结果」；滚动中不出图', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), wheel(5), wheel(5.3), tick(6)])
    expect(shots(actions).map((shot) => shot.kind)).toEqual(['enter'])
    // 距最后一次滚动 2s 整：这一拍交出去
    const later = feedAll(segmenter, [tick(7.3)])
    expect(shots(later).map((shot) => shot.kind)).toEqual(['wheel'])
    expect(shots(later)[0].delta).toBe(240)
  })

  it('滚动中点了鼠标：滚轮那张作废，事件都照记', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), wheel(5), click(5.5)])
    expect(events(actions).map((event) => event.kind)).toEqual(['enter', 'wheel', 'click_left'])
    // 点击距上一输入 0.5s，不满足 2s 静默 → 不拍
    expect(shots(actions).map((shot) => shot.kind)).toEqual(['enter'])
  })

  it('事件带上坐标与滚轮格数', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), click(5), wheel(10), tick(12.1)])
    const [enter, clicked, scrolled] = events(actions)
    expect(enter).toMatchObject({ kind: 'enter', x: null, y: null, delta: null })
    expect(clicked).toMatchObject({ kind: 'click_left', x: 10, y: 10, delta: null })
    expect(scrolled).toMatchObject({ kind: 'wheel', x: 10, y: 10, delta: 120 })
  })

  it('移动后暂停只记事件，永不截图', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), move(2, 0), move(2.1, 100), tick(3)])
    expect(events(actions).map((event) => event.kind)).toEqual(['enter', 'move_pause'])
    expect(shots(actions).map((shot) => shot.kind)).toEqual(['enter'])
  })

  it('只挪几像素不算（也不截图）', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), move(2, 0), move(2.1, 5), tick(3)])
    expect(events(actions)).toHaveLength(1)
    expect(shots(actions)).toHaveLength(1)
  })
})

describe('打字与截图（v0.11：打字只在被打断时拍）', () => {
  it('持续打字、停 3 秒：只补 typing 事件，不截图', () => {
    const segmenter = new ChainSegmenter()
    const typing = Array.from({ length: 20 }, (_, index) => activity(1 + index * 0.5))
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), ...typing, tick(11), tick(13.5)])
    expect(events(actions).some((event) => event.kind === 'typing')).toBe(true)
    expect(shots(actions).map((shot) => shot.kind)).toEqual(['enter'])
  })

  it('打字被点击打断：立刻拍一张（保住刚敲进去的内容）', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), activity(5), activity(5.4), click(5.6)])
    expect(shots(actions).map((shot) => shot.kind)).toEqual(['enter', 'click_left'])
  })

  it('打断也守 2s 最小间隔（离入场帧太近就不拍）', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [
      focus(1, 1, 'A'),
      activity(1.2),
      click(1.4),
      activity(1.6),
      click(1.8)
    ])
    expect(shots(actions).map((shot) => shot.kind)).toEqual(['enter'])
  })
})

describe('默认值', () => {
  it('空闲 60s、接续上限 30 分钟、打字停顿 3s、冷却 2s、滚轮 2s 后拍', () => {
    expect(DEFAULT_SEGMENTER_OPTIONS).toMatchObject({
      idleMs: 60_000,
      mergeIdleCapMs: 30 * 60_000,
      titleFlapMs: 3_000,
      typingSettleMs: 3_000,
      captureCooldownMs: 2_000,
      wheelCaptureDelayMs: 2_000
    })
  })
})
