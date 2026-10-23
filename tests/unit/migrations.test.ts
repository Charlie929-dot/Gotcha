import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  getSchemaVersion,
  migrations,
  revertMigrations
} from '../../src/db/migrations'

interface MasterRow {
  type: string
  name: string
  sql: string | null
}

/** 结构快照：表/索引的 DDL 原文，用来断言 down→up 后结构一致 */
function structureSnapshot(db: Database.Database): MasterRow[] {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    )
    .all() as MasterRow[]
}

describe('migrations · :memory: 库', () => {
  it('全新库从 0 迁到 v2，重复执行幂等且数据保留', () => {
    const db = new Database(':memory:')
    try {
      expect(getSchemaVersion(db)).toBe(0)
      expect(applyMigrations(db)).toBe(2)

      db.prepare("INSERT INTO events (ts, app) VALUES (1, 'notepad')").run()
      // 第二次跑同一套迁移：不应抛错、版本不倒退、已有数据不丢
      expect(applyMigrations(db)).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('down 回 0 后重 up，结构快照与首次完全一致', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      const before = structureSnapshot(db)
      const names = before.map((r) => r.name)
      expect(names).toContain('events')
      expect(names).toContain('settings')
      expect(names).toContain('nodes')
      expect(names).toContain('edges')
      expect(names).toContain('idx_events_ts')
      expect(names).toContain('idx_nodes_ts_start')
      expect(names).toContain('idx_nodes_level')
      expect(names).toContain('idx_edges_src')
      expect(names).toContain('idx_edges_dst')

      revertMigrations(db)
      expect(getSchemaVersion(db)).toBe(0)
      const afterDown = structureSnapshot(db).map((r) => r.name)
      expect(afterDown).not.toContain('events')
      expect(afterDown).not.toContain('settings')
      expect(afterDown).not.toContain('nodes')
      expect(afterDown).not.toContain('edges')
      expect(afterDown).not.toContain('idx_events_ts')
      expect(afterDown).not.toContain('idx_nodes_ts_start')
      expect(afterDown).not.toContain('idx_edges_dst')

      expect(applyMigrations(db)).toBe(2)
      expect(structureSnapshot(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('v2 只回滚图谱表：回退到 v1 保留 events / settings 与数据', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      db.prepare("INSERT INTO events (ts, app) VALUES (1, 'notepad')").run()
      db.prepare(
        `INSERT INTO nodes (level, type, title, summary, ts_start, ts_end, source_events)
         VALUES (1, 'knowledge', '测试节点', '摘要', 1, 2, '[1]')`
      ).run()
      const nodeId = Number(
        (db.prepare('SELECT id FROM nodes LIMIT 1').get() as { id: number }).id
      )
      db.prepare(
        `INSERT INTO edges (src, dst, weight, kind, evidence) VALUES (?, ?, 0.5, 'ai', '同批')`
      ).run(nodeId, nodeId)

      revertMigrations(db, 1)
      expect(getSchemaVersion(db)).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
      const names = structureSnapshot(db).map((r) => r.name)
      expect(names).toContain('events')
      expect(names).toContain('settings')
      expect(names).not.toContain('nodes')
      expect(names).not.toContain('edges')

      // 再迁回 v2：图谱表重建为空表，events 数据仍在
      expect(applyMigrations(db)).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('迁移表本身合法：版本号单调递增且每条都有 up/down', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    for (const migration of migrations) {
      expect(typeof migration.up).toBe('function')
      expect(typeof migration.down).toBe('function')
    }
  })
})
