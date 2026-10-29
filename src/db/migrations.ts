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
  EVENTS_FTS_DDL,
  EVENTS_FTS_DELETE_TRIGGER_DDL,
  EVENTS_FTS_INSERT_TRIGGER_DDL,
  EVENTS_FTS_UPDATE_TRIGGER_DDL,
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
  THEME_MOMENTS_MOMENT_INDEX_DDL,
  normalizeOcrSql
} from './schema'
import {
  MEM_ITEMS_DDL,
  MEM_ITEMS_DAY_INDEX_DDL,
  MEM_ITEMS_SOURCE_INDEX_DDL,
  MEM_ITEMS_TS_INDEX_DDL,
  MEM_OBSERVATIONS_DDL,
  MEM_OBSERVATIONS_TOPIC_INDEX_DDL,
  MEM_SOURCES_DDL
} from '../memory/schema'
import {
  decodeEmbeddingVector,
  encodeVectorFloat32,
  encodeVectorInt16
} from '../understand/vector-int16'

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
  },
  {
    /**
     * v5：检索索引（门一 v1 / D31）。
     * - trigram FTS5 + 归一化 OCR 文本（中文词内空格见 `schema.ts` 的实测说明）；
     * - 触发器保证任何写入路径（采集管线、测试直插）都同步索引；
     * - up 末尾整表重建，让已采下的全部 L0 事件 retroactively 可查（幂等：先清后灌）；
     * - 索引是派生数据：down 直接丢表，L0 不受影响。
     */
    version: 5,
    up(db) {
      db.exec(EVENTS_FTS_DDL)
      db.exec(EVENTS_FTS_INSERT_TRIGGER_DDL)
      db.exec(EVENTS_FTS_DELETE_TRIGGER_DDL)
      db.exec(EVENTS_FTS_UPDATE_TRIGGER_DDL)
      db.exec('DELETE FROM events_fts')
      db.exec(
        `INSERT INTO events_fts(rowid, ocr_text)
         SELECT id, ${normalizeOcrSql('ocr_text')} FROM events`
      )
    },
    down(db) {
      db.exec('DROP TRIGGER IF EXISTS events_fts_au')
      db.exec('DROP TRIGGER IF EXISTS events_fts_ad')
      db.exec('DROP TRIGGER IF EXISTS events_fts_ai')
      db.exec('DROP TABLE IF EXISTS events_fts')
    }
  },
  {
    /**
     * v6：派生向量的重算指纹（P2 · S3 增量维护，docs/m2-graph-redesign.md §5.1 / §5.2）。
     * - `node_embeddings.text_hash`：标题 + 摘要的指纹，文本变了才重新推理；
     * - `theme_centroids.members_hash`：参与求均值的去重事件 id 集合指纹，成员变了才重算。
     * 老行是 NULL → 视为「不知道能不能复用」，第一次增量维护各自重算一次后自愈。
     * 都是派生数据：down 直接丢列，L0 事件与归属不受影响。
     */
    version: 6,
    up(db) {
      if (!hasColumn(db, 'node_embeddings', 'text_hash')) {
        db.exec('ALTER TABLE node_embeddings ADD COLUMN text_hash TEXT')
      }
      if (!hasColumn(db, 'theme_centroids', 'members_hash')) {
        db.exec('ALTER TABLE theme_centroids ADD COLUMN members_hash TEXT')
      }
    },
    down(db) {
      if (hasColumn(db, 'theme_centroids', 'members_hash')) {
        db.exec('ALTER TABLE theme_centroids DROP COLUMN members_hash')
      }
      if (hasColumn(db, 'node_embeddings', 'text_hash')) {
        db.exec('ALTER TABLE node_embeddings DROP COLUMN text_hash')
      }
    }
  },
  {
    /**
     * v7：`event_embeddings.vec` 从 Float32 换成 int16（性能方案 §3 P1-3 / §6）。
     *
     * 动因：512 维 Float32 = 2048 B/行，SQLite 4096 页里每行都会溢出到第二页，
     * 实测 15,567 行吃掉 61.0 MB；int16（每行 1028 B）能整行放下，同批数据只要 20.3 MB（≈3×）。
     * 为什么不是 int8：真实库抽样 top-1 最近邻只有 96.7% 一致（近重复向量被量化误差翻盘），
     * int16 是 100%，见 `src/understand/vector-int16.ts` 与 `tests/perf/vector-int8.perf.test.ts`。
     *
     * 幂等：已经是 int16 的行跳过；长度与声明维度对不上的坏行原样不动。
     * 派生数据：down 反量化回 Float32（有轻微精度损失，但结构/可读性恢复），L0 事件不受影响。
     */
    version: 7,
    up(db) {
      rebuildEventEmbeddings(db, (vec) => encodeVectorInt16(vec))
    },
    down(db) {
      rebuildEventEmbeddings(db, (vec) => encodeVectorFloat32(vec))
    }
  },
  {
    /**
     * v8：个人记忆（日记 = 第二本账）。
     *
     * 与屏幕记忆（events）平级：`mem_items` 是日记条目事实源，`mem_sources` 记同步指纹
     * （mtime + size 没变就跳过解析），`mem_observations` 是可重算的「关于我」观测。
     * 三张表都由 `src/memory/store.ts` 读写；down 会丢用户数据，只用于测试回滚。
     */
    version: 8,
    up(db) {
      db.exec(MEM_ITEMS_DDL)
      db.exec(MEM_ITEMS_DAY_INDEX_DDL)
      db.exec(MEM_ITEMS_TS_INDEX_DDL)
      db.exec(MEM_ITEMS_SOURCE_INDEX_DDL)
      db.exec(MEM_SOURCES_DDL)
      db.exec(MEM_OBSERVATIONS_DDL)
      db.exec(MEM_OBSERVATIONS_TOPIC_INDEX_DDL)
    },
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_mem_observations_topic')
      db.exec('DROP TABLE IF EXISTS mem_observations')
      db.exec('DROP TABLE IF EXISTS mem_sources')
      db.exec('DROP INDEX IF EXISTS idx_mem_items_source')
      db.exec('DROP INDEX IF EXISTS idx_mem_items_ts')
      db.exec('DROP INDEX IF EXISTS idx_mem_items_day')
      db.exec('DROP TABLE IF EXISTS mem_items')
    }
  }
]

