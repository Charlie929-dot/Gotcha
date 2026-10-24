/**
 * 日历日格热力（方案 §8 日格；纯函数，不碰 DOM）。
 *
 * 口径：
 * - **事件量**（决定颜色深浅）：`graph:global` 的 `dayActivity`，按本地日统计的**全部**
 *   事件数，含还没进时刻的积压——日格要回答的是「这天有多忙」；
 * - 时刻 / 主题：时刻按 `day_key` 计数，主题按 `[tsStart, tsEnd]` 覆盖到这一天计数（tooltip 用）。
 *
 * 连续热力：当天事件 ÷ 满量（`fullScale`，设置抽屉可调，默认 4000＝一天全在用）＝百分比，
 * 百分比映射成同一色相的不透明度（`rgba(79,195,247,α)`），α ∈ [0.06, 0.45]，
 * 中间值走 `ratio^HEAT_GAMMA`（γ<1）抬一下，否则十天里有九天都是「几乎看不见」的浅色。
 */

import { dayKey, dayStart, parseDayKey } from './calendar'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 单个主题最多铺多少天。归纳出的主题区间正常只有几天；万一库里出现
 * 1970 或远期脏时间，按上限截断，避免画日历的时候白跑几百万次循环。
 */
export const MAX_DAYS_PER_THEME = 400

/** 日格满量默认值：一天全在使用约 3–4k 事件（2026-10-25 拍板人口径）。与主进程设置默认值一致。 */
export const DEFAULT_HEAT_FULL_SCALE = 4_000

/** 不透明度区间：再低就看不见，再高会压住日期数字的可读性。 */
export const HEAT_ALPHA_MIN = 0.06
export const HEAT_ALPHA_MAX = 0.45
/** 百分比 → 不透明度的指数（<1 抬中间值） */
export const HEAT_GAMMA = 0.6

export interface DayStat {
  /** 当天采集到的全部事件数（含未成时刻的积压） */
  events: number
  /** 当天时刻数 */
  moments: number
  /** 区间覆盖这一天的主题数 */
  themes: number
}

export interface DayStatTheme {
  tsStart: number
  tsEnd: number
}

export interface DayActivityInput {
  dayKey: string
  events: number
  moments: number
}

/** 某一天是否「有记录」（决定日格是否着色 + tooltip 文案）。 */
export function hasRecord(stat: DayStat | undefined): boolean {
  return stat !== undefined && (stat.events > 0 || stat.moments > 0 || stat.themes > 0)
}

/** 当天事件数占满量的百分比（0–1，超过满量按 1 封顶；满量非法时回退默认）。 */
export function heatRatio(events: number, fullScale: number): number {
  const scale = Number.isFinite(fullScale) && fullScale > 0 ? fullScale : DEFAULT_HEAT_FULL_SCALE
  if (!Number.isFinite(events) || events <= 0) return 0
  return Math.min(1, events / scale)
}

/** 连续热力的不透明度（0＝不着色）；结果保留 3 位小数，避免 DOM 上出现浮点长尾。 */
export function heatAlpha(events: number, fullScale: number): number {
  const ratio = heatRatio(events, fullScale)
  if (ratio <= 0) return 0
  const alpha = HEAT_ALPHA_MIN + (HEAT_ALPHA_MAX - HEAT_ALPHA_MIN) * ratio ** HEAT_GAMMA
  return Math.round(alpha * 1000) / 1000
}

/** 日格 tooltip：无记录只说日期，有记录给「事件（百分比）· 时刻 · 主题」。 */
export function dayTooltip(
  key: string,
  stat: DayStat | undefined,
  fullScale = DEFAULT_HEAT_FULL_SCALE
): string {
  if (!hasRecord(stat) || stat === undefined) return `${key} · 无记录`
  const percent = Math.round(heatRatio(stat.events, fullScale) * 100)
  return `${key} · ${stat.events} 条事件（${percent}%）· ${stat.moments} 个时刻 · ${stat.themes} 个主题`
}

/**
 * 逐日聚合：事件 / 时刻来自主进程的 `dayActivity`，主题由区间铺天。
 * 非法输入（NaN / 空 key / 倒序区间）跳过，不做静默纠正。
 */
export function computeDayStats(
  themes: readonly DayStatTheme[],
  activity: readonly DayActivityInput[]
): Map<string, DayStat> {
  const stats = new Map<string, DayStat>()

  const bucket = (key: string): DayStat => {
    const existing = stats.get(key)
    if (existing) return existing
    const created: DayStat = { events: 0, moments: 0, themes: 0 }
    stats.set(key, created)
    return created
  }

  for (const day of activity) {
    if (!day.dayKey || Number.isNaN(parseDayKey(day.dayKey))) continue
    const stat = bucket(day.dayKey)
    if (Number.isFinite(day.events) && day.events > 0) stat.events += day.events
    if (Number.isFinite(day.moments) && day.moments > 0) stat.moments += day.moments
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
