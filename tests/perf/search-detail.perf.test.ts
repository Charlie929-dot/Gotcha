/**
 * P1-6：`search_info` 段详情瘦身的前后对比（真实库副本）。
 *
 * 改造前：每条命中段都 `getSegmentDetail()`（段 + 事件 + 截图 + **整段正文**），
 * 只为了 80 字兜底摘要和扫网址；limit 8 时要搬 2.3 MB 正文、在 2.3 MB 上跑正则。
 * 改造后：网址直接读 `chain_content.urls`（写时落列），兜底摘要只取「最长那条正文的开头」。
 *
 * 这里在同一个副本上量三段：
 * 1. 迁移（chain v4：补列 + 按同一规则回填）要多久；
 * 2. 旧路径（getSegmentDetail + 现抽网址）耗时与搬运量；
 * 3. 新路径（executeSearchInfo 端到端）耗时；
 * 4. 两条路径抽出来的 `urls` / `snippet` 是否逐条一致（回填口径与写入口径必须相同）。
 *
 * 只读真实库（VACUUM INTO 副本），迁移与写入都在副本上；副本用完即删。
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/search-detail.perf.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAskToolExecutor } from '../../src/chain/agent/tools'
import { getSegmentDetail } from '../../src/chain/store'
import { ensureChainSchema } from '../../src/chain/schema'
import { collectUrls } from '../../src/chain/content/urls'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const hasDb = existsSync(dbPath)

const KEYWORDS = ['插件市场', '记忆球', 'B站', 'Obsidian', 'dsh', '插件', '窗口', '时间']
const SNIPPET_CHARS = 80

function vacuumCopy(): string {
  const copyPath = join(tmpdir(), `gotcha-perf-detail-${process.pid}-${Date.now()}.db`)
  const source = new Database(dbPath, { readonly: true })
  try {
    source.prepare('VACUUM INTO ?').run(copyPath)
  } finally {
    source.close()
  }
  return copyPath
}

interface View {
  segmentId: number
  snippet: string
  urls: string[]
}

/** 改造前的口径：整段正文取回内存，现抽网址 / 兜底摘要（先热身一次，再计平均） */
function oldView(db: unknown, ids: readonly number[]): { views: View[]; ms: number; chars: number } {
  const run = (): { views: View[]; chars: number } => {
    let chars = 0
    const views: View[] = []
    for (const id of ids) {
      const detail = getSegmentDetail(db as never, id)
      const contents = detail?.contents ?? []
      for (const row of contents) chars += row.text.length
      const urls = collectUrls(contents.map((row) => row.text))
      const longest = contents.reduce<string>((best, row) => (row.text.length > best.length ? row.text : best), '')
      views.push({
        segmentId: id,
        snippet: longest.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
        urls
      })
    }
    return { views, chars }
  }
  const warm = run()
  const started = performance.now()
  for (let i = 0; i < 3; i += 1) run()
  return { views: warm.views, chars: warm.chars, ms: (performance.now() - started) / 3 }
}

async function newView(db: unknown, limit: number): Promise<{ views: View[]; ms: number }> {
  const executor = createAskToolExecutor({
    db: db as never,
    now: () => Date.now(),
    captureRunning: () => true
  })
  const started = performance.now()
  const outcome = await executor.execute({ name: 'search_info', arguments: { keywords: KEYWORDS, limit } })
  const ms = performance.now() - started
  const result = outcome.result as { kind: string; hits?: Array<{ segmentId: number; snippet: string; urls: string[] }> }
  expect(result.kind).toBe('search_info')
  return {
    ms,
    views: (result.hits ?? []).map((hit) => ({
      segmentId: hit.segmentId,
      snippet: hit.snippet,
      urls: hit.urls
    }))
  }
}

