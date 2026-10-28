/**
 * P1-3 落地验证：`event_embeddings` 迁到 int16 之后的体积、读取耗时与 top-1 一致性（真实库副本）。
 *
 * 不是「能不能跑」，而是回答四个数：
 * 1. 迁移本身要多久（15k 行重写 BLOB，启动时只跑一次）；
 * 2. 表实占从多少降到多少（SQLite 溢出页效应：2 KB 行 vs 1 KB 行）；
 * 3. 全表读取（`graph-backfill` / `vector-maintenance` 的 `readEventVectors`）快多少；
 * 4. 迁移后的 top-1 最近邻与迁移前是否一致（用真实向量抽样，而不是合成数据）。
 *
 * 只读真实库（VACUUM INTO 副本），迁移与写入都在副本上；副本用完即删。
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/vector-int16.perf.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../src/db/migrations'
import { readEventVectors } from '../../src/understand/event-embeddings'
import { cosineSimilarity } from '../../src/understand/graph-edges'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const hasDb = existsSync(dbPath)

function vacuumCopy(): string {
  const copyPath = join(tmpdir(), `gotcha-perf-int16-${process.pid}-${Date.now()}.db`)
  const source = new Database(dbPath, { readonly: true })
  try {
    source.prepare('VACUUM INTO ?').run(copyPath)
  } finally {
    source.close()
  }
  return copyPath
}

function tableBytes(db: unknown): number {
  const row = (
    db as { prepare(sql: string): { get(): { n: number | null } } }
  )
    .prepare("SELECT SUM(pgsize) AS n FROM dbstat WHERE name = 'event_embeddings'")
    .get()
  return row?.n ?? 0
}

describe.skipIf(!hasDb)('event_embeddings int16 迁移（P1-3）', () => {
  it('真实库副本：迁移耗时 / 体积 / 读取耗时 / top-1 一致性', () => {
    const copy = vacuumCopy()
    const db = new Database(copy)
    try {
      const rows = (
        db.prepare('SELECT event_id, model, dim FROM event_embeddings ORDER BY event_id ASC').all() as Array<{
          event_id: number
          model: string
          dim: number
        }>
      )
      expect(rows.length).toBeGreaterThan(100)
      const model = rows[0].model

      const beforeBytes = tableBytes(db)
      const tReadBefore = performance.now()
      const before = readEventVectors(db, { model })
      const readBeforeMs = performance.now() - tReadBefore

      const tMigrate = performance.now()
      applyMigrations(db)
      const migrateMs = performance.now() - tMigrate

      const afterBytes = tableBytes(db)
      const tReadAfter = performance.now()
      const after = readEventVectors(db, { model })
      const readAfterMs = performance.now() - tReadAfter

      expect(after.vectors.size).toBe(before.vectors.size)

      // top-1 一致性：抽 120 条，在迁移前后的同一批向量里找最近邻
      const ids = [...before.vectors.keys()]
      let seed = 424242
      const rand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      const neighbor = (
        vectors: Map<number, Float32Array>,
        index: number,
        candidates: number[]
      ): number => {
        const probe = vectors.get(candidates[index])!
        let best = -1
        let bestId = -1
        for (let j = 0; j < candidates.length; j += 1) {
          if (j === index) continue
          const sim = cosineSimilarity(probe, vectors.get(candidates[j])!)
          if (sim > best) {
            best = sim
            bestId = candidates[j]
          }
        }
        return bestId
      }
      let same = 0
      let compared = 0
      for (let p = 0; p < 40; p += 1) {
        const index = Math.floor(rand() * ids.length)
        const beforeId = neighbor(before.vectors, index, ids)
        const afterId = neighbor(after.vectors, index, ids)
        compared += 1
        if (beforeId === afterId) same += 1
      }

      const kb = (value: number): string => (value / 1024 / 1024).toFixed(1) + ' MB'
      console.log(
        `[int16] ${rows.length} 行：表 ${kb(beforeBytes)} → ${kb(afterBytes)}（-${(
          (1 - afterBytes / beforeBytes) * 100
        ).toFixed(0)}%），迁移 ${migrateMs.toFixed(0)} ms`
      )
      console.log(
        `[int16] 全表读取 ${readBeforeMs.toFixed(1)} ms → ${readAfterMs.toFixed(1)} ms（-${(
          (1 - readAfterMs / readBeforeMs) * 100
        ).toFixed(0)}%）`
      )
      console.log(`[int16] top-1 一致率 ${((same / compared) * 100).toFixed(1)}%（${same}/${compared}）`)

      expect(afterBytes).toBeLessThan(beforeBytes * 0.5)
      expect(same / compared).toBeGreaterThanOrEqual(0.99)
    } finally {
      db.close()
      rmSync(copy, { force: true })
    }
  })
})
