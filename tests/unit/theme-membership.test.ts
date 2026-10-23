import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { backfillAllMoments } from '../../src/understand/moments'
import {
  backfillThemeMemberships,
  countOrphanMoments,
  readEventMomentMap,
  readMembershipStats
} from '../../src/understand/theme-membership'

function at(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 9, 22, hour, minute, second, 0).getTime()
}

interface SeedNode {
  id: number
  level?: number
  sourceEvents?: string | null
}

function seedNode(db: Db, node: SeedNode): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events, meta_json)
     VALUES (?, ?, 'knowledge', ?, '', ?, ?, ?, NULL)`
  ).run(
    node.id,
    node.level ?? 1,
    `主题 ${node.id}`,
    at(9),
    at(10),
    node.sourceEvents ?? '[]'
  )
}

describe('backfillThemeMemberships', () => {
  it('把 source_events 映射成时刻归属（owner），共享时刻可多归属', () => {
    const db = openDatabase(':memory:')
    try {
      // 事件 1、2 → 时刻 A（同 app+标题相邻）；事件 3 → 时刻 B
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      insertEvent(db, { ts: at(9, 0, 30), app: 'Code', windowTitle: 'a.ts' })
      insertEvent(db, { ts: at(11), app: 'Chrome', windowTitle: 'docs' })
      backfillAllMoments(db, { now: 1 })

      seedNode(db, { id: 1, sourceEvents: JSON.stringify([1, 2]) })
      seedNode(db, { id: 2, sourceEvents: JSON.stringify([2, 3]) })
      seedNode(db, { id: 3, sourceEvents: JSON.stringify([99]) })
      seedNode(db, { id: 4, level: 2, sourceEvents: JSON.stringify([1]) })

      const result = backfillThemeMemberships(db, { now: 2 })
      expect(result.themes).toBe(3) // level=2 不参与
      expect(result.inserted).toBe(3)
      expect(result.existing).toBe(0)
      expect(result.missingEventIds).toEqual([99])
      expect(result.missingEventCount).toBe(1)
      expect(result.orphanMoments).toBe(0)

      const rows = db
        .prepare('SELECT theme_id, moment_id, weight, source FROM theme_moments ORDER BY theme_id, moment_id')
        .all() as Array<{ theme_id: number; moment_id: number; weight: number; source: string }>
      const momentRows = db
        .prepare('SELECT id, start_ts FROM moments ORDER BY start_ts ASC')
        .all() as Array<{ id: number; start_ts: number }>
      expect(momentRows.map((row) => row.start_ts)).toEqual([at(9), at(11)])
      const [momentA, momentB] = momentRows.map((row) => row.id)
      expect(rows).toEqual([
        { theme_id: 1, moment_id: momentA, weight: 1, source: 'owner' },
        { theme_id: 2, moment_id: momentA, weight: 1, source: 'owner' },
        { theme_id: 2, moment_id: momentB, weight: 1, source: 'owner' }
      ])
    } finally {
      db.close()
    }
  })

  it('重复执行幂等：只补新增，不重复写', () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      backfillAllMoments(db, { now: 1 })
      seedNode(db, { id: 1, sourceEvents: JSON.stringify([1]) })

      const first = backfillThemeMemberships(db, { now: 2 })
      expect(first.inserted).toBe(1)
      const second = backfillThemeMemberships(db, { now: 3 })
      expect(second.inserted).toBe(0)
      expect(second.existing).toBe(1)

      expect(readMembershipStats(db)).toEqual({
        rows: 1,
        owner: 1,
        secondary: 0,
        themes: 1,
        moments: 1
      })
    } finally {
      db.close()
    }
  })

  it('统计悬空时刻与事件→时刻映射', () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      insertEvent(db, { ts: at(11), app: 'Chrome', windowTitle: 'docs' })
      backfillAllMoments(db, { now: 1 })
      seedNode(db, { id: 1, sourceEvents: JSON.stringify([1]) })

      backfillThemeMemberships(db, { now: 2 })
      expect(countOrphanMoments(db)).toBe(1)

      const map = readEventMomentMap(db)
      expect([...map.keys()].sort((a, b) => a - b)).toEqual([1, 2])
      expect(new Set(map.values()).size).toBe(2)
    } finally {
      db.close()
    }
  })
})
