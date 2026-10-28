/**
 * P0-2 第一阶段：`chain_content` → `events` 镜像的体积与写入成本（真实库副本）。
 *
 * 要回答三个问题：
 * 1. 镜像会不会把 `events` 撑爆：按 4k 截断后，每天新增多少正文字符（对比旧管线每天的量）；
 * 2. 一条镜像行要多久：真实库上带 FTS 触发器插入的真实耗时；
 * 3. 每天新增多少库体积：真实正文插入 100 行后 events / events_fts 的 dbstat 增量。
 *
 * 只读真实库（VACUUM INTO 副本），所有写入都在副本上；副本用完即删。
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/events-mirror.perf.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChainEventMirror, EVENTS_MIRROR_MAX_CHARS } from '../../src/main/chain-events'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const hasDb = existsSync(dbPath)

function vacuumCopy(): string {
  const copyPath = join(tmpdir(), `gotcha-perf-mirror-${process.pid}-${Date.now()}.db`)
  const source = new Database(dbPath, { readonly: true })
  try {
    source.prepare('VACUUM INTO ?').run(copyPath)
  } finally {
    source.close()
  }
  return copyPath
}

interface DailyRow {
  d: string
  n: number
  chars: number
  capped: number
  over: number
}

describe.skipIf(!hasDb)('chain_content → events 镜像（P0-2）', () => {
  it('真实库副本：正文覆盖率、镜像耗时与库体积增量', () => {
    const daily = (() => {
      const db = new Database(dbPath, { readonly: true })
      try {
        return db
          .prepare(
            `SELECT date(captured_at / 1000, 'unixepoch', 'localtime') AS d,
                    COUNT(*) AS n,
                    SUM(chars) AS chars,
                    SUM(MIN(chars, @cap)) AS capped,
                    SUM(CASE WHEN chars > @cap THEN 1 ELSE 0 END) AS over
               FROM chain_content
              GROUP BY d ORDER BY d DESC LIMIT 3`
          )
          .all({ cap: EVENTS_MIRROR_MAX_CHARS }) as DailyRow[]
      } finally {
        db.close()
      }
    })()
    const eventsDaily = (() => {
      const db = new Database(dbPath, { readonly: true })
      try {
        return db
          .prepare(
            `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS d,
                    COUNT(*) AS n, SUM(length(ocr_text)) AS chars
               FROM events GROUP BY d ORDER BY d DESC LIMIT 3`
          )
          .all() as Array<{ d: string; n: number; chars: number }>
      } finally {
        db.close()
      }
    })()
    for (const row of daily) {
      const legacy = eventsDaily.find((item) => item.d === row.d)
      console.log(
        `镜像 ${row.d}：chain_content ${row.n} 行 / ${row.chars} 字，4k 截断后 ${row.capped} 字` +
          `（超限 ${row.over} 行）；同日旧管线 events ${legacy?.n ?? 0} 行 / ${legacy?.chars ?? 0} 字`
      )
    }

    // ① 写入耗时 + ② 体积增量（都在副本上）
    const timingCopy = vacuumCopy()
    try {
      const db = new Database(timingCopy)
      try {
        const mirror = createChainEventMirror({ db })
        const rows = db
          .prepare('SELECT segment_id, captured_at, text FROM chain_content ORDER BY id DESC LIMIT 40')
          .all() as Array<{ segment_id: number; captured_at: number; text: string }>
        expect(rows.length).toBeGreaterThan(0)

        db.exec('BEGIN')
        const startedAt = performance.now()
        for (const row of rows) {
          mirror.onContent(row.segment_id, row.captured_at, { source: 'uia', text: row.text })
        }
        const perRow = (performance.now() - startedAt) / rows.length
        console.log(
          `镜像写入（含 FTS 触发器，事务内）：${perRow.toFixed(2)} ms/行；` +
            `统计 ${JSON.stringify(mirror.stats)}`
        )
        db.exec('ROLLBACK')

        // 体积：另起一份副本，插入 100 行 4k 正文后比 dbstat
        const stat = (): Record<string, number> => {
          const list = db
            .prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'events%' GROUP BY name")
            .all() as Array<{ name: string; bytes: number }>
          return Object.fromEntries(list.map((row) => [row.name, row.bytes]))
        }
        const before = stat()
        db.exec('BEGIN')
        const sample = db
          .prepare('SELECT segment_id, captured_at, text FROM chain_content ORDER BY id DESC LIMIT 100')
          .all() as Array<{ segment_id: number; captured_at: number; text: string }>
        for (const row of sample) {
          mirror.onContent(row.segment_id, row.captured_at, {
            source: 'uia',
            text: row.text.slice(0, EVENTS_MIRROR_MAX_CHARS)
          })
        }
        db.exec('COMMIT')
        const after = stat()
        const growth = Object.keys(after).reduce(
          (sum, name) => sum + (after[name] ?? 0) - (before[name] ?? 0),
          0
        )
        const perDayRows = daily[0]?.n ?? 0
        console.log(
          `镜像体积：100 行 4k 正文新增 ${(growth / 1024 / 1024).toFixed(2)} MB ` +
            `≈ ${(growth / 100).toFixed(0)} B/行；按最近一天 ${perDayRows} 行折算 ≈ ` +
            `${((growth / 100) * perDayRows / 1024 / 1024).toFixed(1)} MB/天`
        )
      } finally {
        db.close()
      }
    } finally {
      rmSync(timingCopy, { force: true })
    }
  })
})
