import { describe, expect, it } from 'vitest'
import {
  HEAT_STEPS,
  MAX_DAYS_PER_THEME,
  computeDayStats,
  dayTooltip,
  hasRecord,
  heatLevel
} from '../../src/renderer/graph/day-stats'

function ts(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime()
}

describe('computeDayStats', () => {
  it('时刻按 dayKey 落桶，事件量取 eventIds 长度之和', () => {
    const stats = computeDayStats([], [
      { dayKey: '2026-10-23', eventIds: [1, 2, 3] },
      { dayKey: '2026-10-23', eventIds: [4] },
      { dayKey: '2026-10-22', eventIds: [] }
    ])
    expect(stats.get('2026-10-23')).toEqual({ moments: 2, events: 4, themes: 0 })
    expect(stats.get('2026-10-22')).toEqual({ moments: 1, events: 0, themes: 0 })
  })

  it('主题按区间铺到每一天（含首尾），跨日不重复累加同一天', () => {
    const stats = computeDayStats(
      [{ tsStart: ts(2026, 10, 22, 9), tsEnd: ts(2026, 10, 24, 18) }, { tsStart: ts(2026, 10, 23, 8), tsEnd: ts(2026, 10, 23, 8) }],
      []
    )
    expect(stats.get('2026-10-22')?.themes).toBe(1)
    expect(stats.get('2026-10-23')?.themes).toBe(2)
    expect(stats.get('2026-10-24')?.themes).toBe(1)
    expect(stats.get('2026-10-25')).toBeUndefined()
  })

  it('主题与时刻合并到同一桶里，互不覆盖', () => {
    const stats = computeDayStats([{ tsStart: ts(2026, 10, 23, 9), tsEnd: ts(2026, 10, 23, 10) }], [
      { dayKey: '2026-10-23', eventIds: [1, 2] }
    ])
    expect(stats.get('2026-10-23')).toEqual({ moments: 1, events: 2, themes: 1 })
  })

  it('非法输入跳过：坏 dayKey / NaN 时间戳 / 倒序区间', () => {
    const stats = computeDayStats(
      [
        { tsStart: Number.NaN, tsEnd: ts(2026, 10, 23) },
        { tsStart: ts(2026, 10, 23), tsEnd: Number.NaN },
        { tsStart: ts(2026, 10, 24), tsEnd: ts(2026, 10, 23) }
      ],
      [{ dayKey: '2026-13-01', eventIds: [1] }, { dayKey: '', eventIds: [2] }]
    )
    expect(stats.size).toBe(0)
  })

  it('主题区间异常长时按 MAX_DAYS_PER_THEME 截断，不白跑循环', () => {
    const start = ts(2026, 1, 1)
    const stats = computeDayStats([{ tsStart: start, tsEnd: start + 5000 * 24 * 60 * 60 * 1000 }], [])
    expect(stats.size).toBe(MAX_DAYS_PER_THEME)
    expect(stats.get('2026-01-01')?.themes).toBe(1)
  })
})

describe('heatLevel / hasRecord / dayTooltip', () => {
  it('没有记录：0 档，tooltip 只说日期', () => {
    expect(hasRecord(undefined)).toBe(false)
    expect(heatLevel(undefined)).toBe(0)
    expect(dayTooltip('2026-10-24', undefined)).toBe('2026-10-24 · 无记录')
    expect(heatLevel({ moments: 0, events: 0, themes: 0 })).toBe(0)
  })

  it('只按事件量分档：≤第一档 / ≤第二档 / 其余最高档', () => {
    const stat = (events: number) => ({ moments: 1, events, themes: 1 })
    expect(heatLevel(stat(1))).toBe(1)
    expect(heatLevel(stat(HEAT_STEPS[0]))).toBe(1)
    expect(heatLevel(stat(HEAT_STEPS[0] + 1))).toBe(2)
    expect(heatLevel(stat(HEAT_STEPS[1]))).toBe(2)
    expect(heatLevel(stat(HEAT_STEPS[1] + 1))).toBe(3)
  })

  it('有主题没事件也算有记录（热力最低档），不当无记录', () => {
    const stat = { moments: 0, events: 0, themes: 2 }
    expect(hasRecord(stat)).toBe(true)
    expect(heatLevel(stat)).toBe(1)
  })

  it('tooltip 带三项计数', () => {
    expect(dayTooltip('2026-10-23', { moments: 12, events: 87, themes: 9 })).toBe(
      '2026-10-23 · 12 个时刻 · 87 条事件 · 9 个主题'
    )
  })
})
