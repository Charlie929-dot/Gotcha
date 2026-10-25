import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/db'
import { writeEventVectors } from '../../src/understand/event-embeddings'
import type { Embedder } from '../../src/understand/embedding/types'
import { embedThemeVectors } from '../../src/understand/theme-embeddings'
import { readThemeCentroids } from '../../src/understand/theme-centroids'
import {
  maintainMomentVectors,
  refreshThemeCentroid,
  syncThemeCentroids
} from '../../src/understand/vector-maintenance'

const MODEL = 'fake-bge'
const DIM = 3

function seedTheme(db: Db, id: number, title = `主题 ${id}`, summary = ''): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, 'knowledge', ?, ?, 1, 2, '[]')`
  ).run(id, title, summary)
}

function seedMoment(db: Db, id: number, eventIds: readonly number[]): void {
  db.prepare(
    `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
     VALUES (?, ?, ?, '2026-10-25', 'Code', 'a.ts', '', ?, 1)`
  ).run(id, id * 1000, id * 1000 + 10, JSON.stringify(eventIds))
}

function seedMembership(db: Db, themeId: number, momentId: number, source = 'owner'): void {
  db.prepare(
    `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (?, ?, 1.0, ?, 1)`
  ).run(themeId, momentId, source)
}

function seedEventVector(db: Db, eventId: number, values: readonly number[]): void {
  writeEventVectors(db, [{ eventId, vec: Float32Array.from(values) }], {
    model: MODEL,
    dim: values.length,
    now: 1
  })
}

function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    model: MODEL,
    dim: DIM,
    calls,
    async embed(texts) {
      calls.push([...texts])
      return texts.map(() => Float32Array.from([1, 0, 0]))
    }
  }
}

/** 三主题 / 三时刻 / 四条事件向量：主题 1 ← 时刻 10、11；主题 2 ← 时刻 12 */
function seedCentroidGraph(db: Db): void {
  seedTheme(db, 1, '主题 1', '摘要一')
  seedTheme(db, 2, '主题 2', '摘要二')
  seedMoment(db, 10, [1, 2])
  seedMoment(db, 11, [3])
  seedMoment(db, 12, [4])
  seedMembership(db, 1, 10)
  seedMembership(db, 1, 11)
  seedMembership(db, 2, 12)
  seedEventVector(db, 1, [1, 0, 0])
  seedEventVector(db, 2, [0, 1, 0])
  seedEventVector(db, 3, [0, 0, 1])
  seedEventVector(db, 4, [1, 0, 0])
}

describe('标题向量：只在文本变了时重算', () => {
  it('指纹一致直接复用；改标题 / 改摘要只重算那一行', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题 1', '摘要一')
      seedTheme(db, 2, '主题 2', '摘要二')
      const embedder = fakeEmbedder()

      const first = await embedThemeVectors(db, embedder, { now: 1 })
      expect(first.ok).toBe(true)
      expect(first.themes).toBe(2)
      expect(first.embedded).toBe(2)
      expect(first.reused).toBe(0)

      // 第二次：文本没变，不推理
      const second = await embedThemeVectors(db, embedder, { now: 2 })
      expect(second.themes).toBe(0)
      expect(second.embedded).toBe(0)
      expect(second.reused).toBe(2)
      expect(embedder.calls).toHaveLength(1)

      // 改标题：只重算主题 1
      db.prepare("UPDATE nodes SET title = '主题 1（改）' WHERE id = 1").run()
      const third = await embedThemeVectors(db, embedder, { now: 3 })
      expect(third.themes).toBe(1)
      expect(third.reused).toBe(1)
      expect(embedder.calls.at(-1)).toEqual(['主题 1（改）。摘要一'])

      // 改摘要（归纳批量路径会原地改摘要）：同样只重算那一行
      db.prepare("UPDATE nodes SET summary = '摘要一，变长了' WHERE id = 1").run()
      const fourth = await embedThemeVectors(db, embedder, { now: 4 })
      expect(fourth.themes).toBe(1)
      expect(fourth.reused).toBe(1)
      expect(embedder.calls.at(-1)).toEqual(['主题 1（改）。摘要一，变长了'])
    } finally {
      db.close()
    }
  })

  it('老库（text_hash 为 NULL）自愈重算一次；指纹列写回后不再重复', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题 1', '摘要一')
      const embedder = fakeEmbedder()
      await embedThemeVectors(db, embedder, { now: 1 })
      // 模拟 v6 之前落下的老行
      db.prepare('UPDATE node_embeddings SET text_hash = NULL WHERE node_id = 1').run()

      const legacy = await embedThemeVectors(db, embedder, { now: 2 })
      expect(legacy.themes).toBe(1)
      expect(legacy.embedded).toBe(1)
      const hash = db
        .prepare('SELECT text_hash FROM node_embeddings WHERE node_id = 1')
        .get() as { text_hash: string | null }
      expect(hash.text_hash).toMatch(/^[0-9a-f]{16}$/)

      const again = await embedThemeVectors(db, embedder, { now: 3 })
      expect(again.themes).toBe(0)
      expect(again.reused).toBe(1)
    } finally {
      db.close()
    }
  })

  it('强制重算（onlyMissing: false）不看指纹，全部送模型', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题 1')
      seedTheme(db, 2, '主题 2')
      const embedder = fakeEmbedder()
      await embedThemeVectors(db, embedder, { now: 1 })

      const forced = await embedThemeVectors(db, embedder, { now: 2, onlyMissing: false })
      expect(forced.themes).toBe(2)
      expect(forced.embedded).toBe(2)
      expect(forced.reused).toBe(0)
      expect(embedder.calls).toHaveLength(2)
    } finally {
      db.close()
    }
  })
})

describe('主题质心：只在成员变了时重算', () => {
  it('第一次全算，第二次复用；新增一个时刻归属只重算那个主题', () => {
    const db = openDatabase(':memory:')
    try {
      seedCentroidGraph(db)

      const first = syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 10 })
      expect(first.report.themes).toBe(2)
      expect(first.report.stale).toBe(2)
      expect(first.report.recomputed).toBe(2)
      expect(first.report.reused).toBe(0)
      expect(first.report.memberEvents).toBe(4)
      expect(first.centroids.get(1)?.memberEvents).toBe(3)
      expect(first.centroids.get(1)?.membersHash).toMatch(/^[0-9a-f]{16}$/)

      // 第二次：指纹一致，不重算、不改 updated_at
      const second = syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 20 })
      expect(second.report.stale).toBe(0)
      expect(second.report.recomputed).toBe(0)
      expect(second.report.reused).toBe(2)
      const row = db
        .prepare('SELECT updated_at FROM theme_centroids WHERE node_id = 1')
        .get() as { updated_at: number }
      expect(row.updated_at).toBe(10)

      // 新时刻并入主题 1：只有主题 1 的指纹变了
      seedMoment(db, 13, [5])
      seedMembership(db, 1, 13)
      seedEventVector(db, 5, [0, 1, 0])
      const third = syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 30 })
      expect(third.report.stale).toBe(1)
      expect(third.report.recomputed).toBe(1)
      expect(third.report.reused).toBe(1)
      expect(third.centroids.get(1)?.memberEvents).toBe(4)
      expect(third.centroids.get(2)?.memberEvents).toBe(1)
    } finally {
      db.close()
    }
  })

  it('成员全没了 → 删掉质心行；有成员但没向量 → pending 且不删旧行', () => {
    const db = openDatabase(':memory:')
    try {
      seedCentroidGraph(db)
      syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 10 })

      // 主题 3 只有归属、没有任何事件向量 → pending
      seedTheme(db, 3, '主题 3', '摘要三')
      seedMoment(db, 14, [99])
      seedMembership(db, 3, 14)
      const pending = syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 20 })
      expect(pending.report.pending).toBe(1)
      expect(pending.report.recomputed).toBe(0)
      expect(pending.centroids.has(3)).toBe(false)

      // 主题 2 的成员被清掉 → 质心行删掉
      db.prepare('DELETE FROM theme_moments WHERE theme_id = 2').run()
      const dropped = syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 30 })
      expect(dropped.report.deleted).toBe(1)
      expect(dropped.centroids.has(2)).toBe(false)
      expect(dropped.centroids.has(1)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('老库（members_hash 为 NULL）视为要重算', () => {
    const db = openDatabase(':memory:')
    try {
      seedCentroidGraph(db)
      syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 10 })
      db.prepare('UPDATE theme_centroids SET members_hash = NULL WHERE node_id = 2').run()

      const legacy = syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 20 })
      expect(legacy.report.stale).toBe(1)
      expect(legacy.report.recomputed).toBe(1)
      expect(legacy.report.reused).toBe(1)
      const row = db
        .prepare('SELECT members_hash FROM theme_centroids WHERE node_id = 2')
        .get() as { members_hash: string | null }
      expect(row.members_hash).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      db.close()
    }
  })

  it('refreshThemeCentroid 只动一个主题', () => {
    const db = openDatabase(':memory:')
    try {
      seedCentroidGraph(db)
      syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 10 })

      const refreshed = refreshThemeCentroid(db, 1, { model: MODEL, dim: DIM, now: 40 })
      expect(refreshed.status).toBe('ok')
      expect(refreshed.centroid?.memberEvents).toBe(3)

      const rows = db
        .prepare('SELECT node_id, updated_at FROM theme_centroids ORDER BY node_id ASC')
        .all() as Array<{ node_id: number; updated_at: number }>
      expect(rows).toEqual([
        { node_id: 1, updated_at: 40 },
        { node_id: 2, updated_at: 10 }
      ])

      // 没有成员的主题：删行并如实报 no-members
      db.prepare('DELETE FROM theme_moments WHERE theme_id = 2').run()
      expect(refreshThemeCentroid(db, 2, { model: MODEL, dim: DIM, now: 50 }).status).toBe(
        'no-members'
      )
      expect(readThemeCentroids(db, { model: MODEL }).centroids.has(2)).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('新时刻：只算它自己的质心', () => {
  it('只读被点名的时刻，不碰主题质心', () => {
    const db = openDatabase(':memory:')
    try {
      seedCentroidGraph(db)
      syncThemeCentroids(db, { model: MODEL, dim: DIM, now: 10 })
      seedMoment(db, 20, [6, 7])
      seedMoment(db, 21, [8])
      seedEventVector(db, 6, [1, 0, 0])
      seedEventVector(db, 7, [0, 1, 0])

      const result = maintainMomentVectors(db, [20, 21])
      expect(result.requested).toBe(2)
      expect(result.computed).toBe(1)
      expect(result.missing).toEqual([21]) // 事件 8 没有向量
      const vec = result.vectors.get(20) ?? []
      expect(vec[0]).toBeCloseTo(0.7071, 3)
      expect(vec[1]).toBeCloseTo(0.7071, 3)

      // 主题质心一行都没动
      const rows = db
        .prepare('SELECT node_id, updated_at FROM theme_centroids ORDER BY node_id ASC')
        .all() as Array<{ node_id: number; updated_at: number }>
      expect(rows).toEqual([
        { node_id: 1, updated_at: 10 },
        { node_id: 2, updated_at: 10 }
      ])
    } finally {
      db.close()
    }
  })

  it('时刻向量按成员事件均值 + L2；重复请求去重', () => {
    const db = openDatabase(':memory:')
    try {
      seedMoment(db, 30, [1, 2])
      seedEventVector(db, 1, [2, 0, 0])
      seedEventVector(db, 2, [0, 3, 0])
      const result = maintainMomentVectors(db, [30, 30, 999])
      expect(result.requested).toBe(2)
      expect(result.missing).toEqual([999])
      const vec = result.vectors.get(30) ?? []
      expect(vec[0]).toBeCloseTo(0.5547, 3)
      expect(vec[1]).toBeCloseTo(0.8321, 3)
    } finally {
      db.close()
    }
  })
})
