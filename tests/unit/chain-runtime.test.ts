import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import { getSegmentDetail, openSegment, querySegments, type ChainDb } from '../../src/chain/store'
import { ChainRuntime } from '../../src/chain/hook/runtime'
import type { DesktopEventSource, RawDesktopEvent, WindowFacts } from '../../src/chain/hook/types'

const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const at = (seconds: number): number => T0 + seconds * 1000

class FakeSource implements DesktopEventSource {
  tick = 1_000
  handler: ((event: RawDesktopEvent) => void) | null = null
  started = 0
  stopped = 0
  /** 「这个点下面是哪扇窗」（v0.13）；null 表示查不到 */
  windowAt: WindowFacts | null = null
  start(onEvent: (event: RawDesktopEvent) => void): void {
    this.handler = onEvent
    this.started += 1
  }
  stop(): void {
    this.handler = null
    this.stopped += 1
  }
  lastInputTickMs(): number {
    return this.tick
  }
  readWindowAt(): WindowFacts | null {
    return this.windowAt
  }
  emit(event: RawDesktopEvent): void {
    this.handler?.(event)
  }
}

function foreground(seconds: number, title = 'A', pid = 100): RawDesktopEvent {
  return { type: 'foreground', ts: at(seconds), pid, hwnd: pid * 10, exe: `app${pid}`, title, app: `App${pid}` }
}
function click(seconds: number): RawDesktopEvent {
  return { type: 'click', ts: at(seconds), x: 10, y: 20, button: 'left' }
}

let db: ChainDb
let clock = T0

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
  clock = T0
})

afterEach(() => {
  db.close()
})

function build(takeShot: boolean | ((request: { kind: string }) => unknown) = false) {
  const source = new FakeSource()
  const shots: Array<{ kind: string; segmentId: number }> = []
  const runtime = new ChainRuntime({
    db,
    source,
    now: () => clock,
    autoPulse: false,
    takeShot:
      takeShot === false
        ? undefined
        : () => {
            shots.push({ kind: 'shot', segmentId: 0 })
            return { shot: { path: '/tmp/s.webp', width: 100, height: 100, bytes: 10 }, content: { source: 'uia', text: '正文' } }
          }
  })
  /** 一次性推 N 秒心跳（模拟定时器） */
  const run = (seconds: number) => {
    for (let second = 1; second <= seconds; second++) {
      clock = at(second)
      runtime.pulse(at(second))
    }
  }
  return { source, runtime, shots, run }
}

describe('链路启动', () => {
  it('start 先建表、收口上次遗留的开段，再订阅事件源', () => {
    // 上次崩溃留下的开段
    const stale = openSegment(db, { startTs: at(-60), pid: 9, exe: 'old', app: 'Old', hwnd: 90, title: '旧段' }, at(-60))
    const { source, runtime } = build()
    runtime.start()
    expect(source.started).toBe(1)
    expect(runtime.stats.started).toBe(true)
    expect(stale).toBeGreaterThan(0)
    // 遗留段已收口，所以能开新段
    source.emit(foreground(0))
    expect(runtime.stats.openSegmentId).not.toBeNull()
    runtime.stop()
  })

  it('stop 会把开着的段收口，并停掉事件源', () => {
    const { source, runtime } = build()
    runtime.start()
    source.emit(foreground(0))
    clock = at(30)
    runtime.stop()
    expect(source.stopped).toBe(1)
    expect(runtime.stats.started).toBe(false)
    expect(runtime.stats.openSegmentId).toBeNull()
    const [segment] = querySegments(db)
    expect(segment).toMatchObject({ start_ts: at(0), end_ts: at(30), active_ms: 30_000, closed: 1 })
  })

  it('幽灵前台窗被丢掉，计数进 stats（v0.12 真机核对用）', () => {
    const { source, runtime } = build()
    runtime.start()
    source.emit(foreground(0, 'A'))
    source.emit({
      type: 'foreground',
      ts: at(5),
      pid: 900,
      hwnd: 9000,
      exe: 'hrupdate',
      title: '',
      app: null,
      visible: false,
      onScreenArea: 0
    })
    expect(runtime.stats.phantomDropped).toBe(1)
    expect(runtime.stats.openSegmentId).not.toBeNull()
    // 段还是原来那段，没被幽灵窗切走
    source.emit(click(6))
    clock = at(10)
    runtime.stop()
    const segments = querySegments(db)
    expect(segments).toHaveLength(1)
    expect(segments[0].exe).toBe('app100')
  })

  it('点哪算哪：前台没报切换，点进另一个窗也会切段（v0.13）', () => {
    const { source, runtime } = build()
    runtime.start()
    source.emit(foreground(0, 'A', 100))
    // 关键：全程没有新的前台事件（模拟钩子漏事件 / 前台被隐藏窗抢走）
    source.windowAt = { pid: 300, hwnd: 3_000, exe: 'app300', title: 'B', app: 'App300' }
    source.emit(click(5))
    clock = at(10)
    runtime.stop()

    // querySegments 是新到旧：先 B 后 A
    const [segmentB, segmentA] = querySegments(db)
    expect(segmentA).toMatchObject({ exe: 'app100', start_ts: at(0), end_ts: at(5), closed: 1 })
    expect(segmentB).toMatchObject({ exe: 'app300', start_ts: at(5), closed: 1 })
    // 点击记在新段上
    const detail = getSegmentDetail(db, segmentB.id)
    expect(detail?.events.map((event) => event.kind)).toContain('click_left')
  })

  it('重复 start / 重复 stop 都是安全的', () => {
    const { runtime, source } = build()
    runtime.start()
    runtime.start()
    expect(source.started).toBe(1)
    runtime.stop()
    runtime.stop()
    expect(source.stopped).toBe(1)
  })
})

