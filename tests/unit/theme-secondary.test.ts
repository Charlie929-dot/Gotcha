import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/db'
import {
  applySecondaryMemberships,
  planSecondaryMemberships
} from '../../src/understand/theme-secondary'

function vec(values: readonly number[]): Float32Array {
  return Float32Array.from(values)
}

describe('planSecondaryMemberships', () => {
  it('排除主归属、近重复与 protected；按 sim 取前 max 个', () => {
    const themes = [
      { id: 1, type: 'knowledge', vec: vec([1, 0]) }, // owner
      { id: 2, type: 'knowledge', vec: vec([0.9, 0.4359]) }, // 近重复（sim 0.9）
      { id: 3, type: 'knowledge', vec: vec([0.6, 0.8]) }, // 0.6
      { id: 4, type: 'activity', vec: vec([0.8, 0.6]) }, // 0.8
      { id: 5, type: 'protected', vec: vec([1, 0]) }
    ]
    const moments = [{ id: 10, vec: vec([1, 0]) }]
    const owners = new Map([[10, [1]]])

    const plans = planSecondaryMemberships(moments, themes, owners, {
      minSim: 0.55,
      duplicateSim: 0.85,
      max: 2
    })
    // 2 是 1 的近重复 → 排除；3、4 相似度 0.6/0.8 → 取 4 再 3
    expect(plans.map((plan) => plan.themeId)).toEqual([4, 3])
    expect(plans[0].sim).toBeCloseTo(0.8, 3)
  })

  it('无主归属 / 无向量的时刻不参与；上限为 0 时返回空', () => {
    const themes = [{ id: 1, type: 'knowledge', vec: vec([1, 0]) }]
    const moments = [{ id: 10, vec: vec([1, 0]) }]
    expect(
      planSecondaryMemberships(moments, themes, new Map(), { minSim: 0.5, duplicateSim: 0.9, max: 2 })
    ).toEqual([])
    expect(
      planSecondaryMemberships(moments, themes, new Map([[10, [1]]]), {
        minSim: 0.5,
        duplicateSim: 0.9,
        max: 0
      })
    ).toEqual([])
  })
})

describe('applySecondaryMemberships', () => {
  function seed(db: Db): void {
    db.prepare(
      `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
       VALUES (1, 1, 'knowledge', '主题一', '', 1, 2, '[1]'),
              (2, 1, 'knowledge', '主题二', '', 1, 2, '[]')`
    ).run()
    db.prepare(
      `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
       VALUES (10, 1, 2, '2026-10-22', 'Code', 'a', '', '[1]', 1),
              (11, 3, 4, '2026-10-22', 'Code', 'b', '', '[2]', 1)`
    ).run()
    db.prepare(
      `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
       VALUES (1, 10, 1.0, 'owner', 1),
              (2, 10, 1.0, 'secondary', 1),
              (1, 11, 1.0, 'manual', 1)`
    ).run()
  }

  it('幂等：重复跑不重复写；过时次归属被删；owner/manual 不动', () => {
    const db = openDatabase(':memory:')
    try {
      seed(db)
      const plans = [
        { momentId: 10, themeId: 2, sim: 0.8 },
        { momentId: 10, themeId: 1, sim: 0.99 } // 与 owner 冲突 → IGNORE
      ]
      const first = applySecondaryMemberships(db, plans, [10, 11], { now: 50 })
      expect(first.planned).toBe(2)
      expect(first.inserted).toBe(0) // 2 已存在；1 是 owner 冲突被忽略
      expect(first.removed).toBe(0)
      expect(first.moments).toBe(2)

      const second = applySecondaryMemberships(db, plans, [10, 11], { now: 60 })
      expect(second.inserted).toBe(0)
      expect(second.removed).toBe(0)

      // 计划不再包含 2 → 删掉旧的次归属
      const third = applySecondaryMemberships(db, [], [10, 11], { now: 70 })
      expect(third.removed).toBe(1)

      const rows = db
        .prepare('SELECT theme_id, moment_id, source FROM theme_moments ORDER BY moment_id, source')
        .all()
      expect(rows).toEqual([
        { theme_id: 1, moment_id: 10, source: 'owner' },
        { theme_id: 1, moment_id: 11, source: 'manual' }
      ])
    } finally {
      db.close()
    }
  })

  it('插入新的次归属；无主归属/manual 的残留次归属被清理', () => {
    const db = openDatabase(':memory:')
    try {
      seed(db)
      // 时刻 12 没有任何归属，却残留了一条次归属（历史脏数据）
      db.prepare(
        `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
         VALUES (12, 5, 6, '2026-10-22', 'Code', 'c', '', '[3]', 1)`
      ).run()
      db.prepare(
        `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
         VALUES (2, 12, 1.0, 'secondary', 1)`
      ).run()
      const result = applySecondaryMemberships(
        db,
        [{ momentId: 11, themeId: 2, sim: 0.9 }],
        [11, 12],
        { now: 80 }
      )
      expect(result.inserted).toBe(1)
      expect(result.removed).toBe(1)
      const rows = db
        .prepare('SELECT theme_id, moment_id, source FROM theme_moments ORDER BY moment_id, source')
        .all()
      expect(rows).toEqual([
        { theme_id: 1, moment_id: 10, source: 'owner' },
        { theme_id: 2, moment_id: 10, source: 'secondary' },
        { theme_id: 1, moment_id: 11, source: 'manual' },
        { theme_id: 2, moment_id: 11, source: 'secondary' }
      ])
    } finally {
      db.close()
    }
  })
})
