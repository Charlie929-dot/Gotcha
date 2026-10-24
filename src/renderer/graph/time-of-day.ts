/**
 * 时间筛选里的「时段」（一天内的起止时分）纯逻辑；不碰 DOM，可单测。
 *
 * 语义（2026-10-24 拍板修订）：
 * - 日历负责选**哪天**（保留单日 / 涂抹 / Ctrl 加减 / Shift 扩展 / 快捷范围）；
 * - 时段滚轮负责选**每天内的哪一段**（起时:分 → 止时:分），默认 00:00–23:59＝全天；
 * - 两者相乘得到若干「时间窗」：`days × [fromMinute, toMinute]`；
 * - 主题按 `[tsStart, tsEnd]` 与任一时间窗相交即点亮；时刻按 `ts` 是否落在任一窗内。
 *
 * 为什么不把时段并进日期选择：日历是「哪天」的多选集合，时段是每日常量偏移，
 * 两者语义独立；保留日历才能继续用涂抹选一段连续日期。
 */

import { parseDayKey } from './calendar'

/** 一天内的闭区间，单位＝分钟（0–1439）。 */
export interface ClockRange {
  fromMinute: number
  toMinute: number
}

/** 00:00–23:59：不限制一天内的时刻。 */
export const ALL_DAY: ClockRange = { fromMinute: 0, toMinute: 23 * 60 + 59 }

/** 时间窗：本地 epoch ms 的闭区间。 */
export interface ClockWindow {
  start: number
  end: number
}

const MINUTE_MS = 60_000

function clampMinute(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1439, Math.max(0, Math.trunc(value)))
}

/** 归一化：夹到 0–1439；起 > 止 时交换（用户说的就是「这段时间」）。 */
export function normalizeClock(fromMinute: number, toMinute: number): ClockRange {
  const from = clampMinute(fromMinute, 0)
  const to = clampMinute(toMinute, 1439)
  return from > to ? { fromMinute: to, toMinute: from } : { fromMinute: from, toMinute: to }
}

/** 是否覆盖整天（00:00–23:59）。 */
export function isAllDay(clock: ClockRange): boolean {
  return clock.fromMinute === ALL_DAY.fromMinute && clock.toMinute === ALL_DAY.toMinute
}

/** `HH:mm`；非法值按 00:00 处理。 */
export function formatClock(minute: number): string {
  const value = clampMinute(minute, 0)
  const hh = String(Math.floor(value / 60)).padStart(2, '0')
  const mm = String(value % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 工具栏 / 弹层标签：`全天` / `09:00–18:00`。 */
export function formatClockRange(clock: ClockRange): string {
  return isAllDay(clock)
    ? '全天'
    : `${formatClock(clock.fromMinute)}–${formatClock(clock.toMinute)}`
}

/** 本地时刻 → 当天第几分钟。 */
export function clockOf(ts: number): number {
  const date = new Date(ts)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 所选日期 × 时段 → 时间窗（按日升序）；`days === null` 返回空数组（不筛）。
 * 止点取该分钟的最后一毫秒，`23:59` 才能覆盖到 23:59:59.999。
 */
export function clockWindows(days: Set<string> | null, clock: ClockRange): ClockWindow[] {
  if (days === null) return []
  const windows: ClockWindow[] = []
  for (const key of [...days].sort()) {
    const base = parseDayKey(key)
    if (!Number.isFinite(base)) continue
    windows.push({
      start: base + clock.fromMinute * MINUTE_MS,
      end: base + clock.toMinute * MINUTE_MS + MINUTE_MS - 1
    })
  }
  return windows
}

/** 某时刻是否落在任一时间窗内（闭区间）。 */
export function momentInWindows(ts: number, windows: readonly ClockWindow[]): boolean {
  if (!Number.isFinite(ts)) return false
  return windows.some((window) => ts >= window.start && ts <= window.end)
}

/** `[start, end]` 是否与任一时间窗相交（闭区间）。 */
export function windowsOverlap(
  start: number,
  end: number,
  windows: readonly ClockWindow[]
): boolean {
  const head = Number.isFinite(start) ? start : 0
  const tail = Number.isFinite(end) ? end : head
  const lo = Math.min(head, tail)
  const hi = Math.max(head, tail)
  return windows.some((window) => window.start <= hi && window.end >= lo)
}

/**
 * 检索接口只有 `fromTs/toTs` 一个连续窗：取最早一天起 + 最晚一天止。
 * 不连续多选（Ctrl 加减）时，中间的未选日也会落进检索窗——这是已知近似，
 * 图谱调暗仍按逐日时间窗精确执行。
 */
export function windowSpan(
  days: Set<string> | null,
  clock: ClockRange
): { fromTs: number; toTs: number } | null {
  if (days === null || days.size === 0) return null
  const keys = [...days].sort()
  const first = parseDayKey(keys[0])
  const last = parseDayKey(keys[keys.length - 1])
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null
  return {
    fromTs: first + clock.fromMinute * MINUTE_MS,
    toTs: last + clock.toMinute * MINUTE_MS + MINUTE_MS - 1
  }
}

/** 滚轮列滚动位置 → 选中序号（四舍五入并夹紧）。 */
export function columnIndex(scrollTop: number, itemHeight: number, count: number): number {
  if (count <= 0 || !Number.isFinite(itemHeight) || itemHeight <= 0) return 0
  const raw = Math.round((Number.isFinite(scrollTop) ? scrollTop : 0) / itemHeight)
  return Math.min(count - 1, Math.max(0, raw))
}

/** 选中序号 → 列应滚动到的位置。 */
export function columnScrollTop(index: number, itemHeight: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, Math.trunc(index))) * itemHeight
}
