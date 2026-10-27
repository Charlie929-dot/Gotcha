import { describe, expect, it } from 'vitest'
import { DesktopEventAdapter, DEFAULT_ADAPTER_OPTIONS } from '../../src/chain/hook/adapter'
import type { DesktopEventSource, RawDesktopEvent } from '../../src/chain/hook/types'

const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const at = (seconds: number): number => T0 + seconds * 1000

/** 假系统源：tick 由测试推进 */
class FakeSource implements DesktopEventSource {
  tick = 1_000
  started = 0
  stopped = 0
  start(): void {
    this.started += 1
  }
  stop(): void {
    this.stopped += 1
  }
  lastInputTickMs(): number {
    return this.tick
  }
}

function foreground(seconds: number, title = 'A', pid = 100): RawDesktopEvent {
  return { type: 'foreground', ts: at(seconds), pid, hwnd: pid * 10, exe: `app${pid}`, title, app: `App${pid}` }
}
function wheel(seconds: number, delta = 120): RawDesktopEvent {
  return { type: 'wheel', ts: at(seconds), delta, x: 10, y: 20 }
}
function click(seconds: number): RawDesktopEvent {
  return { type: 'click', ts: at(seconds), x: 10, y: 20, button: 'left' }
}
function move(seconds: number, x: number, y = 0): RawDesktopEvent {
  return { type: 'move', ts: at(seconds), x, y }
}

function build() {
  const source = new FakeSource()
  const adapter = new DesktopEventAdapter(source, { now: () => at(0) })
  const feed = (event: RawDesktopEvent) => adapter.handle(event)
  return { source, adapter, feed }
}

describe('原始事件 → 段机输入', () => {
  it('前台 / 点击 / 移动各转成对应输入', () => {
    const { feed } = build()
    expect(feed(foreground(0))).toEqual([
      { kind: 'focus', ts: at(0), pid: 100, hwnd: 1_000, exe: 'app100', title: 'A', app: 'App100' }
    ])
    expect(feed(click(5))).toEqual([{ kind: 'click', ts: at(5), button: 'left', x: 10, y: 20 }])
    expect(feed(move(6, 30, 40))).toEqual([{ kind: 'move', ts: at(6), x: 30, y: 40 }])
  })

  it('同一次滑动里的滚轮累加成一条（ts 取起点、delta 取总和）', () => {
    const { feed, adapter } = build()
    expect(feed(wheel(1, 120))).toEqual([])
    expect(feed(wheel(1.1, 120))).toEqual([])
    expect(feed(wheel(1.2, -40))).toEqual([])
    // 手势停了（>500ms 没有新的滚轮）心跳才交出去
    expect(adapter.pulse(at(1.5)).filter((input) => input.kind === 'wheel')).toEqual([])
    const inputs = adapter.pulse(at(1.8))
    expect(inputs[0]).toEqual({ kind: 'wheel', ts: at(1), delta: 200, x: 10, y: 20 })
  })

  it('间隔超过手势窗口就是新手势', () => {
    const { feed, adapter } = build()
    feed(wheel(1, 100))
    const second = feed(wheel(2, 100)) // 1s 之后
    expect(second).toEqual([{ kind: 'wheel', ts: at(1), delta: 100, x: 10, y: 20 }])
    expect(adapter.flush()).toEqual([{ kind: 'wheel', ts: at(2), delta: 100, x: 10, y: 20 }])
  })

  it('滚轮之后紧接点击：先交手势再交点击，顺序不乱', () => {
    const { feed } = build()
    feed(wheel(1, 120))
    const inputs = feed(click(1.1))
    expect(inputs.map((input) => input.kind)).toEqual(['wheel', 'click'])
    expect(inputs[1]).toMatchObject({ kind: 'click', ts: at(1.1) })
  })

  it('切窗口也会先交出挂起的滚轮', () => {
    const { feed } = build()
    feed(wheel(1, 120))
    const inputs = feed(foreground(1.05, 'B', 200))
    expect(inputs.map((input) => input.kind)).toEqual(['wheel', 'focus'])
  })

  it('移动不打断滚轮手势', () => {
    const { feed, adapter } = build()
    feed(wheel(1, 120))
    expect(feed(move(1.05, 500))).toHaveLength(1) // 只有 move，滚轮还在攒
    expect(adapter.flush()).toHaveLength(1)
  })
})

