import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import type { SegmentDraft, SegmentOpenDraft } from '../../src/chain/segmenter'
import {
  closeSegment,
  contentHash,
  dayKeyOf,
  daySummary,
  finalizeAbandonedSegments,
  findSegmentOverlaps,
  getSegment,
  getSegmentDetail,
  insertContent,
  insertEvent,
  insertShot,
  listContents,
  listEvents,
  listShots,
  openSegment,
  querySegments,
  searchContents,
  type ChainDb
} from '../../src/chain/store'

/** 本地 2026-10-26 12:00 的毫秒时间戳 */
const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const DAY = '2026-10-26'

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function openDraft(overrides: Partial<SegmentOpenDraft> = {}): SegmentOpenDraft {
  return { startTs: T0, pid: 100, exe: 'firefox', app: 'Firefox', hwnd: 200, title: 'A', ...overrides }
}

function fullDraft(overrides: Partial<SegmentDraft> = {}): SegmentDraft {
  return {
    startTs: T0,
    endTs: T0 + 60_000,
    activeMs: 60_000,
    idleMs: 0,
    pid: 100,
    exe: 'firefox',
    app: 'Firefox',
    hwnd: 200,
    titleFirst: 'A',
    titleLast: 'A',
    ...overrides
  }
}

/** 开一段并收口 */
function closedSegment(startTs = T0, durationMs = 60_000, overrides: Partial<SegmentOpenDraft> = {}): number {
  const id = openSegment(db, openDraft({ startTs, ...overrides }), startTs)
  closeSegment(
    db,
    id,
    fullDraft({ startTs, endTs: startTs + durationMs, activeMs: durationMs, idleMs: 0, ...overrides })
  )
  return id
}

describe('开段与收口', () => {
  it('开段先落一行 closed=0，end_ts 暂等于 start_ts', () => {
    const id = openSegment(db, openDraft(), T0 + 5)
    const row = getSegment(db, id)
    expect(row).toMatchObject({
      id,
      start_ts: T0,
      end_ts: T0,
      active_ms: 0,
      idle_ms: 0,
      day_key: DAY,
      app: 'Firefox',
      exe: 'firefox',
      pid: 100,
      hwnd: 200,
      title_first: 'A',
      title_last: 'A',
      created_at: T0 + 5,
      closed: 0
    })
  })

  it('收口一次落定时长与结束标题，且只能收一次', () => {
    const id = openSegment(db, openDraft(), T0)
    closeSegment(db, id, fullDraft({ endTs: T0 + 120_000, activeMs: 90_000, idleMs: 30_000, titleLast: 'B' }))
    expect(getSegment(db, id)).toMatchObject({
      end_ts: T0 + 120_000,
      active_ms: 90_000,
      idle_ms: 30_000,
      title_last: 'B',
      closed: 1
    })
    expect(() => closeSegment(db, id, fullDraft())).toThrow('已经收口')
  })

  it('同一时刻只能有一个开着的段', () => {
    openSegment(db, openDraft(), T0)
    expect(() => openSegment(db, openDraft({ startTs: T0 + 1 }), T0 + 1)).toThrow('已有开着的段')
  })

  it('段不许重叠', () => {
    closedSegment(T0, 60_000)
    expect(() => openSegment(db, openDraft({ startTs: T0 + 30_000 }), T0 + 30_000)).toThrow('段不能重叠')
    // 紧接上一段结束是允许的
    expect(() => openSegment(db, openDraft({ startTs: T0 + 60_000 }), T0 + 60_000)).not.toThrow()
  })

  it('收口时若子行超出段尾，抛错而不是把段拉长', () => {
    const id = openSegment(db, openDraft(), T0)
    insertEvent(db, { segmentId: id, ts: T0 + 90_000, kind: 'click_left' })
    expect(() => closeSegment(db, id, fullDraft({ endTs: T0 + 60_000 }))).toThrow('早于它的子行')
  })

  it('有效时长 + 空闲必须等于跨度', () => {
    const id = openSegment(db, openDraft(), T0)
    expect(() => closeSegment(db, id, fullDraft({ activeMs: 10_000, idleMs: 0 }))).toThrow('不合法')
  })
})

