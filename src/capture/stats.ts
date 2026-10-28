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
  /** 临时帧删除失败次数（残留由下次启动的受控清理兜底，F06） */
  temp_delete_failed: number
  /**
   * 判重前移的观测点（2026-10-28 性能方案 §4.4）：
   * `encode_count` = 真正编码 / 落盘的帧数（应 ≈ frames_total - frames_same），
   * `encode_ms` 是这些帧的编码 + 写盘累计耗时，`write_bytes` 是临时帧落盘字节。
   * 三者缺省 0（老库里没有这三个键也照常读出来）。
   */
  encode_count: number
  encode_ms: number
  write_bytes: number
  /**
   * 旧管线降级为「仅元数据」（P0-2）时写入的事件数：
   * 只记 app / title，不截帧、不 OCR。正常抓帧模式下恒为 0。
   */
  metadata_events: number
}

export function zeroStats(): CaptureStats {
  return {
    frames_total: 0,
    frames_same: 0,
    ocr_runs: 0,
    queue_dropped: 0,
    capture_errors: 0,
    temp_delete_failed: 0,
    encode_count: 0,
    encode_ms: 0,
    write_bytes: 0,
    metadata_events: 0
  }
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

/** 计数器宿主（CapturePipeline 实现；单测可注入假实现） */
export interface StatsCounter {
  getStats(): CaptureStats
  /** 跨午夜换 key 时清零当日累计 */
  resetStats(): void
}

export interface DailyStatsFlusher {
  /** 当前累计归属的日期 key（排查 / 断言用） */
  readonly key: string
  /** 落盘一次；跨午夜先落旧 key，再清零换新 key */
  flush(): void
}

export interface DailyStatsFlusherDeps {
  db: Db
  counter: StatsCounter
  now(): number
  /** 启动时的 key，通常与首次 loadStats 用的一致；默认 statsKey(now()) */
  key?: string
}

/**
 * 每日 stats 落盘（gotchas「stats 跨午夜归属漂移」）
 *
 * 计数器是进程内累计、每 60s 落盘；若 00:00 后直接换新 key 写同一份累计，
 * 前一天的数会整份复制到新一天。这里在 flush 时比较日期 key：变了就先把
 * 旧 key 落盘、清零，再用新 key 继续。边界误差 ≤ 一轮 flush 间隔（60s）：
 * 跨日后的这几帧仍算进旧 key，新 key 从 0 起算。
 */
export function createDailyStatsFlusher(deps: DailyStatsFlusherDeps): DailyStatsFlusher {
  let key = deps.key ?? statsKey(deps.now())
  return {
    get key() {
      return key
    },
    flush() {
      const currentKey = statsKey(deps.now())
      if (currentKey !== key) {
        saveStats(deps.db, key, deps.counter.getStats())
        deps.counter.resetStats()
        key = currentKey
      }
      saveStats(deps.db, key, deps.counter.getStats())
    }
  }
}
