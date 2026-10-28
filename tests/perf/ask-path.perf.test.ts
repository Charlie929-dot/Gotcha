/**
 * 问记忆本地段耗时基线（真实库 + 真实模块）。
 *
 * 关心的不是"能不能过"，而是数值本身：跑完把 stdout 里的毫秒数和上一次比。
 * 重点守住：search_info（多关键词一次工具调用）不要超过 ~300 ms——它是主进程同步执行的。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { searchChainSegments } from '../../src/chain/query'
import { getSegmentDetail } from '../../src/chain/store'
import { buildChainAskLoopPayload } from '../../src/understand/cloud/redact'
import { readAskHistory } from '../../src/main/ask-history'
import type { RedactableAskLoopTurn } from '../../src/understand/cloud/redact'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const historyPath = join(userData, 'ask-history.jsonl')
const hasDb = existsSync(dbPath)

function ms(fn: () => unknown, times = 1): number {
  const t0 = performance.now()
  for (let i = 0; i < times; i += 1) fn()
  return (performance.now() - t0) / times
}

describe.skipIf(!hasDb)('ask 本地段耗时基线', () => {
  it('量化检索 / 段详情 / 载荷', () => {
    const db = new Database(dbPath, { readonly: true })
    try {
      const keywords = ['插件市场', '记忆球', 'B站', 'Obsidian', 'dsh', '插件', '窗口', '时间']

      const kw = ms(() => {
        for (const keyword of keywords) {
          searchChainSegments(db, { text: keyword, includeOpen: true, limit: 8 })
        }
      })
      console.log(`search_info: ${keywords.length} 个关键词一次工具调用 = ${kw.toFixed(1)} ms`)

      const single = ms(() => searchChainSegments(db, { text: '的', includeOpen: true, limit: 8 }), 5)
      console.log(`单个高频词 LIKE 全扫 = ${single.toFixed(1)} ms`)

      const found = searchChainSegments(db, { text: '插件市场', includeOpen: true, limit: 20 })
      const ids = found.hits.map((hit) => hit.segment.id)

      let chars = 0
      const detail = ms(() => {
        for (const id of ids) {
          const row = getSegmentDetail(db, id)
          chars += row?.contents.reduce((sum, item) => sum + item.text.length, 0) ?? 0
        }
      })
      console.log(`getSegmentDetail × ${ids.length} 段 = ${detail.toFixed(1)} ms（正文合计 ${chars} 字）`)

      const vec = new Float32Array(512)
      for (let i = 0; i < vec.length; i += 1) vec[i] = Math.sin(i * 0.1)
      const vectorMs = ms(() => searchChainSegments(db, { vector: vec, includeOpen: true, limit: 8 }), 5)
      console.log(`语义路（全量向量比较）= ${vectorMs.toFixed(1)} ms`)

      // 载荷：6 轮工具结果 + 最后一轮 6000 字正文（最坏一轮）
      const freshness = { latestEvidenceTs: Date.now(), captureRunning: true }
      const turns: RedactableAskLoopTurn[] = Array.from({ length: 6 }, () => ({
        toolCall: { name: 'search_info', arguments: { keywords: ['插件市场'], limit: 8 } },
        toolResult: {
          kind: 'search_info' as const,
          freshness,
          hits: found.hits.slice(0, 8).map((hit) => ({
            segmentId: hit.segment.id,
            at: '12:00',
            app: hit.segment.app ?? '',
            title: hit.segment.title_last ?? '',
            snippet: (hit.snippet ?? '').slice(0, 80),
            tags: hit.tags,
            links: hit.links,
            urls: ['https://example.com/a?token=abc']
          })),
          stats: { mode: 'keywords', keywordRows: 400 }
        }
      }))
      const bigText = '这是一段很长的屏幕正文，包含邮箱 a@b.com 和手机号 13800138000。'.repeat(160)
      turns.push({
        toolCall: { name: 'read_segment', arguments: { segmentId: ids[0] ?? 1 } },
        toolResult: {
          kind: 'read_segment' as const,
          freshness,
          segmentId: ids[0] ?? 1,
          at: '12:00',
          app: 'Chrome',
          title: '标题',
          text: bigText,
          urls: [],
          offset: 0,
          limit: 6000
        }
      })

      const payloadMs = ms(
        () =>
          buildChainAskLoopPayload({
            question: '插件市场里面有啥',
            systemTime: '2026-10-28 12:00',
            freshness,
            turns
          }),
        3
      )
      const built = buildChainAskLoopPayload({
        question: '插件市场里面有啥',
        systemTime: '2026-10-28 12:00',
        freshness,
        turns
      })
      const bytes = Buffer.byteLength(JSON.stringify(built.payload), 'utf8')
      console.log(
        `buildChainAskLoopPayload（7 轮 + 6k 正文）= ${payloadMs.toFixed(1)} ms，载荷 ${(bytes / 1024).toFixed(0)} KB`
      )

      if (existsSync(historyPath)) {
        const historyMs = ms(() => readAskHistory(historyPath), 5)
        console.log(`readAskHistory（JSONL 全量解析）= ${historyMs.toFixed(1)} ms`)
      }

      // 只做"别退化到秒级"的兜底断言；真正的验收看上面的数值。
      expect(kw).toBeLessThan(5000)
    } finally {
      db.close()
    }
  })
})