describe('键盘活动识别（不装键盘钩子）', () => {
  it('tick 前进了、这段时间没有鼠标事件 → 是键盘', () => {
    const { adapter, source } = build()
    adapter.pulse(at(1)) // 记下初始 tick
    source.tick += 500
    const inputs = adapter.pulse(at(2))
    expect(inputs).toContainEqual({ kind: 'activity', ts: at(2) })
  })

  it('tick 前进了但有鼠标事件 → 不报键盘（避免「点一下就以为在打字」）', () => {
    const { adapter, source, feed } = build()
    adapter.pulse(at(1))
    source.tick += 500
    feed(click(1.5))
    const inputs = adapter.pulse(at(2))
    expect(inputs.some((input) => input.kind === 'activity')).toBe(false)
  })

  it('tick 没动就不报键盘', () => {
    const { adapter } = build()
    adapter.pulse(at(1))
    const inputs = adapter.pulse(at(2))
    expect(inputs.some((input) => input.kind === 'activity')).toBe(false)
  })

  it('键盘判定会重置：连着两次都能识别', () => {
    const { adapter, source } = build()
    adapter.pulse(at(1))
    source.tick += 100
    expect(adapter.pulse(at(2)).some((input) => input.kind === 'activity')).toBe(true)
    source.tick += 100
    expect(adapter.pulse(at(3)).some((input) => input.kind === 'activity')).toBe(true)
  })
})

describe('时钟推进', () => {
  it('按心跳间隔喂 tick（没有事件也要推，否则判不出空闲）', () => {
    const { adapter } = build()
    const first = adapter.pulse(at(0))
    expect(first.at(-1)).toEqual({ kind: 'tick', ts: at(0) })
    expect(adapter.pulse(at(0.4))).toEqual([])
    expect(adapter.pulse(at(1)).at(-1)).toEqual({ kind: 'tick', ts: at(1) })
  })

  it('默认值：手势窗口 500ms、心跳 1s', () => {
    expect(DEFAULT_ADAPTER_OPTIONS).toMatchObject({ wheelGestureMs: 500, tickIntervalMs: 1_000 })
  })
})

describe('点哪算哪（v0.13：段身份跟着你做动作的那扇窗）', () => {
  const TARGET = {
    pid: 200,
    hwnd: 2_000,
    exe: 'firefox',
    title: '真实在用的窗',
    app: 'Firefox',
    visible: true,
    minimized: false,
    onScreenArea: 500_000,
    className: 'MozillaWindowClass'
  }

  function buildResolvable(resolve: (x: number, y: number) => typeof TARGET | null = () => TARGET) {
    const source = new FakeSource()
    const calls: Array<[number, number]> = []
    const adapter = new DesktopEventAdapter(source, {
      now: () => at(0),
      resolveWindow: (x, y) => {
        calls.push([x, y])
        return resolve(x, y)
      }
    })
    return { adapter, calls }
  }

  it('点击先补一条「被点中的窗」的焦点，再报点击本身', () => {
    const { adapter, calls } = buildResolvable()
    expect(adapter.handle(click(5))).toEqual([
      {
        kind: 'focus',
        ts: at(5),
        pid: 200,
        hwnd: 2_000,
        exe: 'firefox',
        title: '真实在用的窗',
        app: 'Firefox',
        visible: true,
        minimized: false,
        onScreenArea: 500_000,
        className: 'MozillaWindowClass'
      },
      { kind: 'click', ts: at(5), button: 'left', x: 10, y: 20 }
    ])
    // 用点击发生的坐标去查，不是光标当前位置
    expect(calls).toEqual([[10, 20]])
  })

  it('滚轮新手势开始时补焦点；同一手势里不重复补', () => {
    const { adapter, calls } = buildResolvable()
    expect(adapter.handle(wheel(1, 120))).toHaveLength(1)
    expect(adapter.handle(wheel(1.1, 120))).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('查询失败（点在空处 / 没这能力）就只报点击，不猜一个窗', () => {
    const { adapter } = buildResolvable(() => null)
    expect(adapter.handle(click(5))).toEqual([{ kind: 'click', ts: at(5), button: 'left', x: 10, y: 20 }])

    const plain = new DesktopEventAdapter(new FakeSource(), { now: () => at(0) })
    expect(plain.handle(click(5))).toEqual([{ kind: 'click', ts: at(5), button: 'left', x: 10, y: 20 }])
  })
})
