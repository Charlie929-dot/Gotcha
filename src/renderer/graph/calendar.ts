/**
 * 图谱时间筛选的纯函数（方案 §8；不碰 DOM，可单测）。
 *
 * 语义：
 * - 日期一律用本地日 `yyyy-mm-dd`；`null` 表示「全部」；
 * - 主题按 `[tsStart, tsEnd]` 与任一所选日相交即 focused；
 * - 时刻按 `dayKey` 是否在所选集合内；
 * - 选择可以是不连续的（Ctrl 加减、涂抹），所以集合就是唯一事实源。
 */

export type FocusPreset = 'today' | '3d' | '7d' | '30d' | 'all'

export interface CalendarDay {
  /** 本地日 `yyyy-mm-dd` */
  key: string
  /** 本地零点时间戳 */
  ts: number
  /** 是否属于当前展示月（网格补位用） */
  inMonth: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const MONTH_LABELS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月']

/** 本地日键 `yyyy-mm-dd`。 */
export function dayKey(ts: number): string {
  const date = new Date(ts)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 本地零点时间戳。 */
export function dayStart(ts: number): number {
  const date = new Date(ts)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** `yyyy-mm-dd` → 本地零点时间戳；非法输入返回 NaN。 */
export function parseDayKey(key: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return Number.NaN
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return Number.NaN
  }
  return date.getTime()
}

/** 目标月向前/后移动 `delta` 个月。 */
export function shiftMonth(
  year: number,
  monthIndex: number,
  delta: number
): { year: number; month: number } {
  const date = new Date(year, monthIndex + delta, 1)
  return { year: date.getFullYear(), month: date.getMonth() }
}

/**
 * 某月的日历网格：周一开头、6 行 × 7 列（42 格），相邻月日期补位。
 */
export function monthGrid(year: number, monthIndex: number): CalendarDay[] {
  const first = new Date(year, monthIndex, 1)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = new Date(year, monthIndex, 1 - mondayOffset)
  const days: CalendarDay[] = []
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    days.push({
      key: dayKey(date.getTime()),
      ts: date.getTime(),
      inMonth: date.getMonth() === monthIndex && date.getFullYear() === year,
    })
  }
  return days
}

export function monthTitle(year: number, monthIndex: number): string {
  return `${year} 年 ${MONTH_LABELS[monthIndex] ?? `${monthIndex + 1} 月`}`
}

/** 快捷范围：`all` 返回 `null`（不筛）；其余包含今天在内向前数。 */
export function presetDays(now: number, preset: FocusPreset): Set<string> | null {
  if (preset === 'all') return null
  const count = preset === 'today' ? 1 : preset === '3d' ? 3 : preset === '7d' ? 7 : 30
  const today = dayStart(now)
  const days = new Set<string>()
  for (let i = 0; i < count; i += 1) {
    days.add(dayKey(today - i * DAY_MS))
  }
  return days
}

export type DayEditMode = 'toggle' | 'add' | 'remove' | 'replace'

/** 对选择集做一次编辑；返回新集合（不修改入参）。 */
export function editDaySelection(
  current: Set<string> | null,
  key: string,
  mode: DayEditMode
): Set<string> | null {
  // 从「全部」（null）开始做单选/加减时，都先落到「只有这一天」的选择上再编辑。
  if (current === null && mode !== 'remove') return new Set([key])
  const base = current === null ? new Set<string>() : new Set(current)
  switch (mode) {
    case 'replace':
      return new Set([key])
    case 'add':
      base.add(key)
      return base
    case 'remove':
      base.delete(key)
      return base
    case 'toggle':
      if (base.has(key)) base.delete(key)
      else base.add(key)
      return base
  }
}

/** 连续日期范围（含端点）；端点顺序无关。 */
export function dayRange(fromKey: string, toKey: string): Set<string> {
  const from = parseDayKey(fromKey)
  const to = parseDayKey(toKey)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return new Set()
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const days = new Set<string>()
  for (let ts = lo; ts <= hi; ts += DAY_MS) {
    days.add(dayKey(ts))
  }
  return days
}

/** 主题活跃区间是否与所选日相交；`null` 表示全部通过。 */
export function themeMatchesDays(
  tsStart: number,
  tsEnd: number,
  days: Set<string> | null
): boolean {
  if (days === null) return true
  const start = Number.isFinite(tsStart) ? tsStart : 0
  const end = Number.isFinite(tsEnd) ? tsEnd : start
  for (const key of days) {
    const day = parseDayKey(key)
    if (!Number.isFinite(day)) continue
    if (start <= day + DAY_MS - 1 && end >= day) return true
  }
  return false
}

/** 时刻是否落在所选日；`null` 表示全部通过。 */
export function momentMatchesDays(
  key: string,
  days: Set<string> | null
): boolean {
  return days === null || days.has(key)
}

/** 工具栏标签：全部 / 单日 / 连续范围 / N 天。 */
export function formatDayLabel(days: Set<string> | null): string {
  if (days === null) return '全部'
  if (days.size === 0) return '未选日期'
  const sorted = [...days].sort()
  if (sorted.length === 1) return sorted[0]
  const start = parseDayKey(sorted[0])
  const end = parseDayKey(sorted[sorted.length - 1])
  const contiguous = Number.isFinite(start) && Number.isFinite(end) && end - start === (sorted.length - 1) * DAY_MS
  return contiguous ? `${sorted[0]} ~ ${sorted[sorted.length - 1]}` : `${sorted.length} 天（不连续）`
}
