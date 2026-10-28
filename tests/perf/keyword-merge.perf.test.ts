/**
 * 多关键词合并检索（性能方案 P0-3）——真实库 + 真实模块。
 *
 * 关心的不是「能不能过」，而是三组毫秒数：
 * 1. 逐词 8 次（旧实现：每词一条 SQL + 一次 hydrate）；
 * 2. 合并 1 次（新实现：一条 OR 扫描 + 一次 hydrate）；
 * 3. 迁移到 v3（`chain_content.text_norm`）之后的合并扫描。
 * 以及工具调用端到端（`executeSearchInfo`，含 getSegmentDetail / URL 抽取）。
 *
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/keyword-merge.perf.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchChainSegments, searchChainSegmentsBatch } from '../../src/chain/query'
import { createAskToolExecutor } from '../../src/chain/agent/tools'
import { ensureChainSchema } from '../../src/chain/schema'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const hasDb = existsSync(dbPath)

const KEYWORDS = ['插件市场', '记忆球', 'B站', 'Obsidian', 'dsh', '插件', '窗口', '时间']

function ms(fn: () => unknown, times = 3): number {
  fn()
  const t0 = performance.now()
  for (let i = 0; i < times; i += 1) fn()
  return (performance.now() - t0) / times
}

async function msAsync(fn: () => Promise<unknown>, times = 3): Promise<number> {
  await fn()
  const t0 = performance.now()
  for (let i = 0; i < times; i += 1) await fn()
  return (performance.now() - t0) / times
}

/** 每个词各查一次（旧实现口径），只为拿到「改之前」的基线数 */
function perKeyword(db: unknown): void {
  for (const keyword of KEYWORDS) {
    searchChainSegments(db as never, { text: keyword, includeOpen: true, limit: 8 })
  }
}

describe.skipIf(!hasDb)('关键词合并检索（P0-3）', () => {
  it('真实库（未迁移）：逐词 vs 合并 + 工具调用端到端', async () => {
    const db = new Database(dbPath, { readonly: true })
    try {
      const per = ms(() => perKeyword(db))
      const merged = ms(() => searchChainSegmentsBatch(db, { texts: KEYWORDS, includeOpen: true, limit: 8 }))
      console.log(`8 关键词 · 逐词 8 次 = ${per.toFixed(1)} ms`)
      console.log(`8 关键词 · 合并 1 次 = ${merged.toFixed(1)} ms（-${((1 - merged / per) * 100).toFixed(0)}%）`)

      // 召回口径必须不变：每路命中的段 id 与逐词检索一致
      const batch = searchChainSegmentsBatch(db, { texts: KEYWORDS, includeOpen: true, limit: 8 })
      KEYWORDS.forEach((keyword, index) => {
        const single = searchChainSegments(db, { text: keyword, includeOpen: true, limit: 8 })
        expect(batch.hitsPerText[index].map((hit) => hit.segment.id)).toEqual(
          single.hits.map((hit) => hit.segment.id)
        )
      })

      const executor = createAskToolExecutor({ db, now: () => Date.now(), captureRunning: () => true })
      const toolMs = await msAsync(() =>
        executor.execute({ name: 'search_info', arguments: { keywords: KEYWORDS, limit: 8 } })
      )
      console.log(`search_info 工具调用端到端（含段详情 / URL 抽取）= ${toolMs.toFixed(1)} ms`)

      expect(merged).toBeLessThan(per)
    } finally {
      db.close()
    }
  })

  it('迁移 v3 后（副本）：text_norm 快路径 + 工具调用端到端', async () => {
    const source = new Database(dbPath, { readonly: true })
    const copyPath = join(tmpdir(), `gotcha-perf-norm-${process.pid}-${Date.now()}.db`)
    try {
      source.prepare('VACUUM INTO ?').run(copyPath)
    } finally {
      source.close()
    }
    try {
      const db = new Database(copyPath)
      try {
        const migrateStartedAt = performance.now()
        ensureChainSchema(db)
        const migrateMs = performance.now() - migrateStartedAt
        const version = (db.prepare("SELECT value FROM chain_meta WHERE key = 'schema_version'").get() as {
          value: string
        }).value
        const rows = db.prepare('SELECT COUNT(*) AS n FROM chain_content WHERE text_norm IS NULL').get() as {
          n: number
        }
        console.log(`chain v3 迁移（补 text_norm + 回填）= ${migrateMs.toFixed(0)} ms；版本 ${version}；未回填 ${rows.n} 行`)
        expect(rows.n).toBe(0)

        const merged = ms(() => searchChainSegmentsBatch(db, { texts: KEYWORDS, includeOpen: true, limit: 8 }), 5)
        const single = ms(
          () => searchChainSegments(db, { text: '的', includeOpen: true, limit: 8 }),
          5
        )
        console.log(`迁移后 · 8 关键词合并 1 次 = ${merged.toFixed(1)} ms`)
        console.log(`迁移后 · 单个高频词 LIKE 全扫 = ${single.toFixed(1)} ms`)

        const executor = createAskToolExecutor({ db, now: () => Date.now(), captureRunning: () => true })
        const toolMs = await msAsync(() =>
          executor.execute({ name: 'search_info', arguments: { keywords: KEYWORDS, limit: 8 } })
        )
        console.log(`迁移后 · search_info 工具调用端到端 = ${toolMs.toFixed(1)} ms`)

        expect(merged).toBeLessThan(300)
      } finally {
        db.close()
      }
    } finally {
      rmSync(copyPath, { force: true })
    }
  })
})
