/**
 * 时间线纯逻辑（renderer 可单测）：日期分组 / 时间格式 / OCR 摘要
 */

import type { EventRow } from '../db'

export function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 某一天的闭区间 [from, to] */
export function dayRange(dayStart: number): { from: number; to: number } {
  const from = startOfDay(dayStart)
  const next = new Date(from)
  next.setDate(next.getDate() + 1)
  return { from, to: next.getTime() - 1 }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 行首时间：HH:mm */
export function formatTime(ts: number): string {
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 日期标题：2026-10-21 周三 */
export function formatDate(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${WEEKDAYS[date.getDay()]}`
}

/** OCR 摘要：压缩空白、截断到 max 字（默认 80，m1a-plan §3 Phase 3） */
export function summary(text: string | null, max = 80): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max)}…`
}

export interface DayGroup {
  date: string
  rows: EventRow[]
}

/** 按本地日期分组（输入已按 ts 升序时保持顺序） */
export function groupByDay(rows: EventRow[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const row of rows) {
    const date = formatDate(row.ts).slice(0, 10)
    const last = groups[groups.length - 1]
    if (last && last.date === date) {
      last.rows.push(row)
    } else {
      groups.push({ date, rows: [row] })
    }
  }
  return groups
}
