import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEAT_FULL_SCALE,
  HEAT_ALPHA_MAX,
  HEAT_ALPHA_MIN,
  MAX_DAYS_PER_THEME,
  computeDayStats,
  dayTooltip,
  hasRecord,
  heatAlpha,
  heatRatio
} from '../../src/renderer/graph/day-stats'
import { DEFAULT_DAY_HEAT_MAX } from '../../src/main/graph-settings'

function ts(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime()
}

describe('computeDayStats', () => {
  it('事件 / 时刻来自 dayActivity，按 dayKey 落桶', () => {
    const stats = computeDayStats([], [
      { dayKey: '2026-10-23', events: 3_120, moments: 210 },
      { dayKey: '2026-10-22', events: 40, moments: 3 }
    ])
    expect(stats.get('2026-10-23')).toEqual({ events: 3_120, moments: 210, themes: 0 })
    expect(stats.get('2026-10-22')).toEqual({ events: 40, moments: 3, themes: 0 })
  })

  it('主题按区间铺到每一天（含首尾），同一天多个主题累加', () => {
    const stats = computeDayStats(
      [
        { tsStart: ts(2026, 10, 22, 9), tsEnd: ts(2026, 10, 24, 18) },
        { tsStart: ts(2026, 10, 23, 8), tsEnd: ts(2026, 10, 23, 8) }
      ],
      []
    )
    expect(stats.get('2026-10-22')?.themes).toBe(1)
    expect(stats.get('2026-10-23')?.themes).toBe(2)
    expect(stats.get('2026-10-24')?.themes).toBe(1)
    expect(stats.get('2026-10-25')).toBeUndefined()
  })

  it('主题与活动量合并到同一桶里，互不覆盖', () => {
    const stats = computeDayStats([{ tsStart: ts(2026, 10, 23, 9), tsEnd: ts(2026, 10, 23, 10) }], [
      { dayKey: '2026-10-23', events: 7, moments: 1 }
    ])
    expect(stats.get('2026-10-23')).toEqual({ events: 7, moments: 1, themes: 1 })
  })

  it('非法输入跳过：坏 dayKey / NaN 时间戳 / 倒序区间 / 负计数', () => {
    const stats = computeDayStats(
      [
        { tsStart: Number.NaN, tsEnd: ts(2026, 10, 23) },
        { tsStart: ts(2026, 10, 23), tsEnd: Number.NaN },
        { tsStart: ts(2026, 10, 24), tsEnd: ts(2026, 10, 23) }
      ],
      [
        { dayKey: '2026-13-01', events: 1, moments: 1 },
        { dayKey: '', events: 2, moments: 2 },
        { dayKey: '2026-10-25', events: -5, moments: Number.NaN }
      ]
    )
    expect(stats.get('2026-10-25')).toEqual({ events: 0, moments: 0, themes: 0 })
    expect(stats.size).toBe(1)
  })

  it('主题区间异常长时按 MAX_DAYS_PER_THEME 截断，不白跑循环', () => {
    const start = ts(2026, 1, 1)
    const stats = computeDayStats([{ tsStart: start, tsEnd: start + 5000 * 24 * 60 * 60 * 1000 }], [])
    expect(stats.size).toBe(MAX_DAYS_PER_THEME)
    expect(stats.get('2026-01-01')?.themes).toBe(1)
  })
})

describe('heatRatio / heatAlpha（百分比 → 连续不透明度）', () => {
  it('百分比＝当天事件 ÷ 满量，超过满量封顶 1', () => {
    expect(heatRatio(0, 4000)).toBe(0)
    expect(heatRatio(1_000, 4_000)).toBe(0.25)
    expect(heatRatio(4_000, 4_000)).toBe(1)
    expect(heatRatio(9_999, 4_000)).toBe(1)
  })

  it('满量非法（0 / 负 / NaN）回退默认，不产生除零', () => {
    expect(heatRatio(2_000, 0)).toBe(heatRatio(2_000, DEFAULT_HEAT_FULL_SCALE))
    expect(heatRatio(2_000, Number.NaN)).toBe(heatRatio(2_000, DEFAULT_HEAT_FULL_SCALE))
    expect(heatRatio(Number.NaN, 4_000)).toBe(0)
  })

  it('连续变化：无记录 0，有记录落在 [MIN, MAX] 且随事件量单调递增', () => {
    expect(heatAlpha(0, 4_000)).toBe(0)
    const alphas = [100, 500, 1_000, 2_000, 4_000].map((events) => heatAlpha(events, 4_000))
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(HEAT_ALPHA_MIN)
      expect(alpha).toBeLessThanOrEqual(HEAT_ALPHA_MAX)
    }
    for (let i = 1; i < alphas.length; i += 1) {
      expect(alphas[i]).toBeGreaterThan(alphas[i - 1])
    }
    // 中间值被 γ 抬起来：满量的 1/40（100 条）也要看得见
    expect(heatAlpha(100, 4_000)).toBeGreaterThan(HEAT_ALPHA_MIN + 0.01)
    // 超过满量不再加深（封顶后与满量相同，不回落）
    expect(heatAlpha(8_000, 4_000)).toBe(HEAT_ALPHA_MAX)
    expect(heatAlpha(8_000, 4_000)).toBe(alphas[alphas.length - 1])
  })

  it('保留 3 位小数，避免 DOM 上出现浮点长尾', () => {
    const alpha = heatAlpha(1_234, 4_000)
    expect(String(alpha)).toMatch(/^\d+(\.\d{1,3})?$/)
  })
})

describe('hasRecord / dayTooltip', () => {
  it('没有记录：tooltip 只说日期', () => {
    expect(hasRecord(undefined)).toBe(false)
    expect(dayTooltip('2026-10-24', undefined)).toBe('2026-10-24 · 无记录')
    expect(dayTooltip('2026-10-24', { events: 0, moments: 0, themes: 0 })).toBe('2026-10-24 · 无记录')
  })

  it('有记录：事件带百分比 + 时刻 + 主题', () => {
    expect(dayTooltip('2026-10-23', { events: 1_000, moments: 82, themes: 12 }, 4_000)).toBe(
      '2026-10-23 · 1000 条事件（25%）· 82 个时刻 · 12 个主题'
    )
  })

  it('只有主题也算有记录（百分比 0%）', () => {
    expect(hasRecord({ events: 0, moments: 0, themes: 2 })).toBe(true)
    expect(dayTooltip('2026-10-23', { events: 0, moments: 0, themes: 2 }, 4_000)).toBe(
      '2026-10-23 · 0 条事件（0%）· 0 个时刻 · 2 个主题'
    )
  })
})

describe('默认满量与主进程设置一致', () => {
  it('渲染层默认满量 = 主进程设置默认值（改一处必须改另一处）', () => {
    expect(DEFAULT_HEAT_FULL_SCALE).toBe(DEFAULT_DAY_HEAT_MAX)
    expect(DEFAULT_DAY_HEAT_MAX).toBe(4_000)
  })
})
