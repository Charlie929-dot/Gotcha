/**
 * 有效帧率埋点（m1a-plan §2 / A5）
 *
 * 计数器：总帧数 / 帧差通过数 / OCR 执行数 / 队列丢弃数；每日一个 settings 键
 * `stats.day.<yyyy-mm-dd>`（JSON），每 60s 或退出时落盘。
 */

import type { Db } from '../db'
import { setSetting } from '../db/settings'

export interface CaptureStats {
  frames_total: number
  frames_same: number
  ocr_runs: number
  queue_dropped: number
  capture_errors: number
}

export function zeroStats(): CaptureStats {
  return { frames_total: 0, frames_same: 0, ocr_runs: 0, queue_dropped: 0, capture_errors: 0 }
}

/** 本地日期的 settings 键：stats.day.2026-10-21 */
export function statsKey(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `stats.day.${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 读取当日累计；缺失或损坏返回全 0 */
export function loadStats(db: Db, key: string): CaptureStats {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return zeroStats()
  try {
    const parsed = JSON.parse(row.value) as Partial<Record<keyof CaptureStats, unknown>>
    const stats = zeroStats()
    for (const field of Object.keys(stats) as (keyof CaptureStats)[]) {
      const value = parsed[field]
      if (typeof value === 'number' && Number.isFinite(value)) stats[field] = value
    }
    return stats
  } catch {
    return zeroStats()
  }
}

export function saveStats(db: Db, key: string, stats: CaptureStats): void {
  setSetting(db, key, JSON.stringify(stats))
}