describe('事件 / 截图 / 内容', () => {
  it('段开着时能写事件，但事件不能早于段开始', () => {
    const id = openSegment(db, openDraft(), T0)
    expect(insertEvent(db, { segmentId: id, ts: T0 + 1_000, kind: 'click_left', x: 10, y: 20 })).toBeGreaterThan(0)
    expect(() => insertEvent(db, { segmentId: id, ts: T0 - 1, kind: 'wheel', delta: 120 })).toThrow('早于段开始')
  })

  it('段收口后事件越界抛错，事件类型受约束', () => {
    const id = closedSegment()
    expect(() => insertEvent(db, { segmentId: id, ts: T0 + 90_000, kind: 'click_left' })).toThrow('晚于段结束')
    expect(() => insertEvent(db, { segmentId: id, ts: T0 + 1, kind: 'keypress' as never })).toThrow('事件类型不合法')
    expect(() => insertEvent(db, { segmentId: 999, ts: T0 + 1, kind: 'click_left' })).toThrow('不存在')
  })

  it('截图默认 hot；事件必须同段且存在', () => {
    const first = closedSegment()
    const second = closedSegment(T0 + 60_000)
    const eventId = insertEvent(db, { segmentId: first, ts: T0 + 5_000, kind: 'click_left' })

    const shotId = insertShot(db, { segmentId: first, eventId, ts: T0 + 5_000, source: 'event', path: '/tmp/a.webp' })
    expect(getSegmentDetail(db, first)?.shots[0]).toMatchObject({ id: shotId, tier: 'hot', container: null })

    expect(() => insertShot(db, { segmentId: second, ts: T0 + 61_000, source: 'event', eventId })).toThrow('不属于同一段')
    expect(() => insertShot(db, { segmentId: first, ts: T0 + 5_000, source: 'event', eventId: 999 })).toThrow('不存在')
    expect(() => insertShot(db, { segmentId: first, ts: T0 + 5_000, source: 'typing' })).not.toThrow()
  })

  it('内容自动算字符数与指纹，空正文拒绝写入', () => {
    const id = closedSegment()
    const contentId = insertContent(db, { segmentId: id, capturedAt: T0 + 1_000, source: 'uia', text: '记忆球 原型' })
    const row = listContents(db, id)[0]
    expect(row.id).toBe(contentId)
    expect(row.chars).toBe('记忆球 原型'.length)
    expect(row.hash).toBe(contentHash('记忆球 原型'))
    expect(() => insertContent(db, { segmentId: id, capturedAt: T0 + 2_000, source: 'ocr', text: '   ' })).toThrow('内容为空')
  })

  it('指纹只看内容，不看空白差异', () => {
    expect(contentHash('a b')).toBe(contentHash('  a   b\n'))
    expect(contentHash('a b')).not.toBe(contentHash('ab'))
  })
})

