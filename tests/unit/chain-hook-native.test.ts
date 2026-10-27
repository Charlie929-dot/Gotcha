import { describe, expect, it } from 'vitest'
import {
  isNativeBinding,
  loadNativeBinding,
  nativeCandidates,
  NativeDesktopSource,
  normalizeRawEvent,
  normalizeWindowFacts,
  type NativeBinding
} from '../../src/chain/hook/native'
import { DesktopEventAdapter } from '../../src/chain/hook/adapter'
import type { RawDesktopEvent } from '../../src/chain/hook/types'

function fakeBinding(events: unknown[] = []): NativeBinding & { callbacks: Array<(event: unknown) => void> } {
  const callbacks: Array<(event: unknown) => void> = []
  return {
    version: '0.1.0',
    callbacks,
    start(callback) {
      callbacks.push(callback)
    },
    stop() {
      callbacks.length = 0
    },
    lastInputTickMs: () => 1234
  }
}

describe('原生对象的形状校验', () => {
  it('四条合法事件原样放行', () => {
    expect(
      normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'firefox', title: 'A', app: 'Firefox' })
    ).toEqual({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'firefox', title: 'A', app: 'Firefox' })
    expect(normalizeRawEvent({ type: 'move', ts: 1, x: 10, y: 20 })).toEqual({ type: 'move', ts: 1, x: 10, y: 20 })
    expect(normalizeRawEvent({ type: 'click', ts: 1, x: 10, y: 20, button: 'left' })).toEqual({
      type: 'click',
      ts: 1,
      x: 10,
      y: 20,
      button: 'left'
    })
    expect(normalizeRawEvent({ type: 'wheel', ts: 1, x: 10, y: 20, delta: -120 })).toEqual({
      type: 'wheel',
      ts: 1,
      x: 10,
      y: 20,
      delta: -120
    })
  })

  it('缺字段 / 类型不对 / 未知类型都丢掉，不猜默认值', () => {
    expect(normalizeRawEvent(null)).toBeNull()
    expect(normalizeRawEvent('wheel')).toBeNull()
    expect(normalizeRawEvent({ type: 'wheel', ts: 1, x: 10, y: 20 })).toBeNull()
    expect(normalizeRawEvent({ type: 'click', ts: 1, x: 10, y: 20, button: 'side' })).toBeNull()
    expect(normalizeRawEvent({ type: 'move', ts: Number.NaN, x: 1, y: 1 })).toBeNull()
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3 })).toBeNull()
    expect(normalizeRawEvent({ type: 'keypress', ts: 1 })).toBeNull()
  })

  it('标题 / 应用名缺失时用空串与 null，不编造', () => {
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'a' })).toMatchObject({
      title: '',
      app: null
    })
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'a', app: '' })).toMatchObject({
      app: null
    })
  })

  it('窗口事实（v0.12）原样放行；报了但不合格就整条丢掉', () => {
    expect(
      normalizeRawEvent({
        type: 'foreground',
        ts: 1,
        pid: 2,
        hwnd: 3,
        exe: 'a',
        visible: false,
        minimized: true,
        onScreenArea: 0,
        className: 'TaskSwitcherWnd'
      })
    ).toEqual({
      type: 'foreground',
      ts: 1,
      pid: 2,
      hwnd: 3,
      exe: 'a',
      title: '',
      app: null,
      visible: false,
      minimized: true,
      onScreenArea: 0,
      className: 'TaskSwitcherWnd'
    })
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'a', visible: 'no' })).toBeNull()
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'a', minimized: 1 })).toBeNull()
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'a', onScreenArea: -1 })).toBeNull()
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'a', onScreenArea: Number.NaN })).toBeNull()
    expect(normalizeRawEvent({ type: 'foreground', ts: 1, pid: 2, hwnd: 3, exe: 'a', className: 5 })).toBeNull()
  })

  it('windowAtPoint 的返回值走同一套校验（v0.13）', () => {
    expect(
      normalizeWindowFacts({
        type: 'window',
        ts: 1,
        pid: 7,
        hwnd: 70,
        exe: 'firefox',
        title: 't',
        app: 'Firefox',
        visible: true,
        minimized: false,
        onScreenArea: 1234,
        className: 'MozillaWindowClass'
      })
    ).toEqual({
      pid: 7,
      hwnd: 70,
      exe: 'firefox',
      title: 't',
      app: 'Firefox',
      visible: true,
      minimized: false,
      onScreenArea: 1234,
      className: 'MozillaWindowClass'
    })
    expect(normalizeWindowFacts(null)).toBeNull()
    expect(normalizeWindowFacts({ pid: 7 })).toBeNull()
    expect(normalizeWindowFacts({ pid: 7, hwnd: 70, exe: 'x', visible: 'yes' })).toBeNull()
    expect(normalizeWindowFacts({ pid: 7, hwnd: 70, exe: 'x', onScreenArea: -5 })).toBeNull()
  })
})

