/**
 * 日历日格计数（方案 §8 日格；纯函数，不碰 DOM）。
 *
 * 口径（都能从 `graph:global` 这一份 DTO 现算，不额外查库）：
 * - 时刻：`dayKey` 等于这一天的时刻数；
 * - 事件：这天各时刻 `eventIds` 长度之和，即「已被时刻覆盖的事件量」——
 *   没进时刻的积压事件这里看不到（`graph:global` 默认不返回悬空时刻之外的原始事件）；
 * - 主题：`[tsStart, tsEnd]` 覆盖到这一天的主题数。
 *
 * 日格只读这份聚合，不参与筛选判定（筛选仍走 `calendar.ts` 的精确语义）。
 */

import { dayKey, dayStart, parseDayKey } from './calendar'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 单个主题最多铺多少天。归纳出的主题区间正常只有几天；万一库里出现
 * 1970 或远期脏时间，按上限截断，避免画日历的时候白跑几百万次循环。
 */
export const MAX_DAYS_PER_THEME = 400

/** 事件量热力分档的上界：≤80 一档、≤400 一档、其余最高档。 */
export const HEAT_STEPS = [80, 400] as const

export interface DayStat {
  /** 这一天的时刻数 */
  moments: number
  /** 这一天各时刻覆盖的事件条数之和 */
  events: number
  /** 区间覆盖这一天的主题数 */
  themes: number
}

export interface DayStatTheme {
  tsStart: number
  tsEnd: number
}

export interface DayStatMoment {
  dayKey: string
  eventIds: readonly unknown[]
}

/** 某一天是否「有记录」（决定日格是否显示热力 + tooltip 文案）。 */
export function hasRecord(stat: DayStat | undefined): boolean {
  return stat !== undefined && (stat.moments > 0 || stat.events > 0 || stat.themes > 0)
}

/** 事件量 → 热力档位 0（无记录）/ 1 / 2 / 3。 */
export function heatLevel(stat: DayStat | undefined): 0 | 1 | 2 | 3 {
  if (!hasRecord(stat) || stat === undefined) return 0
  const events = stat.events
  if (events <= HEAT_STEPS[0]) return 1
  if (events <= HEAT_STEPS[1]) return 2
  return 3
}

/** 日格 tooltip：无记录只说日期，有记录给三项计数。 */
export function dayTooltip(key: string, stat: DayStat | undefined): string {
  if (!hasRecord(stat) || stat === undefined) return `${key} · 无记录`
  return `${key} · ${stat.moments} 个时刻 · ${stat.events} 条事件 · ${stat.themes} 个主题`
}

/**
 * 逐日聚合主题 / 时刻 / 事件量。
 * 主题按区间铺到每一天；时刻按 `dayKey` 落桶；非法输入（NaN / 空 key）跳过。
 */
export function computeDayStats(
  themes: readonly DayStatTheme[],
  moments: readonly DayStatMoment[]
): Map<string, DayStat> {
  const stats = new Map<string, DayStat>()

  const bucket = (key: string): DayStat => {
    const existing = stats.get(key)
    if (existing) return existing
    const created: DayStat = { moments: 0, events: 0, themes: 0 }
    stats.set(key, created)
    return created
  }

  for (const moment of moments) {
    if (!moment.dayKey || Number.isNaN(parseDayKey(moment.dayKey))) continue
    const stat = bucket(moment.dayKey)
    stat.moments += 1
    stat.events += moment.eventIds.length
  }

  for (const theme of themes) {
    if (!Number.isFinite(theme.tsStart) || !Number.isFinite(theme.tsEnd)) continue
    if (theme.tsEnd < theme.tsStart) continue
    const first = dayStart(theme.tsStart)
    let cursor = first
    for (let i = 0; i < MAX_DAYS_PER_THEME; i += 1) {
      if (cursor > theme.tsEnd) break
      bucket(dayKey(cursor)).themes += 1
      cursor += DAY_MS
    }
  }

  return stats
}
