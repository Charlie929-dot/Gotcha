import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  getSchemaVersion,
  migrations,
  revertMigrations
} from '../../src/db/migrations'

const LATEST = migrations[migrations.length - 1].version

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

/** 表的列名（v6 这类 ALTER 加列的迁移用） */
function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (row) => row.name
  )
}

describe('migrations · :memory: 库', () => {
  it('全新库从 0 迁到最新版本，重复执行幂等且数据保留', () => {
    const db = new Database(':memory:')
    try {
      expect(getSchemaVersion(db)).toBe(0)
      expect(applyMigrations(db)).toBe(LATEST)
      expect(LATEST).toBe(6)

      db.prepare("INSERT INTO events (ts, app) VALUES (1, 'notepad')").run()
      // 第二次跑同一套迁移：不应抛错、版本不倒退、已有数据不丢
      expect(applyMigrations(db)).toBe(LATEST)
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
      // v3：时刻层 + 多归属 + 向量/位置
      expect(names).toContain('moments')
      expect(names).toContain('theme_moments')
      expect(names).toContain('node_embeddings')
      expect(names).toContain('node_positions')
      expect(names).toContain('idx_moments_day')
      expect(names).toContain('idx_theme_moments_moment')
      // v4：合并审计 + 事件向量 + 主题质心 + nodes.merged_into
      expect(names).toContain('node_merges')
      expect(names).toContain('event_embeddings')
      expect(names).toContain('theme_centroids')
      expect(names).toContain('idx_node_merges_group')
      expect(names).toContain('idx_node_merges_from')
      expect(names).toContain('idx_node_merges_into')
      expect(names).toContain('idx_nodes_merged_into')
      const nodeColumns = (
        db.prepare("PRAGMA table_info('nodes')").all() as Array<{ name: string }>
      ).map((row) => row.name)
      expect(nodeColumns).toContain('merged_into')
      // v6：派生向量的重算指纹（只加列，老行 NULL → 下次维护自愈）
      expect(columnNames(db, 'node_embeddings')).toContain('text_hash')
      expect(columnNames(db, 'theme_centroids')).toContain('members_hash')
      // v5：检索索引（trigram FTS + 触发器同步）
      expect(names).toContain('events_fts')
      expect(names).toContain('events_fts_ai')
      expect(names).toContain('events_fts_ad')
      expect(names).toContain('events_fts_au')

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
      expect(afterDown).not.toContain('moments')
      expect(afterDown).not.toContain('theme_moments')
      expect(afterDown).not.toContain('node_embeddings')
      expect(afterDown).not.toContain('node_positions')
      expect(afterDown).not.toContain('node_merges')
      expect(afterDown).not.toContain('event_embeddings')
      expect(afterDown).not.toContain('theme_centroids')
      expect(afterDown).not.toContain('events_fts')
      expect(afterDown).not.toContain('events_fts_ai')
      expect(afterDown).not.toContain('events_fts_ad')
      expect(afterDown).not.toContain('events_fts_au')

      expect(applyMigrations(db)).toBe(LATEST)
      expect(structureSnapshot(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('v3 只回滚时刻层：回退到 v2 保留 nodes/edges 与数据', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      db.prepare("INSERT INTO events (ts, app) VALUES (1, 'notepad')").run()
      db.prepare(
        `INSERT INTO nodes (level, type, title, summary, ts_start, ts_end, source_events)
         VALUES (1, 'knowledge', '测试节点', '摘要', 1, 2, '[1]')`
      ).run()
      db.prepare(
        "INSERT INTO edges (src, dst, weight, kind, evidence) VALUES (1, 1, 0.5, 'ai', '同批')"
      ).run()

      revertMigrations(db, 2)
      expect(getSchemaVersion(db)).toBe(2)
      const names = structureSnapshot(db).map((r) => r.name)
      expect(names).toContain('events')
      expect(names).toContain('nodes')
      expect(names).toContain('edges')
      expect(names).not.toContain('moments')
      expect(names).not.toContain('theme_moments')
      expect(names).not.toContain('node_embeddings')
      expect(names).not.toContain('node_positions')
      expect(names).not.toContain('node_merges')
      expect(names).not.toContain('event_embeddings')
      expect(names).not.toContain('theme_centroids')
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 1 })

      // 再迁回 v3：时刻层重建为空表，nodes/edges 数据仍在
      expect(applyMigrations(db)).toBe(LATEST)
      expect(db.prepare('SELECT COUNT(*) AS n FROM moments').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 1 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 1 })
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

      // 再迁回最新版本：图谱表重建为空表，events 数据仍在
      expect(applyMigrations(db)).toBe(LATEST)
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('v5 迁移把已有事件回填进检索索引（归一化后连续中文可命中），触发器接管增量写入', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      revertMigrations(db, 4)
      expect(getSchemaVersion(db)).toBe(4)
      expect(structureSnapshot(db).map((row) => row.name)).not.toContain('events_fts')

      // 库里已有的 L0 事件（OCR 是逐字带空格的原文）
      db.prepare("INSERT INTO events (ts, app, ocr_text) VALUES (1, 'Code', '改 按 钮 样 式')").run()
      db.prepare("INSERT INTO events (ts, app, ocr_text) VALUES (2, 'Chrome', '查 API 用法')").run()

      expect(applyMigrations(db)).toBe(LATEST)
      expect(db.prepare('SELECT rowid, ocr_text FROM events_fts ORDER BY rowid').all()).toEqual([
        { rowid: 1, ocr_text: '改按钮样式' },
        { rowid: 2, ocr_text: '查API用法' }
      ])
      expect(
        db
          .prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH '\"按钮样式\"' ORDER BY rowid")
          .all()
      ).toEqual([{ rowid: 1 }])

      // 触发器接管之后的增量写入 / 删除
      db.prepare("INSERT INTO events (ts, app, ocr_text) VALUES (3, 'Code', '新 增 事 件')").run()
      expect(
        db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH '\"新增事件\"'").all()
      ).toEqual([{ rowid: 3 }])
      db.prepare('DELETE FROM events WHERE id = 3').run()
      expect(
        db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH '\"新增事件\"'").all()
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  it('v6 只回滚指纹列：检索索引与已有行都保留，重 up 后列回来（老行 NULL）', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      db.prepare("INSERT INTO nodes (id, level, title, summary) VALUES (1, 1, '主题', '摘要')").run()
      db.prepare(
        `INSERT INTO node_embeddings (node_id, model, dim, vec, updated_at, text_hash)
         VALUES (1, 'fake', 2, x'0000803f0000803f', 7, 'abc')`
      ).run()
      db.prepare(
        `INSERT INTO theme_centroids (node_id, model, dim, vec, member_events, updated_at, members_hash)
         VALUES (1, 'fake', 2, x'0000803f0000803f', 3, 7, 'def')`
      ).run()

      revertMigrations(db, 5)
      expect(getSchemaVersion(db)).toBe(5)
      expect(columnNames(db, 'node_embeddings')).not.toContain('text_hash')
      expect(columnNames(db, 'theme_centroids')).not.toContain('members_hash')
      // 只丢列，行与数据都还在；v5 的检索索引不受影响
      expect(db.prepare('SELECT COUNT(*) AS n FROM node_embeddings').get()).toEqual({ n: 1 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM theme_centroids').get()).toEqual({ n: 1 })
      expect(structureSnapshot(db).map((row) => row.name)).toContain('events_fts')

      expect(applyMigrations(db)).toBe(LATEST)
      expect(columnNames(db, 'node_embeddings')).toContain('text_hash')
      expect(columnNames(db, 'theme_centroids')).toContain('members_hash')
      // 老行的指纹是 NULL（下一次增量维护会重算一次补上）
      expect(db.prepare('SELECT text_hash FROM node_embeddings WHERE node_id = 1').get()).toEqual({
        text_hash: null
      })
      expect(db.prepare('SELECT members_hash FROM theme_centroids WHERE node_id = 1').get()).toEqual({
        members_hash: null
      })
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
