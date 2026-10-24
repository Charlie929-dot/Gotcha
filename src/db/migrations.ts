/**
 * 迁移：schema_version 表 + 迁移数组（m1a-plan §3 Phase 1）
 *
 * 规则：
 * - 每个迁移带 up / down，up 幂等（DDL 用 IF NOT EXISTS），可重复执行；
 * - 版本号单调递增，一次只前进一个版本，事务内完成「迁移 + 版本号推进」；
 * - down 逆序执行，用于回滚与「down 后重 up 结构一致」的回归测试。
 */

import type Database from 'better-sqlite3'
import {
  EDGES_DDL,
  EDGES_DST_INDEX_DDL,
  EDGES_SRC_INDEX_DDL,
  EVENT_EMBEDDINGS_DDL,
  EVENTS_DDL,
  EVENTS_TS_INDEX_DDL,
  MOMENTS_DDL,
  MOMENTS_DAY_INDEX_DDL,
  NODES_DDL,
  NODES_LEVEL_INDEX_DDL,
  NODES_MERGED_INTO_INDEX_DDL,
  NODES_TS_START_INDEX_DDL,
  NODE_EMBEDDINGS_DDL,
  NODE_MERGES_DDL,
  NODE_MERGES_FROM_INDEX_DDL,
  NODE_MERGES_GROUP_INDEX_DDL,
  NODE_MERGES_INTO_INDEX_DDL,
  NODE_POSITIONS_DDL,
  SETTINGS_DDL,
  THEME_CENTROIDS_DDL,
  THEME_MOMENTS_DDL,
  THEME_MOMENTS_MOMENT_INDEX_DDL
} from './schema'

export interface Migration {
  version: number
  up(db: Database.Database): void
  down(db: Database.Database): void
}

export const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(EVENTS_DDL)
      db.exec(EVENTS_TS_INDEX_DDL)
      db.exec(SETTINGS_DDL)
    },
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_events_ts')
      db.exec('DROP TABLE IF EXISTS events')
      db.exec('DROP TABLE IF EXISTS settings')
    }
  },
  {
    version: 2,
    up(db) {
      db.exec(NODES_DDL)
      db.exec(EDGES_DDL)
      db.exec(NODES_TS_START_INDEX_DDL)
      db.exec(NODES_LEVEL_INDEX_DDL)
      db.exec(EDGES_SRC_INDEX_DDL)
      db.exec(EDGES_DST_INDEX_DDL)
    },
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_edges_dst')
      db.exec('DROP INDEX IF EXISTS idx_edges_src')
      db.exec('DROP INDEX IF EXISTS idx_nodes_level')
      db.exec('DROP INDEX IF EXISTS idx_nodes_ts_start')
      db.exec('DROP TABLE IF EXISTS edges')
      db.exec('DROP TABLE IF EXISTS nodes')
    }
  },
  {
    /**
     * v3：时刻层 + 多归属 + 主题向量/位置（docs/m2-graph-redesign.md §4.5）。
     * 只建表与索引；数据回填由 `src/understand/graph-backfill.ts` 另行执行（可重入、不阻塞启动）。
     */
    version: 3,
    up(db) {
      db.exec(MOMENTS_DDL)
      db.exec(MOMENTS_DAY_INDEX_DDL)
      db.exec(THEME_MOMENTS_DDL)
      db.exec(THEME_MOMENTS_MOMENT_INDEX_DDL)
      db.exec(NODE_EMBEDDINGS_DDL)
      db.exec(NODE_POSITIONS_DDL)
    },
    down(db) {
      db.exec('DROP TABLE IF EXISTS node_positions')
      db.exec('DROP TABLE IF EXISTS node_embeddings')
      db.exec('DROP INDEX IF EXISTS idx_theme_moments_moment')
      db.exec('DROP TABLE IF EXISTS theme_moments')
      db.exec('DROP INDEX IF EXISTS idx_moments_day')
      db.exec('DROP TABLE IF EXISTS moments')
    }
  },
  {
    /**
     * v4：主题合并审计 + 事件向量 + 主题质心（docs/m2-graph-redesign.md §5.1）。
     * - `nodes.merged_into` 用 ALTER 加列（带存在性检查，保证 up 可重复执行）；
     * - down 时 DROP COLUMN（SQLite ≥3.35，本项目 3.53）；down→up 后 DDL 文本与首次一致（已实测）。
     */
    version: 4,
    up(db) {
      db.exec(NODE_MERGES_DDL)
      db.exec(NODE_MERGES_GROUP_INDEX_DDL)
      db.exec(NODE_MERGES_FROM_INDEX_DDL)
      db.exec(NODE_MERGES_INTO_INDEX_DDL)
      db.exec(EVENT_EMBEDDINGS_DDL)
      db.exec(THEME_CENTROIDS_DDL)
      if (!hasColumn(db, 'nodes', 'merged_into')) {
        db.exec('ALTER TABLE nodes ADD COLUMN merged_into INTEGER')
      }
      db.exec(NODES_MERGED_INTO_INDEX_DDL)
    },
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_nodes_merged_into')
      if (hasColumn(db, 'nodes', 'merged_into')) {
        db.exec('ALTER TABLE nodes DROP COLUMN merged_into')
      }
      db.exec('DROP TABLE IF EXISTS theme_centroids')
      db.exec('DROP TABLE IF EXISTS event_embeddings')
      db.exec('DROP INDEX IF EXISTS idx_node_merges_into')
      db.exec('DROP INDEX IF EXISTS idx_node_merges_from')
      db.exec('DROP INDEX IF EXISTS idx_node_merges_group')
      db.exec('DROP TABLE IF EXISTS node_merges')
    }
  }
]

/** 列是否存在（ALTER 加列 / 删列前检查，保证迁移 up/down 可重复执行） */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
`

/** 当前 schema 版本；全新库先补版本表并记为 0 */
export function getSchemaVersion(db: Database.Database): number {
  db.exec(SCHEMA_VERSION_DDL)
  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined
  if (row === undefined) {
    db.exec('INSERT INTO schema_version (version) VALUES (0)')
    return 0
  }
  return row.version
}

/** 迁移到最新版本（幂等：已是最新则不做任何事），返回最终版本号 */
export function applyMigrations(db: Database.Database): number {
  // 先确保版本表存在，再 prepare 更新语句
  let current = getSchemaVersion(db)
  const setVersion = db.prepare('UPDATE schema_version SET version = ?')
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db)
      setVersion.run(migration.version)
    })()
  }
  return getSchemaVersion(db)
}

/** 逆序回滚到指定版本（默认回到 0 = 空 schema） */
export function revertMigrations(db: Database.Database, toVersion = 0): void {
  const current = getSchemaVersion(db)
  const setVersion = db.prepare('UPDATE schema_version SET version = ?')
  const reverting = migrations
    .filter((m) => m.version <= current && m.version > toVersion)
    .sort((a, b) => b.version - a.version)

  for (const migration of reverting) {
    const previous = migrations
      .filter((m) => m.version < migration.version)
      .sort((a, b) => b.version - a.version)[0]
    db.transaction(() => {
      migration.down(db)
      setVersion.run(previous?.version ?? 0)
    })()
  }
}
