/**
 * 迁移前备份（security.md「破坏性操作」；审查 finding：迁移无备份）
 *
 * 只在「已存在的文件库 + schema 落后」时备份；新库 / 已最新库不产生备份。
 */

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION, openDatabase, pruneMigrationBackups } from '../../src/db'
import { applyMigrations, getSchemaVersion, revertMigrations } from '../../src/db/migrations'

function backups(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.db.bak.'))
}

describe('openDatabase · 迁移前自动备份', () => {
  it('v1 文件库升级到 v2 前备份；备份含原数据且不含新表，迁移后新表就位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-backup-'))
    const file = join(dir, 'memory.db')
    try {
      const seed = new Database(file)
      applyMigrations(seed)
      revertMigrations(seed, 1)
      expect(getSchemaVersion(seed)).toBe(1)
      seed.prepare("INSERT INTO events (ts, app) VALUES (1, 'notepad')").run()
      seed.close()

      const db = openDatabase(file)
      try {
        expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
        const files = backups(dir)
        expect(files).toHaveLength(1)

        const backup = new Database(join(dir, files[0]), { readonly: true })
        try {
          expect(getSchemaVersion(backup)).toBe(1)
          expect(backup.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
          expect(
            backup.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes'").get()
          ).toBeUndefined()
        } finally {
          backup.close()
        }

        // 恢复演练：把备份复制回一个新库并升级，原有事件不丢
        const restoredPath = join(dir, 'restored.db')
        copyFileSync(join(dir, files[0]), restoredPath)
        const restored = openDatabase(restoredPath)
        try {
          expect(restored.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
          expect(
            restored.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes'").get()
          ).toBeTruthy()
        } finally {
          restored.close()
        }

        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes'").get()
        ).toBeTruthy()
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('新库首次创建不备份；已是最新版本再次打开也不备份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-backup-fresh-'))
    try {
      const fresh = openDatabase(join(dir, 'fresh.db'))
      fresh.close()
      expect(backups(dir)).toHaveLength(0)

      const again = openDatabase(join(dir, 'fresh.db'))
      again.close()
      expect(backups(dir)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('WAL 有已提交数据且 checkpoint 不完整（其它连接持旧快照）时中止迁移，不产出不完整备份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-backup-busy-'))
    const file = join(dir, 'memory.db')
    const writer = new Database(file)
    const reader = new Database(file)
    try {
      applyMigrations(writer)
      revertMigrations(writer, 1)
      writer.pragma('journal_mode = WAL')
      writer.prepare("INSERT INTO events (ts, app) VALUES (1, 'before-snapshot')").run()

      // 读者拿旧快照：之后写入的帧无法被 checkpoint 到主库
      reader.pragma('busy_timeout = 5000')
      reader.exec('BEGIN')
      reader.prepare('SELECT COUNT(*) FROM events').get()
      writer.prepare("INSERT INTO events (ts, app) VALUES (2, 'after-snapshot')").run()

      // checkpoint 5s 后被占用 → checkpointed < log → 必须中止启动（备份会是残缺的）
      expect(() => openDatabase(file)).toThrow(/checkpoint 未完成/)
      expect(backups(dir)).toHaveLength(0)
    } finally {
      try {
        reader.exec('ROLLBACK')
      } finally {
        reader.close()
        writer.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 15_000)

  it(':memory: 库不备份', () => {
    const db = openDatabase(':memory:')
    try {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('迁移备份轮转：只保留最近 2 份，非备份文件一律不动（P0-4）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-backup-prune-'))
    const file = join(dir, 'memory.db')
    try {
      openDatabase(file).close()
      for (const stamp of ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000']) {
        writeFileSync(`${file}.bak.${stamp}`, 'x')
      }
      writeFileSync(join(dir, 'memory.db.bak.not-a-stamp'), 'keep')
      writeFileSync(join(dir, 'other.db.bak.20260101-000000'), 'keep')

      expect(pruneMigrationBackups(file)).toEqual({ removed: 2, failed: 0 })
      const kept = readdirSync(dir)
        .filter((name) => /^memory\.db\.bak\.\d{8}-\d{6}$/.test(name))
        .sort()
      expect(kept).toEqual(['memory.db.bak.20260103-000000', 'memory.db.bak.20260104-000000'])
      expect(existsSync(join(dir, 'memory.db.bak.not-a-stamp'))).toBe(true)
      expect(existsSync(join(dir, 'other.db.bak.20260101-000000'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
