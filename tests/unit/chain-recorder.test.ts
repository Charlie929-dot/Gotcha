import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import { ChainSegmenter, type ChainInput } from '../../src/chain/segmenter'
import { ChainRecorder, shotSourceOf, type RecorderOutcome, type ShotRequest, type ShotResult, type ShotTaker } from '../../src/chain/recorder'
import { getSegment, getSegmentDetail, querySegments, searchContents, daySummary, type ChainDb } from '../../src/chain/store'

/** 本地 2026-10-26 12:00 */
const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const at = (seconds: number): number => T0 + seconds * 1000

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function focus(seconds: number, pid: number, title: string, app = `App${pid}`): ChainInput {
  return { kind: 'focus', ts: at(seconds), pid, exe: `app${pid}`, app, title, hwnd: pid * 10 }
}
function click(seconds: number, x = 100, y = 200): ChainInput {
  return { kind: 'click', ts: at(seconds), button: 'left', x, y }
}
function wheel(seconds: number, delta = 120): ChainInput {
  return { kind: 'wheel', ts: at(seconds), delta, x: 300, y: 400 }
}
function activity(seconds: number): ChainInput {
  return { kind: 'activity', ts: at(seconds) }
}
function tick(seconds: number): ChainInput {
  return { kind: 'tick', ts: at(seconds) }
}

/** 假采图：每次返回不同路径 + 固定内容（用来验去重） */
function fakeShot(requests: ShotRequest[] = []): (request: ShotRequest) => ShotResult {
  return (request) => {
    requests.push(request)
    return {
      shot: { path: `shots/${request.segmentId}-${request.at}.webp`, width: 1920, height: 1080, bytes: 20_000 },
      content: { source: 'uia', text: '同一段里没变的正文' }
    }
  }
}

function wire(takeShot?: ShotTaker) {
  const segmenter = new ChainSegmenter()
  const recorder = new ChainRecorder({ db, now: () => at(0), takeShot })
  const total = {
    opened: 0,
    closed: 0,
    events: 0,
    shots: 0,
    contents: 0,
    droppedShots: 0,
    queuedShots: 0,
    orphans: 0
  }
  const add = (outcome: RecorderOutcome) => {
    total.opened += outcome.opened
    total.closed += outcome.closed
    total.events += outcome.events
    total.shots += outcome.shots
    total.contents += outcome.contents
    total.droppedShots += outcome.droppedShots
    total.queuedShots += outcome.queuedShots
    total.orphans += outcome.orphans
  }
  const feed = (inputs: ChainInput[]) =>
    inputs.map((input) => {
      const outcome = recorder.apply(segmenter.feed(input))
      add(outcome)
      return outcome
    })
  const flush = (seconds: number) => {
    const outcome = recorder.apply(segmenter.flush(at(seconds)))
    add(outcome)
    return outcome
  }
  return { segmenter, recorder, feed, flush, total }
}

