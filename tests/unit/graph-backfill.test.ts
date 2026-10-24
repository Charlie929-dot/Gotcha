import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { backfillGraphStructures } from '../../src/understand/graph-backfill'
import { readThemeVectors, writeThemeVectors } from '../../src/understand/graph-edges'
import { readMembershipStats } from '../../src/understand/theme-membership'
import type { Embedder } from '../../src/understand/embedding/types'

function at(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 9, 22, hour, minute, second, 0).getTime()
}

function seedTheme(db: Db, id: number, eventIds: readonly number[], summary = ''): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, 'knowledge', ?, ?, ?, ?, ?)`
  ).run(id, `主题 ${id}`, summary, at(9), at(10), JSON.stringify(eventIds))
}

function vector(nodeId: number, x: number, y: number): { nodeId: number; vec: Float32Array } {
  return { nodeId, vec: Float32Array.from([x, y, 0]) }
}

/** 假 embedder：按主题文本给固定向量（不碰模型） */
function fakeEmbedder(vectors: Record<string, Float32Array>): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    model: 'fake-bge',
    dim: 3,
    calls,
    async embed(texts) {
      calls.push([...texts])
      return texts.map((text) => vectors[text] ?? Float32Array.from([0, 0, 1]))
    }
  }
}

describe('backfillGraphStructures', () => {
  it('一次跑完时刻 → 主归属 → embedding 边，重跑幂等', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts', ocrText: '一' })
      insertEvent(db, { ts: at(9, 1), app: 'Code', windowTitle: 'a.ts', ocrText: '二' })
      insertEvent(db, { ts: at(11), app: 'Chrome', windowTitle: 'docs', ocrText: '三' })
      seedTheme(db, 1, [1])
      seedTheme(db, 2, [2, 3])

      const report = await backfillGraphStructures(db, {
        now: 5,
        embedding: {
          model: 'fake-bge',
          vectors: [vector(1, 1, 0), vector(2, 0.9, 0.1)],
          topK: 4,
          minSim: 0.6
        }
      })
      expect(report.moments.events).toBe(3)
      expect(report.moments.created).toBe(2)
      // 主题 1 → 时刻 A；主题 2 → 时刻 A（事件 2 与主题 1 共享）+ 时刻 B
      expect(report.memberships.inserted).toBe(3)
      expect(report.embeddings).toBeNull()
      expect(report.edges).toEqual({ deleted: 0, inserted: 1 })

      const edgeRows = db
        .prepare("SELECT src, dst, kind FROM edges WHERE kind = 'embedding'")
        .all() as Array<{ src: number; dst: number; kind: string }>
      expect(edgeRows).toEqual([{ src: 1, dst: 2, kind: 'embedding' }])

      const again = await backfillGraphStructures(db, {
        now: 6,
        embedding: {
          model: 'fake-bge',
          vectors: [vector(1, 1, 0), vector(2, 0.9, 0.1)],
          topK: 4,
          minSim: 0.6
        }
      })
      expect(again.moments.created).toBe(0)
      expect(again.moments.existing).toBe(2)
      expect(again.memberships.inserted).toBe(0)
      expect(again.memberships.existing).toBe(3)
      expect(again.edges).toEqual({ deleted: 1, inserted: 1 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM moments').get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })

  it('不给向量/embedder 时不碰 edges 表', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      seedTheme(db, 1, [1])
      db.prepare(
        "INSERT INTO edges (src, dst, weight, kind, evidence) VALUES (1, 1, 0.5, 'ai', '旧')"
      ).run()

      const report = await backfillGraphStructures(db, { now: 5 })
      expect(report.edges).toBeNull()
      expect(report.embeddings).toBeNull()
      expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'ai'").get()).toEqual({ n: 1 })
      expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'embedding'").get()).toEqual({
        n: 0
      })
      expect(readMembershipStats(db).rows).toBe(1)
    } finally {
      db.close()
    }
  })

  it('先写向量再回填：向量可读回，边按默认参数生成', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, [])
      seedTheme(db, 2, [])
      writeThemeVectors(db, [vector(1, 1, 0), vector(2, 1, 0)], {
        model: 'fake-bge',
        dim: 3,
        now: 1
      })
      const stored = readThemeVectors(db, { model: 'fake-bge' })
      const report = await backfillGraphStructures(db, {
        now: 2,
        embedding: { model: 'fake-bge', vectors: stored.vectors }
      })
      expect(report.edges).toEqual({ deleted: 0, inserted: 1 })
      const evidence = db.prepare("SELECT evidence FROM edges WHERE kind = 'embedding'").get() as {
        evidence: string
      }
      expect(JSON.parse(evidence.evidence)).toEqual({
        model: 'fake-bge',
        threshold: 0.64,
        topK: 4,
        mutual: true
      })
    } finally {
      db.close()
    }
  })

  it('给 embedder 时现算向量并连边，第二次只补缺失向量', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, [], '写代码')
      seedTheme(db, 2, [], '查文档')
      const embedder = fakeEmbedder({
        '主题 1。写代码': Float32Array.from([1, 0, 0]),
        '主题 2。查文档': Float32Array.from([1, 0, 0])
      })

      const first = await backfillGraphStructures(db, { now: 5, embedder })
      expect(first.embeddings?.ok).toBe(true)
      expect(first.embeddings?.embedded).toBe(2)
      expect(embedder.calls).toEqual([['主题 1。写代码', '主题 2。查文档']])
      expect(first.edges).toEqual({ deleted: 0, inserted: 1 })

      const second = await backfillGraphStructures(db, { now: 6, embedder })
      expect(second.embeddings?.themes).toBe(0) // 已有向量，不再送模型
      expect(second.embeddings?.embedded).toBe(0)
      expect(second.edges).toEqual({ deleted: 1, inserted: 1 })
    } finally {
      db.close()
    }
  })
})
