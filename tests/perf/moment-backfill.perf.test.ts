/**
 * P1-5：时刻在线补跑的重复读成本（真实库副本）。
 *
 * 现状：`moment-runtime` 每 60s 跑一轮 `backfillMomentsForDay(今天)`，
 * 而 `selectDayEvents` 每次都把当天**所有**事件的 `ocr_text` 拉回内存再分组——
 * 已经成过时刻的事件每分钟被重读一遍正文。
 *
 * 这里量三件事：
 * 1. 当天事件数 / 正文字符数 / 正文字节数（重复读的规模）；
 * 2. 现状 `backfillMomentsForDay` 的冷/热两轮耗时（热轮 = 全部时已存在，仍会整日重读）；
 * 3. 只读元数据（id/ts/app/window_title/sensitive）的扫描耗时——
 *    如果「按需取正文」落地，热轮就只剩这部分。
 *
 * 只读真实库（VACUUM INTO 副本），写入都在副本上；副本用完即删。
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/moment-backfill.perf.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOfLocalDay } from '../../src/understand/cloud/batch'
import { backfillMomentsForDay, MOMENT_MERGE_GAP_MS } from '../../src/understand/moments'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const hasDb = existsSync(dbPath)

function vacuumCopy(): string {
  const copyPath = join(tmpdir(), `gotcha-perf-moments-${process.pid}-${Date.now()}.db`)
  const source = new Database(dbPath, { readonly: true })
  try {
    source.prepare('VACUUM INTO ?').run(copyPath)
  } finally {
    source.close()
  }
  return copyPath
}

function ms(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe.skipIf(!hasDb)('时刻在线补跑（P1-5）', () => {
  it('真实库副本：当天正文重复读的规模与整日重扫耗时', () => {
    const copy = vacuumCopy()
    const db = new Database(copy)
    try {
      const now = Date.now()
      const watermarkMs = 180_000
      const to = now - watermarkMs
      const from = startOfLocalDay(now)

      const stats = db
        .prepare(
          `SELECT COUNT(*) AS n,
                  SUM(LENGTH(ocr_text)) AS chars,
                  SUM(LENGTH(CAST(ocr_text AS BLOB))) AS bytes
             FROM events WHERE ts >= ? AND ts < ?`
        )
        .get(from, to) as { n: number; chars: number | null; bytes: number | null }
      const momentsBefore = (
        db.prepare('SELECT COUNT(*) AS n FROM moments').get() as { n: number }
      ).n

      // 冷轮：今天还没成时刻 → 会真的插入
      const coldMs = ms(() =>
        backfillMomentsForDay(db, from, to, { now, settleMs: MOMENT_MERGE_GAP_MS })
      )
      // 热轮：全部已存在 → 插入 0 条，但仍然整日重读
      const warmMs = ms(() =>
        backfillMomentsForDay(db, from, to, { now, settleMs: MOMENT_MERGE_GAP_MS })
      )
      const momentsAfter = (
        db.prepare('SELECT COUNT(*) AS n FROM moments').get() as { n: number }
      ).n

      // 只读元数据的扫描（按需取正文落地后，热轮的读取量下限）
      let metaRows = 0
      const metaMs = ms(() => {
        const rows = db
          .prepare(
            `SELECT id, ts, app, window_title, sensitive
               FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC`
          )
          .all(from, to) as unknown[]
        metaRows = rows.length
      })

      // 对照：整日重读正文（一次扫描 + 物化的读取成本）
      const textMs = ms(() => {
        db.prepare(
          `SELECT ocr_text FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC`
        ).all(from, to)
      })

      const fmt = (value: number | null): string =>
        typeof value === 'number' ? (value / 1024).toFixed(1) + ' KB' : '0 KB'
      console.log(
        `[moment-backfill] 当天事件 ${stats.n} 条 / 正文 ${stats.chars ?? 0} 字 / ${fmt(
          stats.bytes
        )}`
      )
      console.log(`[moment-backfill] 冷轮 ${coldMs.toFixed(1)} ms（新增时刻 ${momentsAfter - momentsBefore} 条）`)
      console.log(`[moment-backfill] 热轮 ${warmMs.toFixed(1)} ms（新增 0 条，仍整日重读正文）`)
      console.log(`[moment-backfill] 只读元数据 ${metaMs.toFixed(1)} ms / ${metaRows} 行`)
      console.log(`[moment-backfill] 只读正文 ${textMs.toFixed(1)} ms`)

      expect(stats.n).toBeGreaterThan(0)
      expect(momentsAfter - momentsBefore).toBeGreaterThanOrEqual(0)
    } finally {
      db.close()
      rmSync(copy, { force: true })
    }
  })
})