describe('假事件源跑通整条链', () => {
  it('切窗口 → 每段有入场帧、事件、内容，能按时间反查回来', () => {
    const requests: ShotRequest[] = []
    const { feed, flush } = wire(fakeShot(requests))
    feed([focus(0, 1, '文章 A', 'Firefox'), click(5), wheel(10)])
    feed([focus(30, 2, 'pwsh', 'Windows Terminal'), click(35)])
    flush(60)

    const segments = querySegments(db)
    expect(segments).toHaveLength(2)
    expect(segments.map((row) => row.closed)).toEqual([1, 1])

    const [second, first] = segments
    // 段：身份、时长、标题都对得上
    expect(first).toMatchObject({
      start_ts: at(0),
      end_ts: at(30),
      active_ms: 30_000,
      idle_ms: 0,
      app: 'Firefox',
      exe: 'app1',
      pid: 1,
      hwnd: 10,
      title_first: '文章 A',
      title_last: '文章 A'
    })
    expect(second).toMatchObject({ start_ts: at(30), end_ts: at(60), app: 'Windows Terminal' })

    // 段 → 事件 / 截图 / 内容
    const detail = getSegmentDetail(db, first.id)
    expect(detail?.events.map((row) => row.kind)).toEqual(['enter', 'click_left', 'wheel'])
    expect(detail?.events[1]).toMatchObject({ x: 100, y: 200 })
    expect(detail?.events[2]).toMatchObject({ delta: 120 })
    expect(detail?.shots.map((row) => row.source)).toEqual(['enter', 'event', 'event'])
    expect(detail?.shots.every((row) => row.tier === 'hot' && row.width === 1920)).toBe(true)
    // 每张截图都挂在触发它的事件上（入场帧挂在 enter 事件上）
    expect(detail?.shots[0].event_id).toBe(detail?.events[0].id)
    expect(detail?.shots[1].event_id).toBe(detail?.events[1].id)
    // 内容是同一段里的同一条（被去重了）
    expect(detail?.contents).toHaveLength(1)
    expect(detail?.contents[0]).toMatchObject({ source: 'uia', text: '同一段里没变的正文', chars: 9 })

    // 反查：按内容找段
    const hits = searchContents(db, '没变的正文')
    expect(hits).toHaveLength(2)
    expect(hits[0].segment_app).toBe('Windows Terminal')

    // 采图请求的元信息是对的
    expect(requests[0]).toMatchObject({ source: 'enter', kind: 'enter', at: at(0), segmentId: first.id })
    expect(requests[1]).toMatchObject({ source: 'event', kind: 'click_left', x: 100, y: 200 })
  })

  it('打字会话：连续输入只在停顿后拍一张，且带 typing 事件', () => {
    const requests: ShotRequest[] = []
    const { feed, flush } = wire(fakeShot(requests))
    const typing = Array.from({ length: 20 }, (_, index) => activity(1 + index * 0.5))
    feed([focus(0, 1, '文档'), ...typing, tick(11), tick(13.5)])
    flush(14)

    const [segment] = querySegments(db)
    const detail = getSegmentDetail(db, segment.id)
    expect(detail?.events.map((row) => row.kind)).toEqual(['enter', 'typing'])
    expect(detail?.shots.map((row) => row.source)).toEqual(['enter', 'typing'])
    expect(requests.map((request) => request.kind)).toEqual(['enter', 'typing'])
    // 最后一次输入在 10.5s，停顿满 3s 才拍
    expect(detail?.events[1].ts).toBe(at(13.5))
  })

  it('点击密集时事件全记，只有冷却外的那次截图', () => {
    const { feed, flush } = wire(fakeShot())
    feed([focus(0, 1, 'A'), click(5), click(5.3), click(5.6), click(9)])
    flush(10)
    const [segment] = querySegments(db)
    const detail = getSegmentDetail(db, segment.id)
    expect(detail?.events.map((row) => row.kind)).toEqual([
      'enter',
      'click_left',
      'click_left',
      'click_left',
      'click_left'
    ])
    expect(detail?.shots).toHaveLength(3) // enter + 5s + 9s
  })

  it('走开又回来：接续成一段，落库的 idle_ms 与有效时长对得上', () => {
    const { feed, flush } = wire(fakeShot())
    feed([focus(0, 1, 'A'), tick(61), click(240)])
    flush(300)

    const segments = querySegments(db)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      start_ts: at(0),
      end_ts: at(300),
      idle_ms: at(240) - at(60),
      active_ms: at(300) - at(0) - (at(240) - at(60))
    })
    // 回来靠点击恢复，那张帧挂在点击事件上（不是入场帧，段没重开）
    const detail = getSegmentDetail(db, segments[0].id)
    expect(detail?.events.map((row) => row.kind)).toEqual(['enter', 'click_left'])
    expect(detail?.shots.map((row) => row.source)).toEqual(['enter', 'event'])
  })

  it('采图没拍到就只记事件，不编造截图行', () => {
    const { feed, flush, total } = wire(() => null)
    feed([focus(0, 1, 'A'), click(5)])
    flush(10)
    const [segment] = querySegments(db)
    const detail = getSegmentDetail(db, segment.id)
    expect(detail?.events).toHaveLength(2)
    expect(detail?.shots).toHaveLength(0)
    expect(detail?.contents).toHaveLength(0)
    expect(total.droppedShots).toBe(2) // 入场帧 + 点击
  })

  it('没接采图时只记事件（不报错）', () => {
    const { feed, flush, total } = wire()
    feed([focus(0, 1, 'A'), click(5)])
    flush(10)
    const [segment] = querySegments(db)
    expect(getSegmentDetail(db, segment.id)?.events).toHaveLength(2)
    expect(total.shots + total.droppedShots).toBe(0)
  })

  it('内容变化时才追加新行', () => {
    let index = 0
    const texts = ['第一版正文', '第一版正文', '第二版正文']
    const recorder = new ChainRecorder({
      db,
      now: () => at(0),
      takeShot: () => ({
        shot: { path: '/tmp/x.webp', width: 100, height: 100, bytes: 1 },
        content: { source: 'ocr', text: texts[Math.min(index++, texts.length - 1)] }
      })
    })
    const segmenter = new ChainSegmenter()
    const feed = (inputs: ChainInput[]) => inputs.flatMap((input) => recorder.apply(segmenter.feed(input)))
    feed([focus(0, 1, 'A'), click(5), click(9), click(13)])
    recorder.apply(segmenter.flush(at(20)))

    const [segment] = querySegments(db)
    const contents = getSegmentDetail(db, segment.id)?.contents ?? []
    expect(contents.map((row) => row.text)).toEqual(['第一版正文', '第二版正文'])
  })

  it('外部补写内容：没有开着的段就丢弃', () => {
    const { feed, flush, recorder } = wire(fakeShot())
    expect(recorder.recordContent({ source: 'manual', text: '段外内容' }, at(1))).toBe(false)
    feed([focus(0, 1, 'A')])
    expect(recorder.recordContent({ source: 'manual', text: '段内内容' }, at(2))).toBe(true)
    flush(5)
    const [segment] = querySegments(db)
    expect(getSegmentDetail(db, segment.id)?.contents.map((row) => row.text)).toEqual(
      expect.arrayContaining(['段内内容'])
    )
  })

  it('段收口后能接着开下一段，事件不串段', () => {
    const { feed, flush } = wire(fakeShot())
    feed([focus(0, 1, 'A'), click(5)])
    flush(10)
    feed([focus(20, 2, 'B'), click(25)])
    flush(30)

    const segments = querySegments(db)
    expect(segments).toHaveLength(2)
    for (const segment of segments) {
      const detail = getSegmentDetail(db, segment.id)
      expect(detail?.events.every((row) => row.segment_id === segment.id)).toBe(true)
      // 契约 §3 第 3 条：所有子行都落在段区间内
      for (const event of detail?.events ?? []) {
        expect(event.ts).toBeGreaterThanOrEqual(segment.start_ts)
        expect(event.ts).toBeLessThanOrEqual(segment.end_ts)
      }
    }
  })

  it('当日汇总能对上来', () => {
    const { feed, flush } = wire(fakeShot())
    feed([focus(0, 1, 'A'), click(5)])
    feed([focus(30, 2, 'B'), click(35)])
    flush(60)
    const summary = daySummary(db, '2026-10-26')
    expect(summary.segments).toBe(2)
    expect(summary.active_ms).toBe(60_000)
    expect(summary.shots).toBe(4)
    expect(summary.events).toBe(4)
    // 开着的段不会被算进去
    feed([focus(120, 3, 'C')])
    expect(daySummary(db, '2026-10-26').segments).toBe(2)
  })
})