/**
 * 重建 `event_embeddings`（v7 用）：把每行 BLOB 换成新编码后整表重建。
 *
 * 为什么不是 `UPDATE ... SET vec = ?`：行变小了不会自动回收页，B-tree 仍按原来的
 * 2 KB/行跨页摆放（实测表还是 61 MB）。整表重建一次就能把 1 KB 的行排满页（61 → 20 MB）。
 * 也顺便绕开「VACUUM 不能跑在迁移事务里」的限制。
 *
 * 幂等：编码函数对已经是目标格式的行不重复转换（长度/魔数对得上就原样搬）。
 */
function rebuildEventEmbeddings(
  db: Database.Database,
  encode: (vec: Float32Array) => Buffer
): void {
  const rows = db
    .prepare('SELECT event_id, model, dim, vec, updated_at FROM event_embeddings')
    .all() as Array<{
    event_id: number
    model: string
    dim: number
    vec: Buffer
    updated_at: number
  }>
  db.exec(`CREATE TABLE event_embeddings_rebuild (
    event_id   INTEGER PRIMARY KEY,
    model      TEXT NOT NULL,
    dim        INTEGER NOT NULL,
    vec        BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  const insert = db.prepare(
    `INSERT INTO event_embeddings_rebuild (event_id, model, dim, vec, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  for (const row of rows) {
    const vec = decodeEmbeddingVector(row.vec, row.dim)
    // 长度与声明维度对不上的坏行：原样搬过去，不丢数据
    const blob = vec.length === row.dim && vec.length > 0 ? encode(vec) : row.vec
    insert.run(row.event_id, row.model, row.dim, blob, row.updated_at)
  }
  db.exec('DROP TABLE event_embeddings')
  db.exec('ALTER TABLE event_embeddings_rebuild RENAME TO event_embeddings')
}

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
