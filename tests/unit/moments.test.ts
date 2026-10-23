import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { mergeMoments, type BatchEvent } from '../../src/understand/cloud/batch'
import {
  backfillAllMoments,
  backfillMomentsForDay,
  groupMoments,
  localDayKey,
  MOMENT_OCR_SUMMARY_MAX,
  type MomentEvent
} from '../../src/understand/moments'
import { nextLocalDayStart, startOfLocalDay } from '../../src/understand/cloud/batch'

function at(day: number, hour: number, minute = 0, second = 0): number {
  return new Date(2026, 9, day, hour, minute, second, 0).getTime()
}

function evt(id: number, ts: number, app = 'Code', title: string | null = 'a.ts', ocr: string | null = ''): MomentEvent {
  return { id, ts, app, window_title: title, ocr_text: ocr, sensitive: 0 }
}

function seed(db: Db, events: readonly { ts: number; app?: string; title?: string; ocr?: string }[]): void {
  for (const event of events) {
    insertEvent(db, {
      ts: event.ts,
      app: event.app ?? 'Code',
      windowTitle: event.title ?? 'a.ts',
      ocrText: event.ocr ?? ''
    })
  }
}

describe('groupMoments', () => {
  it('同 app+标题且相邻 ≤90s 合并，超时/换 app 收束；OCR 去重', () => {
    const t = at(22, 9)
    const groups = groupMoments([
      evt(1, t, 'Code', 'a.ts', 'hello'),
      evt(2, t + 30_000, 'Code', 'a.ts', 'hello'),
      evt(3, t + 60_000, 'Code', 'a.ts', 'world'),
      evt(4, t + 200_000, 'Code', 'a.ts', 'later'),
      evt(5, t + 201_000, 'Chrome', 'docs', 'browser')
    ])

    expect(groups).toHaveLength(3)
    expect(groups[0].eventIds).toEqual([1, 2, 3])
    expect(groups[0].startTs).toBe(t)
    expect(groups[0].endTs).toBe(t + 60_000)
    expect(groups[0].ocrSummary).toBe('hello / world')
    expect(groups[1].eventIds).toEqual([4])
    expect(groups[2].eventIds).toEqual([5])
    expect(groups[2].app).toBe('Chrome')
  })

  it('不跨本地日：23:59 与 00:00 即使间隔 20s 也分成两个时刻', () => {
    const before = at(22, 23, 59, 40)
    const after = at(23, 0, 0, 20)
    const groups = groupMoments([evt(1, before), evt(2, after)])
    expect(groups).toHaveLength(2)
    expect(groups[0].dayKey).toBe(localDayKey(before))
    expect(groups[1].dayKey).toBe(localDayKey(after))
    expect(groups[0].dayKey).not.toBe(groups[1].dayKey)
  })

  it('OCR 摘要去重后截断到上限', () => {
    const t = at(22, 9)
    const long = 'x'.repeat(MOMENT_OCR_SUMMARY_MAX + 50)
    const groups = groupMoments([evt(1, t, 'Code', 'a.ts', long), evt(2, t + 1_000, 'Code', 'a.ts', long)])
    expect(groups).toHaveLength(1)
    expect(groups[0].ocrSummary).toHaveLength(MOMENT_OCR_SUMMARY_MAX)
  })

  it('与归纳取批 mergeMoments 的分组口径一致（同日、无批量上限）', () => {
    const t = at(22, 9)
    const events = [
      evt(1, t, 'Code', 'a.ts', 'one'),
      evt(2, t + 10_000, 'Code', 'a.ts', 'two'),
      evt(3, t + 120_000, 'Code', 'a.ts', 'three'),
      evt(4, t + 130_000, 'Code', 'b.ts', 'four'),
      evt(5, t + 140_000, 'Chrome', 'b.ts', 'five'),
      evt(6, t + 141_000, 'chrome ', 'b.ts', 'six')
    ]
    const batch = mergeMoments(events as BatchEvent[], {
      maxMoments: 1_000,
      maxEventIdsPerMoment: 1_000,
      maxEventIds: 100_000
    })
    const groups = groupMoments(events)
    expect(
      groups.map((group) => [group.app, group.title, group.startTs, group.endTs, group.eventIds])
    ).toEqual(
      batch.moments.map((moment) => [
        moment.app,
        moment.title,
        moment.startTs,
        moment.endTs,
        moment.eventIds
      ])
    )
  })
})

describe('backfillMoments', () => {
  it('按本地日写入 moments，重复执行只补新增（幂等）', () => {
    const db = openDatabase(':memory:')
    try {
      seed(db, [
        { ts: at(22, 9, 0) },
        { ts: at(22, 9, 0, 30) },
        { ts: at(22, 11, 0) },
        { ts: at(23, 8, 0) }
      ])

      const first = backfillAllMoments(db, { now: 1_000 })
      expect(first.days).toBe(2)
      expect(first.events).toBe(4)
      expect(first.created).toBe(3)
      expect(first.existing).toBe(0)
      expect(first.truncated).toBe(false)

      const rows = db
        .prepare('SELECT day_key, start_ts, end_ts, event_ids FROM moments ORDER BY start_ts ASC')
        .all() as Array<{ day_key: string; start_ts: number; end_ts: number; event_ids: string }>
      expect(rows.map((row) => row.day_key)).toEqual([localDayKey(at(22, 9)), localDayKey(at(22, 11)), localDayKey(at(23, 8))])
      expect(JSON.parse(rows[0].event_ids)).toEqual([1, 2])
      expect(rows[0].end_ts).toBe(at(22, 9, 0, 30))

      const second = backfillAllMoments(db, { now: 2_000 })
      expect(second.created).toBe(0)
      expect(second.existing).toBe(3)
      expect(db.prepare('SELECT COUNT(*) AS n FROM moments').get()).toEqual({ n: 3 })

      // 追加新事件后再跑：只补这一天的新时刻
      seed(db, [{ ts: at(22, 15, 0) }])
      const third = backfillAllMoments(db, { now: 3_000 })
      expect(third.created).toBe(1)
      expect(third.existing).toBe(3)
    } finally {
      db.close()
    }
  })

  it('backfillMomentsForDay 用左闭右开区间，不重复计入次日 00:00', () => {
    const db = openDatabase(':memory:')
    try {
      const dayStart = startOfLocalDay(at(22, 12))
      seed(db, [{ ts: at(22, 23, 59) }, { ts: at(23, 0, 0) }])
      const day = backfillMomentsForDay(db, dayStart, nextLocalDayStart(dayStart), { now: 1 })
      expect(day.dayKey).toBe(localDayKey(dayStart))
      expect(day.events).toBe(1)
      expect(day.created).toBe(1)
    } finally {
      db.close()
    }
  })

  it('空库回填返回全 0', () => {
    const db = openDatabase(':memory:')
    try {
      expect(backfillAllMoments(db)).toEqual({
        days: 0,
        events: 0,
        created: 0,
        existing: 0,
        truncated: false
      })
    } finally {
      db.close()
    }
  })
})
