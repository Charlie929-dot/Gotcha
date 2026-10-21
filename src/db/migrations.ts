/**
 * 迁移：schema_version 表 + 迁移数组（m1a-plan §3 Phase 1）
 *
 * 规则：
 * - 每个迁移带 up / down，up 幂等（DDL 用 IF NOT EXISTS），可重复执行；
 * - 版本号单调递增，一次只前进一个版本，事务内完成「迁移 + 版本号推进」；
 * - down 逆序执行，用于回滚与「down 后重 up 结构一致」的回归测试。
 */

import type Database from 'better-sqlite3'
import { EVENTS_DDL, EVENTS_TS_INDEX_DDL, SETTINGS_DDL } from './schema'

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
  }
]

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
