import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { writeThemeVectors } from '../../src/understand/graph-edges'
import { backfillAllMoments } from '../../src/understand/moments'
import { backfillThemeMemberships } from '../../src/understand/theme-membership'
import { writeThemeCentroids } from '../../src/understand/theme-centroids'
import { applyThemeMerges, revertThemeMerge } from '../../src/understand/theme-merge'

function at(hour: number, minute = 0): number {
  return new Date(2026, 9, 22, hour, minute, 0, 0).getTime()
}

function seedTheme(
  db: Db,
  id: number,
  options: {
    title?: string
    summary?: string
    tsStart?: number
    tsEnd?: number
    sourceEvents?: number[]
    type?: string
  } = {}
): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    options.type ?? 'knowledge',
    options.title ?? `主题 ${id}`,
    options.summary ?? '',
    options.tsStart ?? at(9),
    options.tsEnd ?? at(10),
    JSON.stringify(options.sourceEvents ?? [])
  )
}

/** 事件 1,2 → 时刻 A；事件 3 → 时刻 B；事件 4 → 时刻 C */
function seedBase(db: Db): void {
  insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts', ocrText: '一' })
  insertEvent(db, { ts: at(9, 1), app: 'Code', windowTitle: 'a.ts', ocrText: '二' })
  insertEvent(db, { ts: at(11), app: 'Chrome', windowTitle: 'docs', ocrText: '三' })
  insertEvent(db, { ts: at(13), app: 'Word', windowTitle: 'doc', ocrText: '四' })
  backfillAllMoments(db, { now: 1 })
}

function momentIds(db: Db): number[] {
  return (db.prepare('SELECT id FROM moments ORDER BY start_ts ASC').all() as Array<{ id: number }>).map(
    (row) => row.id
  )
}

function membershipRows(db: Db): Array<{ theme_id: number; moment_id: number; weight: number; source: string }> {
  return db
    .prepare('SELECT theme_id, moment_id, weight, source FROM theme_moments ORDER BY theme_id, moment_id')
    .all() as Array<{ theme_id: number; moment_id: number; weight: number; source: string }>
}

function seedSideTables(db: Db): void {
  writeThemeVectors(
    db,
    [
      { nodeId: 1, vec: Float32Array.from([1, 0]) },
      { nodeId: 2, vec: Float32Array.from([0.9, 0.1]) }
    ],
    { model: 'fake', dim: 2, now: 1 }
  )
  writeThemeCentroids(
    db,
    [
      { nodeId: 1, vec: Float32Array.from([1, 0]), memberEvents: 2 },
      { nodeId: 2, vec: Float32Array.from([1, 0]), memberEvents: 2 }
    ],
    { model: 'fake', now: 1 }
  )
  db.prepare("INSERT INTO node_positions (node_id, x, y, updated_at) VALUES (1, 10, 20, 1), (2, 30, 40, 1)").run()
  db.prepare(
    "INSERT INTO edges (src, dst, weight, kind, evidence) VALUES (1, 2, 0.95, 'embedding', '{}'), (2, 3, 0.5, 'ai', '旧')"
  ).run()
}

describe('applyThemeMerges', () => {
  it('并集归属/事件/时间、摘要取长，源节点标记 merged_into 且不清空向量表以外的数据', () => {
    const db = openDatabase(':memory:')
    try {
      seedBase(db)
      seedTheme(db, 1, {
        title: '主题一',
        summary: '短摘要',
        tsStart: at(9),
        tsEnd: at(10),
        sourceEvents: [1, 3]
      })
      seedTheme(db, 2, {
        title: '主题二',
        summary: '更长的摘要内容',
        tsStart: at(12),
        tsEnd: at(14),
        sourceEvents: [1, 2, 4]
      })
      seedTheme(db, 3, { type: 'activity', sourceEvents: [4] })
      backfillThemeMemberships(db, { now: 2 })
      seedSideTables(db)

      const report = applyThemeMerges(db, [{ into: 1, from: [2], reason: '测试合并' }], { now: 100 })
      expect(report.applied).toBe(1)
      expect(report.mergedNodes).toBe(1)
      expect(report.touched).toEqual([1, 2])

      const into = db
        .prepare('SELECT title, summary, ts_start, ts_end, source_events, merged_into FROM nodes WHERE id = 1')
        .get() as {
        title: string
        summary: string
        ts_start: number
        ts_end: number
        source_events: string
        merged_into: number | null
      }
      expect(into.title).toBe('主题一')
      expect(into.summary).toBe('更长的摘要内容')
      expect(into.ts_start).toBe(at(9))
      expect(into.ts_end).toBe(at(14))
      expect(JSON.parse(into.source_events)).toEqual([1, 2, 3, 4])
      expect(into.merged_into).toBeNull()

      const from = db.prepare('SELECT merged_into FROM nodes WHERE id = 2').get() as {
        merged_into: number | null
      }
      expect(from.merged_into).toBe(1)

      const [momentA] = momentIds(db)
      // 时刻 A 两个主题都持有：并集只保留 into 一条（origin 仍是 owner）
      const rows = membershipRows(db)
      expect(rows).toContainEqual({ theme_id: 1, moment_id: momentA, weight: 1, source: 'owner' })
      expect(rows.filter((row) => row.theme_id === 2)).toEqual([])

      // 合并审计：一行、group_id = id
      const audit = db.prepare('SELECT * FROM node_merges').all() as Array<{
        id: number
        group_id: number
        from_node: number
        into_node: number
        reason: string
        before_json: string
        reverted_at: number | null
      }>
      expect(audit).toHaveLength(1)
      expect(audit[0].group_id).toBe(audit[0].id)
      expect(audit[0].from_node).toBe(2)
      expect(audit[0].into_node).toBe(1)
      expect(audit[0].reason).toBe('测试合并')
      expect(JSON.parse(audit[0].before_json).version).toBe(1)

      // 向量/质心/位置/embedding 边：受影响节点被清；旧 ai 边不动
      const edgeRows = db.prepare('SELECT src, dst, kind FROM edges ORDER BY kind').all()
      expect(edgeRows).toEqual([{ src: 2, dst: 3, kind: 'ai' }])
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM node_embeddings WHERE node_id IN (1, 2)').get()
      ).toEqual({ n: 0 })
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM theme_centroids WHERE node_id IN (1, 2)').get()
      ).toEqual({ n: 0 })
      expect(db.prepare('SELECT node_id FROM node_positions ORDER BY node_id').all()).toEqual([
        { node_id: 1 }
      ])
    } finally {
      db.close()
    }
  })

  it('重复计划 / 类型不一致 / 节点不存在时跳过，不抛错', () => {
    const db = openDatabase(':memory:')
    try {
      seedBase(db)
      seedTheme(db, 1, { sourceEvents: [1] })
      seedTheme(db, 2, { sourceEvents: [3] })
      seedTheme(db, 3, { type: 'activity', sourceEvents: [4] })
      backfillThemeMemberships(db, { now: 2 })

      const report = applyThemeMerges(
        db,
        [
          { into: 1, from: [3], reason: '类型不一致' },
          { into: 1, from: [99], reason: '不存在' },
          { into: 2, from: [2], reason: '自己并自己' },
          { into: 1, from: [2], reason: '正常' },
          { into: 1, from: [2], reason: '重复' }
        ],
        { now: 3 }
      )
      expect(report.applied).toBe(1)
      expect(report.skipped).toBe(4)
      expect(db.prepare('SELECT COUNT(*) AS n FROM node_merges').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })
})

