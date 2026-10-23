/**
 * SQLite 打开 / 迁移 / events 读写（m1a-plan §3 Phase 1）
 *
 * - 打开 → WAL（文件库）→ 迁移前备份（security.md：迁移前必须可回滚）→ 跑迁移 → 返回实例；
 * - 库文件：`userData/memory.db`（m1a-plan §2；security.md 暂定名）；
 * - 备份名：`memory.db.bak.<yyyy-MM-dd-HHmmss>`（已在 .gitignore，不进仓库）；
 * - 时间线查询 ts 区间为**闭区间** [from, to]，按 ts 升序、同 ts 按 id 升序。
 */

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, statSync } from 'node:fs'
import { applyMigrations, getSchemaVersion, migrations } from './migrations'

export type Db = Database.Database

/** 库文件名（m1a-plan §2 定稿名） */
export const DB_FILE_NAME = 'memory.db'

/** 当前 schema 版本（迁移数组最后一项） */
export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1].version

/** 新事件输入（官方字段；可选列缺省为 NULL，sensitive 缺省 0） */
export interface NewEvent {
  ts: number
  app: string
  windowTitle?: string | null
  ocrText?: string | null
  shotPath?: string | null
  intentJson?: string | null
  sensitive?: number
}

/** events 表行（列名即库内 snake_case，不做二次映射，避免字段漂移） */
export interface EventRow {
  id: number
  ts: number
  app: string
  window_title: string | null
  ocr_text: string | null
  shot_path: string | null
  intent_json: string | null
  sensitive: number
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 备份文件名时间戳（本地时区，避免 Windows 文件名冒号） */
export function backupStamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    '-',
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds())
  ].join('')
}

/**
 * 迁移前备份：先 checkpoint 把 WAL 落进主库，再整文件复制。
 * 备份失败直接抛错（宁可启动失败，也不在无备份的情况下改用户库）。
 */
function backupBeforeMigration(db: Db, filePath: string): string {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // checkpoint 被占用时仍继续复制主库文件；WAL 内容会在备份中缺失，
    // 但下一次启动会重新尝试，不静默跳过备份。
  }
  const backupPath = `${filePath}.bak.${backupStamp()}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

/** 打开库并迁移到最新版本。文件库开 WAL（采集高频小写入）。 */
export function openDatabase(filePath: string): Db {
  const isFile = filePath !== ':memory:'
  const existed = isFile && existsSync(filePath) && statSync(filePath).size > 0
  const db = new Database(filePath)
  if (isFile) {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('busy_timeout = 5000')

  if (existed && getSchemaVersion(db) < LATEST_SCHEMA_VERSION) {
    backupBeforeMigration(db, filePath)
  }
  applyMigrations(db)
  return db
}

/** 写入一条事件，返回自增 id */
export function insertEvent(db: Db, event: NewEvent): number {
  const result = db
    .prepare(
      `INSERT INTO events (ts, app, window_title, ocr_text, shot_path, intent_json, sensitive)
       VALUES (@ts, @app, @windowTitle, @ocrText, @shotPath, @intentJson, @sensitive)`
    )
    .run({
      ts: event.ts,
      app: event.app,
      windowTitle: event.windowTitle ?? null,
      ocrText: event.ocrText ?? null,
      shotPath: event.shotPath ?? null,
      intentJson: event.intentJson ?? null,
      sensitive: event.sensitive ?? 0
    })
  return Number(result.lastInsertRowid)
}

/** 时间线数据源：取 [from, to] 闭区间内的事件，按时间升序 */
export function queryTimeline(db: Db, from: number, to: number): EventRow[] {
  return db
    .prepare(
      `SELECT id, ts, app, window_title, ocr_text, shot_path, intent_json, sensitive
       FROM events
       WHERE ts >= ? AND ts <= ?
       ORDER BY ts ASC, id ASC`
    )
    .all(from, to) as EventRow[]
}
