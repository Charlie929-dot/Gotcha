/**
 * SQLite 打开 / 迁移 / events 读写（m1a-plan §3 Phase 1）
 *
 * - 打开 → WAL（文件库）→ 迁移前备份（security.md：迁移前必须可回滚）→ 跑迁移 → 返回实例；
 * - 库文件：`userData/memory.db`（m1a-plan §2；security.md 暂定名）；
 * - 备份名：`memory.db.bak.<yyyy-MM-dd-HHmmss>`（已在 .gitignore，不进仓库）；
 * - 时间线查询 ts 区间为**闭区间** [from, to]，按 ts 升序、同 ts 按 id 升序。
 */

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
 * - better-sqlite3 的 `wal_checkpoint(TRUNCATE)` 在被占用时**不抛错**，而是返回
 *   `[{ busy: 1, checkpointed: 0 }]`（PR #23 复审实测）；因此必须检查返回值，
 *   busy 时中止迁移——否则备份缺 WAL 里的已提交数据，回滚不成立；
 * - 备份失败 / checkpoint 未完成都中止启动（宁可启动失败，也不在无备份的情况下改用户库）。
 */
function backupBeforeMigration(db: Db, filePath: string): string {
  const checkpoint = (db.pragma('wal_checkpoint(TRUNCATE)') ?? []) as Array<{
    busy?: number
    checkpointed?: number
    log?: number
  }>
  // busy=1 表示 WAL 未截断，但已提交帧可能都进了主库（checkpointed == log），此时整文件复制是完整的；
  // 只有 checkpointed < log 才说明有已提交数据还在 WAL 里，复制主库会丢数据 → 中止迁移。
  const incomplete = checkpoint.some(
    (row) =>
      typeof row.log === 'number' && typeof row.checkpointed === 'number' && row.checkpointed < row.log
  )
  if (incomplete) {
    throw new Error(
      `迁移前 WAL checkpoint 未完成（数据库被占用）：${filePath}；请关闭占用该库的进程后重试`
    )
  }
  const backupPath = `${filePath}.bak.${backupStamp()}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

/** 迁移备份保留份数（性能方案 P0-4：历史 5 份 235 MB 一直没人清） */
export const MIGRATION_BACKUP_KEEP = 2

/** 文件名里的时间戳（与 `backupStamp()` 同形），按字符串排序即按时间排序 */
const BACKUP_FILE_PATTERN = '^%BASE%\\.bak\\.(\\d{8}-\\d{6})$'

/**
 * 迁移备份轮转：只保留最近 `keep` 份，其余删除。
 *
 * 只动「同目录 + 同库名 + 严格时间戳后缀」的文件；删不掉（被占用 / 没权限）只计入
 * `failed`，绝不因为清理失败影响启动。
 */
export function pruneMigrationBackups(
  filePath: string,
  keep: number = MIGRATION_BACKUP_KEEP
): { removed: number; failed: number } {
  if (filePath === ':memory:') return { removed: 0, failed: 0 }
  const dir = dirname(filePath)
  const base = basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(BACKUP_FILE_PATTERN.replace('%BASE%', base))
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { removed: 0, failed: 0 }
  }
  const stamped = entries
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .sort((a, b) => b.match[1].localeCompare(a.match[1]))
  let removed = 0
  let failed = 0
  for (const item of stamped.slice(Math.max(0, keep))) {
    try {
      rmSync(join(dir, item.name), { force: true })
      removed++
    } catch {
      failed++
    }
  }
  return { removed, failed }
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

  try {
    if (existed && getSchemaVersion(db) < LATEST_SCHEMA_VERSION) {
      backupBeforeMigration(db, filePath)
    }
    applyMigrations(db)
    if (isFile) {
      // 备份轮转：迁移成功之后才清旧备份（失败时保底要留着它们）
      try {
        pruneMigrationBackups(filePath)
      } catch {
        // 清理失败不影响启动；下次打开还会再试
      }
    }
  } catch (error) {
    // 迁移失败必须释放句柄（Windows 上不 close 会让用户无法用 .bak 覆盖恢复，EBUSY）
    db.close()
    throw error
  }
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
