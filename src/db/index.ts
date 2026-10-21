/**
 * SQLite 打开 / 迁移 / events 读写（m1a-plan §3 Phase 1）
 *
 * - 打开 → WAL（文件库）→ 跑迁移 → 返回实例；测试传 `:memory:`。
 * - 库文件：`userData/memory.db`（m1a-plan §2；security.md 暂定名）。
 * - 时间线查询 ts 区间为**闭区间** [from, to]，按 ts 升序、同 ts 按 id 升序。
 */

import Database from 'better-sqlite3'
import { applyMigrations } from './migrations'

export type Db = Database.Database

/** 库文件名（m1a-plan §2 定稿名） */
export const DB_FILE_NAME = 'memory.db'

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

/** 打开库并迁移到最新版本。文件库开 WAL（采集高频小写入）。 */
export function openDatabase(filePath: string): Db {
  const db = new Database(filePath)
  if (filePath !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('busy_timeout = 5000')
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
