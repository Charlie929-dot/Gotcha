/**
 * P0-3 的规模曲线：只扫小列 + 标记列之后，`search_info` 随正文增长还扛不扛得住。
 *
 * 关心的是「一条 OR 扫描 + 8 个 AS mN 标记」的斜率：LIKE 本身没法走索引，
 * 时间必然随正文线性增长，这里要量的是新斜率（旧实现 18 ms/MB/词，来源 §2.7），
 * 以及「8 个词一次工具调用」在 50 MB 正文时的大致落点。
 *
 * 只动副本（VACUUM INTO），不碰真实库。
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/keyword-scale.perf.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchChainSegments, searchChainSegmentsBatch } from '../../src/chain/query'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const hasDb = existsSync(dbPath)

const KEYWORDS = ['插件市场', '记忆球', 'B站', 'Obsidian', 'dsh', '插件', '窗口', '时间']
const FILLER =
  '这是一段用于规模测试的屏幕正文，里面有插件市场、记忆球、Obsidian 等词，也有链接 https://example.com/x 。'.repeat(600)

function ms(fn: () => unknown, times = 3): number {
  fn()
  const t0 = performance.now()
  for (let i = 0; i < times; i += 1) fn()
  return (performance.now() - t0) / times
}

describe.skipIf(!hasDb)('关键词检索规模曲线（副本注入正文）', () => {
  it('正文 8 / 14 / 33 MB：单词语义与 8 词合并的耗时', () => {
    const source = new Database(dbPath, { readonly: true })
    const copyPath = join(tmpdir(), `gotcha-perf-scale-${process.pid}-${Date.now()}.db`)
    try {
      source.prepare('VACUUM INTO ?').run(copyPath)
    } finally {
      source.close()
    }
    try {
      const db = new Database(copyPath)
      try {
        const segment = db.prepare('SELECT id FROM chain_segment ORDER BY id LIMIT 1').get() as
          | { id: number }
          | undefined
        expect(segment).toBeTruthy()
        const insert = db.prepare(
          `INSERT INTO chain_content (segment_id, captured_at, source, text, chars, hash)
           VALUES (?, ?, 'ocr', ?, ?, ?)`
        )
        const addRows = (count: number): void => {
          const startedAt = Date.now()
          db.transaction(() => {
            for (let index = 0; index < count; index += 1) {
              insert.run(segment!.id, startedAt + index, FILLER, FILLER.length, `scale-${index}-${Math.random()}`)
            }
          })()
        }

        const report = (label: string): void => {
          const total = db.prepare('SELECT SUM(length(text)) AS n, COUNT(*) AS rows FROM chain_content').get() as {
            n: number
            rows: number
          }
          const single = ms(() => searchChainSegments(db, { text: '插件市场', includeOpen: true, limit: 8 }))
          const eight = ms(() =>
            searchChainSegmentsBatch(db, { texts: KEYWORDS, includeOpen: true, limit: 8 })
          )
          console.log(
            `${label}：正文 ${(total.n / 1024 / 1024).toFixed(1)} MB / ${total.rows} 行 → ` +
              `单词 ${single.toFixed(1)} ms，8 词 ${eight.toFixed(1)} ms`
          )
        }

        report('基线')
        addRows(100) // ≈ +5.4 MB
        report('+5 MB')
        addRows(170) // ≈ 累计 +14 MB
        report('+14 MB')
        addRows(500) // ≈ 累计 +40 MB
        report('+40 MB')
      } finally {
        db.close()
      }
    } finally {
      rmSync(copyPath, { force: true })
    }
  })
})