describe('加载原生模块', () => {
  it('第一个候选不存在就跳过，第二个加载成功', () => {
    const binding = fakeBinding()
    const loaded = loadNativeBinding({
      candidates: ['C:/没有这个.node', 'C:/有.node'],
      exists: (path) => path === 'C:/有.node',
      load: () => binding
    })
    expect(loaded).toBe(binding)
  })

  it('加载抛错 / 形状不对都返回 null，不把应用带崩', () => {
    expect(
      loadNativeBinding({ candidates: ['a.node'], exists: () => true, load: () => { throw new Error('ABI 不匹配') } })
    ).toBeNull()
    expect(loadNativeBinding({ candidates: ['a.node'], exists: () => true, load: () => ({ start: 1 }) })).toBeNull()
    expect(loadNativeBinding({ candidates: [], exists: () => true, load: () => fakeBinding() })).toBeNull()
  })

  it('先看开发构建产物，再看打包后的 resources 目录', () => {
    const dev = nativeCandidates('D:/Gotcha')
    expect(dev).toHaveLength(1)
    expect(dev[0]).toContain('chain-hook')
    expect(dev[0].endsWith('chain_hook.node')).toBe(true)
    expect(nativeCandidates('D:/Gotcha', 'D:/app/resources')).toHaveLength(2)
  })

  it('形状判定要求三个方法都是函数', () => {
    expect(isNativeBinding(fakeBinding())).toBe(true)
    expect(isNativeBinding({ start() {}, stop() {} })).toBe(false)
    expect(isNativeBinding(null)).toBe(false)
  })
})

describe('原生事件源', () => {
  it('查「这个点下面是哪扇窗」：没这个导出就返回 null（旧构建照样能用）', () => {
    const source = new NativeDesktopSource(fakeBinding())
    expect(source.readWindowAt(10, 20)).toBeNull()
  })

  it('查到的窗原样返回；本进程自己的窗不算（悬浮球 / 采集窗口不该成段）', () => {
    const window = { type: 'window', pid: 4242, hwnd: 42420, exe: 'firefox', title: 't', app: 'Firefox' }
    const own = { ...window, pid: process.pid }
    let answer: unknown = window
    const binding = { ...fakeBinding(), windowAtPoint: () => answer }
    const source = new NativeDesktopSource(binding)
    expect(source.readWindowAt(1, 2)).toEqual({
      pid: 4242,
      hwnd: 42420,
      exe: 'firefox',
      title: 't',
      app: 'Firefox'
    })
    answer = own
    expect(source.readWindowAt(1, 2)).toBeNull()
    answer = undefined
    expect(source.readWindowAt(1, 2)).toBeNull()
  })

  it('把不合格的原生事件丢掉，好的照常转发', () => {
    const binding = fakeBinding()
    const source = new NativeDesktopSource(binding)
    const received: RawDesktopEvent[] = []
    source.start((event) => received.push(event))
    expect(binding.callbacks).toHaveLength(1)

    binding.callbacks[0]({ type: 'click', ts: 5, x: 1, y: 2, button: 'right' })
    binding.callbacks[0]({ type: 'keypress', ts: 6 })
    binding.callbacks[0]({ nonsense: true })
    expect(received).toEqual([{ type: 'click', ts: 5, x: 1, y: 2, button: 'right' }])
  })

  it('tick 与 stop 直通原生层', () => {
    const binding = fakeBinding()
    const source = new NativeDesktopSource(binding)
    expect(source.lastInputTickMs()).toBe(1234)
    source.stop()
    expect(binding.callbacks).toHaveLength(0)
  })

  it('自述信息带上模块版本', () => {
    expect(new NativeDesktopSource(fakeBinding()).sourceInfo).toEqual({ kind: 'native', detail: 'chain_hook 0.1.0' })
  })

  it('接上适配层就能变成段机输入（整条传输侧的形状对上）', () => {
    const binding = fakeBinding()
    const source = new NativeDesktopSource(binding)
    const adapter = new DesktopEventAdapter(source, { now: () => 1_000 })
    const inputs: unknown[] = []
    source.start((event) => inputs.push(...adapter.handle(event)))

    binding.callbacks[0]({ type: 'foreground', ts: 100, pid: 7, hwnd: 70, exe: 'firefox', title: 'A', app: 'Firefox' })
    expect(inputs).toEqual([
      { kind: 'focus', ts: 100, pid: 7, hwnd: 70, exe: 'firefox', title: 'A', app: 'Firefox' }
    ])
  })

  it('窗口事实原样透传给段机（适配层不改判、不补默认值）', () => {
    const binding = fakeBinding()
    const source = new NativeDesktopSource(binding)
    const adapter = new DesktopEventAdapter(source, { now: () => 1_000 })
    const inputs: unknown[] = []
    source.start((event) => inputs.push(...adapter.handle(event)))

    binding.callbacks[0]({
      type: 'foreground',
      ts: 100,
      pid: 7,
      hwnd: 70,
      exe: 'hrupdate',
      title: '',
      app: null,
      visible: false,
      minimized: true,
      onScreenArea: 0,
      className: 'TaskSwitcherWnd'
    })
    expect(inputs).toEqual([
      {
        kind: 'focus',
        ts: 100,
        pid: 7,
        hwnd: 70,
        exe: 'hrupdate',
        title: '',
        app: null,
        visible: false,
        minimized: true,
        onScreenArea: 0,
        className: 'TaskSwitcherWnd'
      }
    ])
  })
})
