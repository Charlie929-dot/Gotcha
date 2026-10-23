/**
 * 迁移前备份（security.md「破坏性操作」；审查 finding：迁移无备份）
 *
 * 只在「已存在的文件库 + schema 落后」时备份；新库 / 已最新库不产生备份。
 */

import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION, openDatabase } from '../../src/db'
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
          expect(backup.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
          expect(
            backup.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes'").get()
          ).toBeUndefined()
        } finally {
          backup.close()
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

  it(':memory: 库不备份', () => {
    const db = openDatabase(':memory:')
    try {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })
})
