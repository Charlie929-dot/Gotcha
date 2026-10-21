/**
 * settings 读写（m1a-plan §2：一切自定义项进 settings 表，不建新表）
 */

import type { Db } from './index'

export const SETTING_DEFAULTS: Readonly<Record<string, string>> = {
  'capture.diff_threshold': '8',
  'capture.save_shots': '0'
}

export function getSetting(db: Db, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? SETTING_DEFAULTS[key] ?? ''
}

export function getNumberSetting(db: Db, key: string, fallback = 0): number {
  const parsed = Number(getSetting(db, key))
  return Number.isFinite(parsed) ? parsed : fallback
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}
