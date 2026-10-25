import { describe, expect, it, vi } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { createMomentRuntime } from '../../src/main/moment-runtime'
import { backfillMomentsForDay } from '../../src/understand/moments'
import { startOfLocalDay } from '../../src/understand/cloud/batch'

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 9, day, hour, minute, 0, 0).getTime()
}

function seed(db: Db, ts: number, app = 'Code', title = 'a.ts'): void {
  insertEvent(db, { ts, app, windowTitle: title, ocrText: '' })
}

function momentCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM moments').get() as { c: number }).c
}

function makeLog(): { lines: string[]; log: (level: string, msg: string) => void } {
  const lines: string[] = []
  return { lines, log: (level: string, msg: string) => lines.push(`${level}:${msg}`) }
}

describe('moment runtime（S1：采集时本地补时刻）', () => {
  it('稳定的事件补成时刻，水位推进后不重复处理', () => {
    const db = openDatabase(':memory:')
    const now = at(22, 10, 30)
    seed(db, at(22, 10, 5))
    const { log } = makeLog()
    const runtime = createMomentRuntime({ db, log, now: () => now })

    const first = runtime.runOnce()
    expect(first.status).toBe('done')
    expect(first.created).toBe(1)
    expect(first.events).toBe(1)
    expect(momentCount(db)).toBe(1)
    // 水位留在 settle 线之前，给「贴边未收口」的组留出重看窗口
    expect(runtime.watermark()).toBe(now - 180_000 - 90_000)

    const second = runtime.runOnce()
    expect(second.created).toBe(0)
    expect(momentCount(db)).toBe(1)
    db.close()
  })

  it('还在合并窗口里的事件不处理（避免半成品时刻）', () => {
    const db = openDatabase(':memory:')
    const now = at(22, 10, 30)
    seed(db, now - 60_000)
    const { log } = makeLog()
    const runtime = createMomentRuntime({ db, log, now: () => now })

    const result = runtime.runOnce()
    expect(result.created).toBe(0)
    expect(momentCount(db)).toBe(0)

    // 过一会儿窗口关了，同一条事件才成时刻
    const later = createMomentRuntime({ db, log, now: () => now + 10 * 60_000 })
    expect(later.runOnce().created).toBe(1)
    expect(momentCount(db)).toBe(1)
    db.close()
  })

  it('贴到窗口末尾的组留到下一轮，不会被拆成两个时刻', () => {
    const db = openDatabase(':memory:')
    const now = at(22, 10, 30)
    // 10:26:40：过了 3 分钟水位，但距窗口末尾只差 20s < 90s 收口线
    seed(db, now - 200_000)
    const { log } = makeLog()
    const runtime = createMomentRuntime({ db, log, now: () => now })

    const first = runtime.runOnce()
    expect(first.created).toBe(0)
    expect(first.deferred).toBe(1)
    expect(momentCount(db)).toBe(0)

    // 10:27:30 又来一条（相邻 50s，仍属同一组）；晚些再跑，整组一次落库
    seed(db, now - 150_000)
    const later = createMomentRuntime({ db, log, now: () => now + 180_000 })
    const second = later.runOnce()
    expect(second.created).toBe(1)
    expect(momentCount(db)).toBe(1)
    const ids = JSON.parse(
      (db.prepare('SELECT event_ids FROM moments').get() as { event_ids: string }).event_ids
    ) as number[]
    expect(ids).toHaveLength(2)
    db.close()
  })

  it('失败不推进水位，下一轮能补回来', () => {
    const db = openDatabase(':memory:')
    const now = at(22, 10, 30)
    seed(db, at(22, 10, 5))
    const { log, lines } = makeLog()
    let fail = true
    const runtime = createMomentRuntime({
      db,
      log,
      now: () => now,
      backfill: (inner, from, to, options) => {
        if (fail) throw new Error('boom')
        return backfillMomentsForDay(inner, from, to, options)
      }
    })

    const failed = runtime.runOnce()
    expect(failed.status).toBe('skipped')
    expect(failed.reason).toBe('error')
    expect(runtime.watermark()).toBeNull()
    expect(momentCount(db)).toBe(0)
    expect(lines.some((line) => line.includes('moment runtime failed'))).toBe(true)

    fail = false
    expect(runtime.runOnce().created).toBe(1)
    expect(momentCount(db)).toBe(1)
    db.close()
  })

  it('重启后从库里最后一个时刻接着走，不重扫两天', () => {
    const db = openDatabase(':memory:')
    const lastEnd = at(22, 9, 0)
    db.prepare(
      `INSERT INTO moments (start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
       VALUES (?, ?, '2026-10-22', 'Code', 'a.ts', '', '[1]', ?)`
    ).run(lastEnd - 60_000, lastEnd, lastEnd)
    seed(db, lastEnd + 10 * 60_000)
    const { log } = makeLog()
    const now = lastEnd + 20 * 60_000
    const runtime = createMomentRuntime({ db, log, now: () => now })

    const result = runtime.runOnce()
    expect(result.from).toBe(lastEnd)
    expect(result.created).toBe(1)
    db.close()
  })

  it('跨午夜按本地日分段处理', () => {
    const db = openDatabase(':memory:')
    seed(db, at(22, 23, 55))
    seed(db, at(23, 0, 5))
    const { log } = makeLog()
    const calls: number[] = []
    const now = at(23, 0, 20)
    const runtime = createMomentRuntime({
      db,
      log,
      now: () => now,
      maxCatchUpDays: 1,
      backfill: (inner, from, to, options) => {
        calls.push(from)
        return backfillMomentsForDay(inner, from, to, options)
      }
    })

    const result = runtime.runOnce()
    expect(result.days).toBe(2)
    expect(result.created).toBe(2)
    expect(calls).toEqual([startOfLocalDay(at(22, 0)), startOfLocalDay(at(23, 0))])
    db.close()
  })

  it('start 起定时器、stop 清掉；重复 start 不会叠两个', () => {
    const db = openDatabase(':memory:')
    const { log } = makeLog()
    const handles: Array<{ fn: () => void }> = []
    const clear = vi.fn()
    const runtime = createMomentRuntime({
      db,
      log,
      now: () => at(22, 10, 30),
      setInterval: ((fn: () => void) => {
        const handle = { fn }
        handles.push(handle)
        return handle as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: clear as unknown as typeof clearInterval
    })

    runtime.start()
    runtime.start()
    expect(handles).toHaveLength(1)
    runtime.stop()
    expect(clear).toHaveBeenCalledTimes(1)
    runtime.stop()
    expect(clear).toHaveBeenCalledTimes(1)
    db.close()
  })
})