describe('shotSourceOf', () => {
  it('入场 / 打字各有自己的来源，其余算事件触发', () => {
    expect(shotSourceOf('enter')).toBe('enter')
    expect(shotSourceOf('typing')).toBe('typing')
    expect(shotSourceOf('click_left')).toBe('event')
    expect(shotSourceOf('wheel')).toBe('event')
    expect(shotSourceOf('move_pause')).toBe('event')
  })
})

describe('段的开合与库里的一致', () => {
  it('每个收口段的 closed 都是 1，且没有残留的开段', () => {
    const { feed, flush } = wire(fakeShot())
    feed([focus(0, 1, 'A'), click(5)])
    feed([focus(30, 2, 'B')])
    flush(60)
    const open = db.prepare('SELECT COUNT(*) AS n FROM chain_segment WHERE closed = 0').get() as { n: number }
    expect(open.n).toBe(0)
    const [segment] = querySegments(db, { limit: 1 })
    expect(getSegment(db, segment.id)?.closed).toBe(1)
  })
})

describe('异步采图（真实抓帧要等屏幕流）', () => {
  it('事件先落行、截图排队，drain 后按顺序补上，时刻仍用事件时刻', async () => {
    const requests: ShotRequest[] = []
    const takeShot: ShotTaker = async (request) => {
      requests.push(request)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      return {
        shot: { path: `shots/${request.at}.png`, width: 800, height: 600, bytes: 1234 },
        content: null
      }
    }
    const { feed, recorder, total } = wire(takeShot)
    feed([focus(0, 1, 'A'), click(5)])

    // 事件已经在库里，截图还在路上
    const segmentId = recorder.currentSegmentId
    expect(segmentId).not.toBeNull()
    expect(total.queuedShots).toBe(2)
    expect(total.shots).toBe(0)
    expect(recorder.shotStats).toEqual({ pending: 2, inserted: 0, dropped: 0, failed: 0 })
    expect(getSegmentDetail(db, segmentId!)?.events.map((row) => row.kind)).toEqual(['enter', 'click_left'])
    expect(getSegmentDetail(db, segmentId!)?.shots).toHaveLength(0)

    await recorder.drain()

    expect(recorder.shotStats).toEqual({ pending: 0, inserted: 2, dropped: 0, failed: 0 })
    const detail = getSegmentDetail(db, segmentId!)
    expect(detail?.shots.map((row) => row.source)).toEqual(['enter', 'event'])
    expect(detail?.shots.map((row) => row.ts)).toEqual([at(0), at(5)])
    // 截图仍挂在触发它的事件上
    expect(detail?.shots.map((row) => row.event_id)).toEqual([
      detail?.events[0].id,
      detail?.events[1].id
    ])
    expect(requests.map((request) => request.kind)).toEqual(['enter', 'click_left'])
  })

  it('段先收口、截图后落定：不因为晚到而丢，也不篡改段的结束时刻', async () => {
    const takeShot: ShotTaker = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      return { shot: { path: '/tmp/late.png', width: 10, height: 10, bytes: 5 } }
    }
    const { feed, flush, recorder } = wire(takeShot)
    feed([focus(0, 1, 'A'), click(5)])
    flush(10) // 收口时截图都还在路上
    const [segment] = querySegments(db)
    expect(segment).toMatchObject({ closed: 1, end_ts: at(10) })
    expect(getSegmentDetail(db, segment.id)?.shots).toHaveLength(0)

    await recorder.drain()

    const detail = getSegmentDetail(db, segment.id)
    expect(detail?.shots).toHaveLength(2)
    // 子行仍落在段区间内（契约 §3 第 3 条）
    for (const shot of detail?.shots ?? []) {
      expect(shot.ts).toBeGreaterThanOrEqual(segment.start_ts)
      expect(shot.ts).toBeLessThanOrEqual(segment.end_ts)
    }
    expect(getSegment(db, segment.id)).toMatchObject({ end_ts: at(10), closed: 1 })
  })

  it('异步没拍到：计入 dropped，不写行', async () => {
    const { feed, recorder } = wire(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      return null
    })
    feed([focus(0, 1, 'A'), click(5)])
    await recorder.drain()
    const detail = getSegmentDetail(db, recorder.currentSegmentId!)
    expect(detail?.events).toHaveLength(2)
    expect(detail?.shots).toHaveLength(0)
    expect(recorder.shotStats).toEqual({ pending: 0, inserted: 0, dropped: 2, failed: 0 })
  })

  it('异步采图抛错：计入 failed，不打断后续落库', async () => {
    let call = 0
    const { feed, recorder } = wire(async (request) => {
      // 用局部变量记「第几次调用」：两个异步回调共享外层计数器会互相看到对方的值
      const index = (call += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      if (index === 1) throw new Error('屏幕流断了')
      return { shot: { path: `/tmp/${request.at}.png`, width: 1, height: 1, bytes: 1 } }
    })
    feed([focus(0, 1, 'A'), click(5)])
    await recorder.drain()
    expect(recorder.shotStats).toEqual({ pending: 0, inserted: 1, dropped: 0, failed: 1 })
    // 第二张照常落行
    const detail = getSegmentDetail(db, recorder.currentSegmentId!)
    expect(detail?.shots.map((row) => row.source)).toEqual(['event'])
  })

  it('同步抛错按「没拍到」处理，不把整条链带崩', () => {
    const { feed, recorder, total } = wire(() => {
      throw new Error('抓帧同步失败')
    })
    feed([focus(0, 1, 'A'), click(5)])
    expect(total.droppedShots).toBe(2)
    expect(recorder.shotStats).toEqual({ pending: 0, inserted: 0, dropped: 0, failed: 0 })
    expect(getSegmentDetail(db, recorder.currentSegmentId!)?.shots).toHaveLength(0)
  })
})
