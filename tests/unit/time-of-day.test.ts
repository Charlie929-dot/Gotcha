import { describe, expect, it } from 'vitest'
import {
  ALL_DAY,
  clockOf,
  clockWindows,
  columnIndex,
  columnScrollTop,
  formatClock,
  formatClockRange,
  isAllDay,
  momentInWindows,
  normalizeClock,
  windowSpan,
  windowsOverlap
} from '../../src/renderer/graph/time-of-day'

function ts(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number {
  return new Date(y, m - 1, d, h, min, s, ms).getTime()
}

describe('时段归一化与展示', () => {
  it('夹到 0–1439，起 > 止 时交换', () => {
    expect(normalizeClock(9 * 60, 18 * 60)).toEqual({ fromMinute: 540, toMinute: 1080 })
    expect(normalizeClock(18 * 60, 9 * 60)).toEqual({ fromMinute: 540, toMinute: 1080 })
    expect(normalizeClock(-10, 2000)).toEqual({ fromMinute: 0, toMinute: 1439 })
    expect(normalizeClock(Number.NaN, Number.NaN)).toEqual(ALL_DAY)
  })

  it('全天判定与 HH:mm 展示', () => {
    expect(isAllDay(ALL_DAY)).toBe(true)
    expect(isAllDay(normalizeClock(0, 23 * 60 + 58))).toBe(false)
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(9 * 60 + 5)).toBe('09:05')
    expect(formatClock(1439)).toBe('23:59')
    expect(formatClock(Number.NaN)).toBe('00:00')
    expect(formatClockRange(ALL_DAY)).toBe('全天')
    expect(formatClockRange({ fromMinute: 540, toMinute: 1080 })).toBe('09:00–18:00')
  })

  it('本地时刻 → 当天分钟', () => {
    expect(clockOf(ts(2026, 10, 24, 9, 5))).toBe(9 * 60 + 5)
    expect(clockOf(ts(2026, 10, 24, 23, 59, 59))).toBe(1439)
  })
})

describe('日期 × 时段 → 时间窗', () => {
  it('单日 09:00–18:00：止点覆盖该分钟最后一毫秒', () => {
    const windows = clockWindows(new Set(['2026-10-24']), { fromMinute: 540, toMinute: 1080 })
    expect(windows).toHaveLength(1)
    expect(windows[0].start).toBe(ts(2026, 10, 24, 9, 0))
    expect(windows[0].end).toBe(ts(2026, 10, 24, 18, 0, 59, 999))
    expect(momentInWindows(ts(2026, 10, 24, 9, 0), windows)).toBe(true)
    expect(momentInWindows(ts(2026, 10, 24, 18, 0, 30), windows)).toBe(true)
    expect(momentInWindows(ts(2026, 10, 24, 8, 59, 59, 999), windows)).toBe(false)
    expect(momentInWindows(ts(2026, 10, 24, 18, 1), windows)).toBe(false)
  })

  it('多日各自成窗，顺序稳定；未选日期不产生窗口', () => {
    const windows = clockWindows(new Set(['2026-10-24', '2026-10-22']), ALL_DAY)
    expect(windows.map((window) => new Date(window.start).getDate())).toEqual([22, 24])
    expect(windows[0].start).toBe(ts(2026, 10, 22))
    expect(windows[0].end).toBe(ts(2026, 10, 22, 23, 59, 59, 999))
    expect(clockWindows(new Set(), ALL_DAY)).toEqual([])
    expect(clockWindows(null, ALL_DAY)).toEqual([])
  })

  it('主题区间与任一窗口相交即命中（跨天主题不会漏）', () => {
    const windows = clockWindows(new Set(['2026-10-24']), { fromMinute: 540, toMinute: 1080 })
    expect(windowsOverlap(ts(2026, 10, 24, 8), ts(2026, 10, 24, 9, 30), windows)).toBe(true)
    expect(windowsOverlap(ts(2026, 10, 23, 20), ts(2026, 10, 24, 8, 30), windows)).toBe(false)
    expect(windowsOverlap(ts(2026, 10, 24, 18, 0), ts(2026, 10, 24, 19), windows)).toBe(true)
    expect(windowsOverlap(ts(2026, 10, 24, 18, 1), ts(2026, 10, 24, 19), windows)).toBe(false)
    // 非有限值按单点处理，不放大范围
    expect(windowsOverlap(Number.NaN, Number.NaN, windows)).toBe(false)
  })

  it('检索窗取最早一天起 → 最晚一天止（不连续选择是已知近似）', () => {
    const days = new Set(['2026-10-22', '2026-10-24'])
    expect(windowSpan(days, { fromMinute: 540, toMinute: 1080 })).toEqual({
      fromTs: ts(2026, 10, 22, 9, 0),
      toTs: ts(2026, 10, 24, 18, 0, 59, 999)
    })
    expect(windowSpan(null, ALL_DAY)).toBeNull()
    expect(windowSpan(new Set(), ALL_DAY)).toBeNull()
    expect(windowSpan(new Set(['bad']), ALL_DAY)).toBeNull()
  })
})

describe('滚轮列位置', () => {
  it('滚动位置 → 最近序号（夹紧）', () => {
    expect(columnIndex(0, 28, 24)).toBe(0)
    expect(columnIndex(13, 28, 24)).toBe(0)
    expect(columnIndex(14, 28, 24)).toBe(1)
    expect(columnIndex(-50, 28, 24)).toBe(0)
    expect(columnIndex(99999, 28, 24)).toBe(23)
    expect(columnIndex(10, 0, 24)).toBe(0)
  })

  it('序号 → 滚动位置（夹紧）', () => {
    expect(columnScrollTop(0, 28, 60)).toBe(0)
    expect(columnScrollTop(5, 28, 60)).toBe(140)
    expect(columnScrollTop(999, 28, 60)).toBe(59 * 28)
    expect(columnScrollTop(-3, 28, 60)).toBe(0)
    expect(columnScrollTop(3, 28, 0)).toBe(0)
  })
})
