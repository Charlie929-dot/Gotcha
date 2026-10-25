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
function captures(actions: ChainAction[]): Array<Extract<ChainAction, { type: 'capture' }>> {
  return actions.filter((action): action is Extract<ChainAction, { type: 'capture' }> => action.type === 'capture')
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
    expect(captures(actions).map((action) => action.source)).toEqual(['enter', 'enter'])
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

describe('截图触发', () => {
  it('点击与滚轮各触发一次，冷却期内不重复', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), click(5), click(5.5), wheel(10)])
    const shots = captures(actions)
    expect(shots.map((shot) => shot.eventKind)).toEqual(['enter', 'click_left', 'wheel'])
  })

  it('移动一段距离后停下算一次', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), move(2, 0), move(2.1, 100), tick(3)])
    expect(captures(actions).map((shot) => shot.eventKind)).toEqual(['enter', 'move_pause'])
  })

  it('只挪几像素不算', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), move(2, 0), move(2.1, 5), tick(3)])
    expect(captures(actions)).toHaveLength(1)
  })
})

describe('打字停顿补采', () => {
  it('持续打字不截图，停顿满 3 秒补一张', () => {
    const segmenter = new ChainSegmenter()
    // 每 0.5s 一次输入，持续 10 秒
    const typing = Array.from({ length: 20 }, (_, index) => activity(1 + index * 0.5))
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), ...typing, tick(11), tick(13.5)])
    const shots = captures(actions)
    // 入场一张 + 停顿后一张
    expect(shots.map((shot) => shot.source)).toEqual(['enter', 'typing'])
  })

  it('停顿后又继续输入，就重新倒计时', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [
      focus(0, 1, 'A'),
      activity(1),
      tick(1.5), // 还没到 3s
      activity(3.5), // 重新计时
      tick(4),
      tick(6.4), // 距 activity(3.5) 才 2.9s
      tick(6.6) // 满 3s
    ])
    const shots = captures(actions)
    expect(shots.map((shot) => shot.source)).toEqual(['enter', 'typing'])
    expect(shots[1].at).toBe(at(6.5))
  })

  it('打字补采也不会突破截图冷却', () => {
    const segmenter = new ChainSegmenter()
    const actions = feedAll(segmenter, [focus(0, 1, 'A'), click(1), activity(1.2), tick(4.3), tick(4.5)])
    const shots = captures(actions)
    // 点击在 1s，打字停顿在 4.2s——冷却已过，两张都在
    expect(shots).toHaveLength(2)
  })
})

describe('默认值', () => {
  it('空闲 60s、接续上限 30 分钟、打字停顿 3s、冷却 2s', () => {
    expect(DEFAULT_SEGMENTER_OPTIONS).toMatchObject({
      idleMs: 60_000,
      mergeIdleCapMs: 30 * 60_000,
      titleFlapMs: 3_000,
      typingSettleMs: 3_000,
      captureCooldownMs: 2_000
    })
  })
})