describe.skipIf(!hasDb)('search_info 段详情（P1-6）', () => {
  it('真实库副本：旧路径 vs 新路径（耗时 / 搬运量 / 结果一致）', async () => {
    const copy = vacuumCopy()
    const db = new Database(copy)
    try {
      // 迁移前：老库没有 urls 列——先量旧路径，再迁移，再量新路径
      const counts = db
        .prepare("SELECT COUNT(*) AS n FROM chain_content")
        .get() as { n: number }
      expect(counts.n).toBeGreaterThan(0)

      const probe = await newView(db, 8) // 老库走 fallback（现场扫正文），保证能跑
      const ids = probe.views.map((view) => view.segmentId)

      const before = oldView(db, ids)
      const migrateStarted = performance.now()
      ensureChainSchema(db)
      const migrateMs = performance.now() - migrateStarted

      const after = await newView(db, 8)
      // 端到端里含关键词检索（~190 ms 的 LIKE 合并扫描），单独量一次好把「段详情」那部分拆出来
      const { searchChainSegmentsBatch } = await import('../../src/chain/query')
      const scanStarted = performance.now()
      for (let i = 0; i < 3; i += 1) {
        searchChainSegmentsBatch(db, { texts: KEYWORDS, includeOpen: true, limit: 8 })
      }
      const scanMs = (performance.now() - scanStarted) / 3

      // 同口径直接比「段详情」这一段：旧 = getSegmentDetail + 现抽；新 = 读 urls 列
      // （关键词命中的段都有摘要，兜底摘要不参与，所以只比 urls 读取）
      const { listSegmentLongestHeads, listSegmentUrls } = await import('../../src/chain/store')
      listSegmentUrls(db, ids)
      listSegmentLongestHeads(db, ids)
      const detailStarted = performance.now()
      for (let i = 0; i < 5; i += 1) listSegmentUrls(db, ids)
      const newDetailMs = (performance.now() - detailStarted) / 5

      // 兜底摘要那条路径（只有「纯过滤 / 语义」命中才走）：只取最长一行的开头
      const headStarted = performance.now()
      for (let i = 0; i < 5; i += 1) listSegmentLongestHeads(db, ids)
      const headMs = (performance.now() - headStarted) / 5
      // 结果必须逐条一致（snippet 取最长行开头、urls 顺序与去重口径都不变）
      const oldById = new Map(before.views.map((view) => [view.segmentId, view]))
      let compared = 0
      for (const view of after.views) {
        const previous = oldById.get(view.segmentId)
        if (!previous) continue
        compared += 1
        expect(view.urls).toEqual(previous.urls)
        if (previous.snippet.length >= SNIPPET_CHARS) {
          // 关键词摘要路径本来就不同，只比兜底摘要（长度刚好到上限说明来自兜底）
          continue
        }
        expect(view.snippet).toBe(previous.snippet)
      }

      console.log(
        `[p1-6] chain v4 迁移（补 urls 列 + 回填 ${counts.n} 行）：${migrateMs.toFixed(0)} ms`
      )
      console.log(
        `[p1-6] 旧路径（${ids.length} 段，getSegmentDetail + 现抽网址）：${before.ms.toFixed(1)} ms / 搬运 ${(
          before.chars / 1024
        ).toFixed(0)} KB`
      )
      console.log(`[p1-6] 新路径（search_info 端到端，含检索）：${after.ms.toFixed(1)} ms`)
      console.log(`[p1-6] 其中关键词检索 ${scanMs.toFixed(1)} ms`)
      console.log(
        `[p1-6] 段详情（${ids.length} 段）：旧 ${before.ms.toFixed(1)} ms / 搬 ${
          (before.chars / 1024).toFixed(0)
        } KB → 新 ${newDetailMs.toFixed(1)} ms / 不搬正文`
      )
      console.log(`[p1-6] 兜底摘要链路（只取最长行开头）：${headMs.toFixed(1)} ms（关键词命中时不走）`)
      console.log(`[p1-6] 逐条一致（urls + 兜底摘要）：${compared}/${after.views.length} 段`)

      expect(compared).toBeGreaterThan(0)
    } finally {
      db.close()
      rmSync(copy, { force: true })
    }
  })
})
