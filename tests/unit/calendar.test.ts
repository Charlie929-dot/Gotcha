import { describe, expect, it } from 'vitest'
import {
  dayKey,
  dayRange,
  dayStart,
  editDaySelection,
  formatDayLabel,
  momentMatchesDays,
  monthGrid,
  monthTitle,
  parseDayKey,
  presetDays,
  shiftMonth,
  themeMatchesDays
} from '../../src/renderer/graph/calendar'

const DAY_MS = 24 * 60 * 60 * 1000

function ts(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime()
}

describe('calendar day keys', () => {
  it('本地日键与零点可互相解析', () => {
    const value = ts(2026, 10, 23, 15)
    const key = dayKey(value)
    expect(key).toBe('2026-10-23')
    expect(dayStart(value)).toBe(ts(2026, 10, 23))
    expect(parseDayKey(key)).toBe(ts(2026, 10, 23))
  })

  it('非法日键返回 NaN，不做静默纠正', () => {
    expect(Number.isNaN(parseDayKey('2026-13-01'))).toBe(true)
    expect(Number.isNaN(parseDayKey('2026-02-30'))).toBe(true)
    expect(Number.isNaN(parseDayKey('not-a-day'))).toBe(true)
  })
})

describe('month grid', () => {
  it('固定 6 行 × 7 列、周一开头、跨月补位', () => {
    const grid = monthGrid(2026, 9) // 2026-10，1 号是周四
    expect(grid).toHaveLength(42)
    expect(grid[0].key).toBe('2026-09-28')
    expect(grid[0].inMonth).toBe(false)
    expect(grid[3].key).toBe('2026-10-01')
    expect(grid[3].inMonth).toBe(true)
    expect(grid[41].key).toBe('2026-11-08')
    expect(grid[41].inMonth).toBe(false)
  })

  it('月份标题与平移', () => {
    expect(monthTitle(2026, 0)).toBe('2026 年 1 月')
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 })
  })
})

describe('presets 与选择编辑', () => {
  const now = ts(2026, 10, 23, 12)

  it('今天 / 前 7 天 / 全部', () => {
    expect(presetDays(now, 'today')).toEqual(new Set(['2026-10-23']))
    expect(presetDays(now, '3d')?.size).toBe(3)
    expect(presetDays(now, '7d')).toEqual(
      new Set(['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17'])
    )
    expect(presetDays(now, '30d')?.size).toBe(30)
    expect(presetDays(now, 'all')).toBeNull()
  })

  it('从「全部」开始点击 = 只选这一天；再点可取消成空集合', () => {
    const first = editDaySelection(null, '2026-10-21', 'toggle')
    expect(first).toEqual(new Set(['2026-10-21']))
    const cleared = editDaySelection(first, '2026-10-21', 'toggle')
    expect(cleared).toEqual(new Set())
  })

  it('Ctrl 加减 / replace 不修改入参', () => {
    const base = new Set(['2026-10-21', '2026-10-23'])
    expect(editDaySelection(base, '2026-10-22', 'add')).toEqual(
      new Set(['2026-10-21', '2026-10-22', '2026-10-23'])
    )
    expect(editDaySelection(base, '2026-10-21', 'remove')).toEqual(new Set(['2026-10-23']))
    expect(editDaySelection(base, '2026-10-25', 'replace')).toEqual(new Set(['2026-10-25']))
    expect(base).toEqual(new Set(['2026-10-21', '2026-10-23']))
  })

  it('范围含端点、端点顺序无关', () => {
    expect(dayRange('2026-10-21', '2026-10-23')).toEqual(
      new Set(['2026-10-21', '2026-10-22', '2026-10-23'])
    )
    expect(dayRange('2026-10-23', '2026-10-21')).toEqual(
      new Set(['2026-10-21', '2026-10-22', '2026-10-23'])
    )
    expect(dayRange('bad', '2026-10-21').size).toBe(0)
  })
})

describe('时间筛选语义', () => {
  it('主题与任一所选日相交就算 focused', () => {
    const start = ts(2026, 10, 21, 20)
    const end = ts(2026, 10, 22, 2)
    expect(themeMatchesDays(start, end, null)).toBe(true)
    expect(themeMatchesDays(start, end, new Set(['2026-10-22']))).toBe(true)
    expect(themeMatchesDays(start, end, new Set(['2026-10-21']))).toBe(true)
    expect(themeMatchesDays(start, end, new Set(['2026-10-20', '2026-10-23']))).toBe(false)
  })

  it('时刻按 dayKey 精确匹配', () => {
    expect(momentMatchesDays('2026-10-22', null)).toBe(true)
    expect(momentMatchesDays('2026-10-22', new Set(['2026-10-22']))).toBe(true)
    expect(momentMatchesDays('2026-10-22', new Set(['2026-10-23']))).toBe(false)
  })

  it('跨天主题不会因为 ±1 天误差漏选', () => {
    const start = ts(2026, 10, 21, 23, 30)
    const end = start + 3 * 60 * 60 * 1000
    expect(themeMatchesDays(start, end, new Set(['2026-10-22']))).toBe(true)
  })
})

describe('工具栏标签', () => {
  it('全部 / 单日 / 连续范围 / 不连续', () => {
    expect(formatDayLabel(null)).toBe('全部')
    expect(formatDayLabel(new Set())).toBe('未选日期')
    expect(formatDayLabel(new Set(['2026-10-23']))).toBe('2026-10-23')
    expect(formatDayLabel(new Set(['2026-10-21', '2026-10-22', '2026-10-23']))).toBe(
      '2026-10-21 ~ 2026-10-23'
    )
    expect(formatDayLabel(new Set(['2026-10-21', '2026-10-23']))).toBe('2 天（不连续）')
    expect(DAY_MS).toBeGreaterThan(0)
  })
})