describe('一路跑下来的会话', () => {
  it('切窗口 → 点击 → 心跳推时长，落库能反查到事件与截图', () => {
    const { source, runtime, run } = build(true)
    runtime.start()
    source.emit(foreground(0, '文章 A', 100))
    run(5)
    source.emit(click(6))
    run(10)
    source.emit(foreground(11, 'pwsh', 200))
    run(20)
    runtime.stop()

    const segments = querySegments(db)
    expect(segments).toHaveLength(2)
    expect(segments.map((row) => row.title_first)).toEqual(['pwsh', '文章 A'])
    const first = segments[1]
    expect(first).toMatchObject({ start_ts: at(0), end_ts: at(11), active_ms: 11_000 })
    const detail = getSegmentDetail(db, first.id)
    expect(detail?.events.map((row) => row.kind)).toEqual(['enter', 'click_left'])
    expect(detail?.shots.map((row) => row.source)).toEqual(['enter', 'event'])
    expect(detail?.contents.map((row) => row.text)).toEqual(['正文'])
  })

  it('人走开：心跳把段在空闲起点收口，不再记录', () => {
    const { source, runtime, run } = build()
    runtime.start()
    source.emit(foreground(0))
    run(70) // 60s 后进入空闲
    expect(runtime.stats.idle).toBe(true)
    runtime.stop()
    const [segment] = querySegments(db)
    expect(segment.end_ts).toBe(at(60))
  })

  it('打字：tick 前进且无鼠标 → 键盘活动 → 停顿 3s 补一条 typing 事件（不截图）', () => {
    const { source, runtime, run, shots } = build(true)
    runtime.start()
    source.emit(foreground(0))
    // 每秒都有键盘输入（tick 前进、没有鼠标事件）
    for (let second = 1; second <= 5; second++) {
      source.tick += 500
      clock = at(second)
      runtime.pulse(at(second))
    }
    // 之后不再输入，等到停顿满 3s
    for (let second = 6; second <= 9; second++) {
      clock = at(second)
      runtime.pulse(at(second))
    }
    runtime.stop()

    const [segment] = querySegments(db)
    const detail = getSegmentDetail(db, segment.id)
    expect(detail?.events.map((row) => row.kind)).toEqual(['enter', 'typing'])
    // v0.11：打字自己停顿不截图——证据只在点击 / 滚轮 / 打字被打断时产生
    expect(detail?.shots.map((row) => row.source)).toEqual(['enter'])
    expect(shots.length).toBe(1)
  })
})

describe('异步截图（真实抓帧）', () => {
  it('drain 等在途截图落库，事件本身立刻可见', async () => {
    const source = new FakeSource()
    const runtime = new ChainRuntime({
      db,
      source,
      now: () => clock,
      autoPulse: false,
      takeShot: async (request) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
        return { shot: { path: `/tmp/${request.at}.png`, width: 8, height: 6, bytes: 42 } }
      }
    })
    runtime.start()
    source.emit(foreground(0, '文章 A', 100))
    clock = at(5)
    source.emit(click(5))

    // 抓帧在路上：事件已经落行，截图还没有
    const openId = runtime.stats.openSegmentId
    expect(openId).not.toBeNull()
    expect(runtime.stats.shotStats).toEqual({ pending: 2, inserted: 0, dropped: 0, failed: 0 })
    expect(getSegmentDetail(db, openId!)?.events.map((row) => row.kind)).toEqual(['enter', 'click_left'])

    await runtime.drain()
    expect(runtime.stats.shotStats).toEqual({ pending: 0, inserted: 2, dropped: 0, failed: 0 })
    expect(getSegmentDetail(db, openId!)?.shots.map((row) => row.bytes)).toEqual([42, 42])

    clock = at(10)
    runtime.stop()
  })
})

describe('传输自述', () => {
  it('默认标成假源，可显式覆盖', () => {
    const { runtime } = build()
    expect(runtime.sourceInfo.kind).toBe('fake')
    const native = new ChainRuntime({
      db,
      source: new FakeSource(),
      autoPulse: false,
      sourceInfo: { kind: 'native', detail: 'chain-hook 0.1.0' }
    })
    expect(native.sourceInfo.detail).toBe('chain-hook 0.1.0')
  })
})

describe('内容补写（按段 id）', () => {
  it('收口之后仍能按段 id 补写内容（读取比抓帧慢）', () => {
    const { source, runtime } = build()
    runtime.start()
    source.emit(foreground(0))
    clock = at(10)
    runtime.stop()
    const [segment] = querySegments(db)
    expect(runtime.recordContentFor(segment.id, at(5), { source: 'uia', text: '晚到的正文' })).toBe(true)
    expect(getSegmentDetail(db, segment.id)?.contents.map((row) => row.text)).toEqual(['晚到的正文'])
  })
})