describe('查询', () => {
  function seed(): { reading: number; coding: number } {
    const reading = closedSegment(T0, 600_000, { app: 'Firefox', exe: 'firefox', title: '文章 A' })
    const coding = closedSegment(T0 + 900_000, 300_000, { app: 'Windows Terminal', exe: 'windowsterminal', title: 'pwsh' })
    insertContent(db, { segmentId: reading, capturedAt: T0 + 10_000, source: 'uia', text: '如何设计记忆系统 100% 可行' })
    insertContent(db, { segmentId: coding, capturedAt: T0 + 910_000, source: 'ocr', text: 'npm test 通过' })
    return { reading, coding }
  }

  it('按日 / 应用 / 时间区间查段，默认倒序', () => {
    const { reading, coding } = seed()
    expect(querySegments(db, { dayKey: DAY }).map((row) => row.id)).toEqual([coding, reading])
    expect(querySegments(db, { app: 'Firefox' }).map((row) => row.id)).toEqual([reading])
    expect(querySegments(db, { exe: 'windowsterminal' }).map((row) => row.id)).toEqual([coding])
    // 与 [from, to] 有交集的都算：reading 跨过 from
    expect(querySegments(db, { from: T0 + 300_000, to: T0 + 400_000 }).map((row) => row.id)).toEqual([reading])
  })

  it('开着的段默认不出现在结果里，includeOpen 才出', () => {
    const id = openSegment(db, openDraft({ startTs: T0 }), T0)
    expect(querySegments(db)).toHaveLength(0)
    expect(querySegments(db, { includeOpen: true }).map((row) => row.id)).toEqual([id])
  })

  it('从段反查事件 / 截图 / 内容，按时间升序', () => {
    const id = closedSegment(T0, 600_000)
    insertEvent(db, { segmentId: id, ts: T0 + 3_000, kind: 'wheel', delta: -120 })
    insertEvent(db, { segmentId: id, ts: T0 + 1_000, kind: 'enter' })
    insertShot(db, { segmentId: id, ts: T0 + 3_000, source: 'event', path: '/tmp/b.webp' })
    insertContent(db, { segmentId: id, capturedAt: T0 + 2_000, source: 'uia', text: '正文' })

    const detail = getSegmentDetail(db, id)
    expect(detail?.segment.id).toBe(id)
    expect(detail?.events.map((row) => row.ts)).toEqual([T0 + 1_000, T0 + 3_000])
    expect(detail?.shots).toHaveLength(1)
    expect(detail?.contents[0].text).toBe('正文')
    expect(getSegmentDetail(db, 999)).toBeNull()
    expect(listEvents(db, 999)).toEqual([])
    expect(listShots(db, 999)).toEqual([])
  })

  it('按正文搜内容，带出它所在的段；% 按字面匹配', () => {
    seed()
    const hits = searchContents(db, '记忆系统')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ segment_app: 'Firefox', segment_title: '文章 A', segment_start: T0 })
    expect(searchContents(db, '100%')).toHaveLength(1)
    expect(searchContents(db, '%')).toHaveLength(1)
    expect(searchContents(db, '没有这句话')).toHaveLength(0)
    expect(searchContents(db, '  ')).toHaveLength(0)
  })

  it('当日汇总：段 / 时长 / 事件 / 截图 / 应用分布', () => {
    const { reading } = seed()
    insertEvent(db, { segmentId: reading, ts: T0 + 1_000, kind: 'enter' })
    insertShot(db, { segmentId: reading, ts: T0 + 1_000, source: 'enter', path: '/tmp/c.webp' })
    const summary = daySummary(db, DAY)
    expect(summary).toMatchObject({ dayKey: DAY, segments: 2, active_ms: 900_000, events: 1, shots: 1 })
    expect(summary.apps.map((row) => row.app)).toEqual(['Firefox', 'Windows Terminal'])
    expect(summary.apps[0].active_ms).toBe(600_000)
    expect(daySummary(db, '2000-01-01').segments).toBe(0)
  })

  it('自检：正常写入路径下段不重叠', () => {
    seed()
    expect(findSegmentOverlaps(db)).toEqual([])
  })
})

describe('崩溃收尾', () => {
  it('把异常退出留下的开段按最后一个子行时刻收口', () => {
    const id = openSegment(db, openDraft(), T0)
    insertEvent(db, { segmentId: id, ts: T0 + 42_000, kind: 'click_left' })
    expect(finalizeAbandonedSegments(db)).toBe(1)
    expect(getSegment(db, id)).toMatchObject({
      end_ts: T0 + 42_000,
      active_ms: 42_000,
      idle_ms: 0,
      title_last: 'A',
      closed: 1
    })
    // 再跑一次没有可收的段
    expect(finalizeAbandonedSegments(db)).toBe(0)
  })

  it('没有子行时按段开始收口，不产生负时长', () => {
    const id = openSegment(db, openDraft(), T0)
    finalizeAbandonedSegments(db)
    expect(getSegment(db, id)).toMatchObject({ end_ts: T0, active_ms: 0, idle_ms: 0, closed: 1 })
  })

  it('收尾之后就能接着开新段', () => {
    openSegment(db, openDraft(), T0)
    finalizeAbandonedSegments(db)
    expect(() => openSegment(db, openDraft({ startTs: T0 + 1_000 }), T0 + 1_000)).not.toThrow()
  })
})

describe('dayKeyOf', () => {
  it('按本地日期归日', () => {
    expect(dayKeyOf(T0)).toBe(DAY)
    expect(dayKeyOf(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe('2026-01-01')
    expect(dayKeyOf(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe('2026-12-31')
  })
})