describe('revertThemeMerge', () => {
  function mergedDb(): { db: Db; groupId: number } {
    const db = openDatabase(':memory:')
    seedBase(db)
    seedTheme(db, 1, {
      title: '主题一',
      summary: '短摘要',
      tsStart: at(9),
      tsEnd: at(10),
      sourceEvents: [1, 3]
    })
    seedTheme(db, 2, {
      title: '主题二',
      summary: '更长的摘要内容',
      tsStart: at(12),
      tsEnd: at(14),
      sourceEvents: [1, 2, 4]
    })
    backfillThemeMemberships(db, { now: 2 })
    seedSideTables(db)
    const report = applyThemeMerges(db, [{ into: 1, from: [2], reason: '测试合并' }], { now: 100 })
    return { db, groupId: report.merges[0].groupId }
  }

  it('撤销后恢复两个节点的字段与归属（含冲突时刻），再次撤销被拒绝', () => {
    const { db, groupId } = mergedDb()
    try {
      const [momentA] = momentIds(db)
      const result = revertThemeMerge(db, groupId, { now: 200 })
      expect(result.ok).toBe(true)

      const node1 = db
        .prepare('SELECT title, summary, ts_start, ts_end, source_events FROM nodes WHERE id = 1')
        .get()
      expect(node1).toEqual({
        title: '主题一',
        summary: '短摘要',
        ts_start: at(9),
        ts_end: at(10),
        source_events: '[1,3]'
      })
      const node2 = db
        .prepare('SELECT summary, ts_start, ts_end, source_events, merged_into FROM nodes WHERE id = 2')
        .get()
      expect(node2).toEqual({
        summary: '更长的摘要内容',
        ts_start: at(12),
        ts_end: at(14),
        source_events: '[1,2,4]',
        merged_into: null
      })

      const rows = membershipRows(db)
      expect(rows).toContainEqual({ theme_id: 1, moment_id: momentA, weight: 1, source: 'owner' })
      expect(rows).toContainEqual({ theme_id: 2, moment_id: momentA, weight: 1, source: 'owner' })

      const audit = db.prepare('SELECT reverted_at FROM node_merges WHERE group_id = ?').get(groupId) as {
        reverted_at: number | null
      }
      expect(audit.reverted_at).toBe(200)

      expect(revertThemeMerge(db, groupId, { now: 300 })).toEqual({
        ok: false,
        reason: 'already-reverted'
      })
    } finally {
      db.close()
    }
  })

  it('目标节点后来又被合并且未撤销时拒绝回滚', () => {
    const { db, groupId } = mergedDb()
    try {
      // 模拟一次更新的合并（直接写审计行，只验证守卫）
      db.prepare(
        `INSERT INTO node_merges (group_id, from_node, into_node, merged_at, reason, before_json, reverted_at)
         VALUES (7, 3, 1, 500, '更新', '{"version":1,"into":{},"from":{}}', NULL)`
      ).run()
      expect(revertThemeMerge(db, groupId, { now: 600 })).toEqual({
        ok: false,
        reason: 'has-newer-merges'
      })
    } finally {
      db.close()
    }
  })

  it('坏快照 / 不存在时如实返回', () => {
    const { db, groupId } = mergedDb()
    try {
      expect(revertThemeMerge(db, 999)).toEqual({ ok: false, reason: 'not-found' })
      db.prepare('UPDATE node_merges SET before_json = ? WHERE group_id = ?').run('{broken', groupId)
      expect(revertThemeMerge(db, groupId)).toEqual({ ok: false, reason: 'bad-snapshot' })
    } finally {
      db.close()
    }
  })
})
