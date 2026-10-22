import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import {
  createDailyStatsFlusher,
  loadStats,
  saveStats,
  statsKey,
  zeroStats,
  type CaptureStats
} from '../../src/capture/stats'

interface FakeCounter {
  stats: CaptureStats
  getStats(): CaptureStats
  resetStats(): void
}

/** 与 CapturePipeline 同形状的计数器；用例直接改 stats 字段模拟采集 */
function fakeCounter(): FakeCounter {
  const stats = zeroStats()
  return {
    stats,
    getStats: () => ({ ...stats }),
    resetStats: () => Object.assign(stats, zeroStats())
  }
}

describe('stats · 日期 key 与每日落盘', () => {
  it('statsKey 用本地日期，月/日补零', () => {
    expect(statsKey(new Date(2026, 9, 21, 23, 59, 59).getTime())).toBe('stats.day.2026-10-21')
    expect(statsKey(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe('stats.day.2026-01-01')
    expect(statsKey(new Date(2026, 11, 31, 12, 0, 0).getTime())).toBe('stats.day.2026-12-31')
  })

  it('同一天多次 flush：只累计、不清零', () => {
    const db: Db = openDatabase(':memory:')
    try {
      let clock = new Date(2026, 9, 21, 10, 0, 0).getTime()
      const counter = fakeCounter()
      const flusher = createDailyStatsFlusher({ db, counter, now: () => clock })

      counter.stats.frames_total = 3
      flusher.flush()
      counter.stats.frames_total = 7
      clock += 60_000
      flusher.flush()

      expect(loadStats(db, 'stats.day.2026-10-21')).toMatchObject({ frames_total: 7 })
      expect(flusher.key).toBe('stats.day.2026-10-21')
    } finally {
      db.close()
    }
  })

  it('跨午夜 flush：新 key 从 0 起算，旧 key 不被新一天覆盖', () => {
    const db: Db = openDatabase(':memory:')
    try {
      let clock = new Date(2026, 9, 21, 23, 30, 0).getTime()
      const counter = fakeCounter()
      const flusher = createDailyStatsFlusher({
        db,
        counter,
        now: () => clock,
        key: 'stats.day.2026-10-21'
      })

      counter.stats.frames_total = 100
      counter.stats.capture_errors = 2
      flusher.flush()
      expect(loadStats(db, 'stats.day.2026-10-21')).toMatchObject({
        frames_total: 100,
        capture_errors: 2
      })

      // 00:00 后再采 5 帧还没 flush：跨日边界这 5 帧按旧 key 落盘（误差 ≤60s）
      clock = new Date(2026, 9, 22, 0, 0, 30).getTime()
      counter.stats.frames_total = 105
      flusher.flush()

      expect(flusher.key).toBe('stats.day.2026-10-22')
      expect(loadStats(db, 'stats.day.2026-10-22')).toEqual(zeroStats())
      expect(counter.stats.frames_total).toBe(0)

      // 之后只累加新一天：旧 key 保持跨日时刻的累计，不再被覆盖
      counter.stats.frames_total = 5
      clock = new Date(2026, 9, 22, 1, 0, 0).getTime()
      flusher.flush()

      expect(loadStats(db, 'stats.day.2026-10-22')).toMatchObject({ frames_total: 5 })
      expect(loadStats(db, 'stats.day.2026-10-21')).toMatchObject({
        frames_total: 105,
        capture_errors: 2
      })
    } finally {
      db.close()
    }
  })

  it('loadStats 对缺失或损坏的 key 返回全 0', () => {
    const db: Db = openDatabase(':memory:')
    try {
      expect(loadStats(db, 'stats.day.2026-10-21')).toEqual(zeroStats())
      setSetting(db, 'stats.day.2026-10-21', '{not json')
      expect(loadStats(db, 'stats.day.2026-10-21')).toEqual(zeroStats())
      saveStats(db, 'stats.day.2026-10-21', { ...zeroStats(), ocr_runs: 4 })
      expect(loadStats(db, 'stats.day.2026-10-21')).toMatchObject({ ocr_runs: 4 })
    } finally {
      db.close()
    }
  })
})
