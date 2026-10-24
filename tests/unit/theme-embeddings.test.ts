import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/db'
import { readThemeVectors } from '../../src/understand/graph-edges'
import type { Embedder } from '../../src/understand/embedding/types'
import {
  embedThemeVectors,
  listThemeTexts,
  themeEmbeddingText
} from '../../src/understand/theme-embeddings'

function seedTheme(
  db: Db,
  id: number,
  title: string,
  summary = '',
  options: { level?: number } = {}
): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, ?, 'knowledge', ?, ?, 1, 2, '[]')`
  ).run(id, options.level ?? 1, title, summary)
}

function fakeEmbedder(
  options: { dim?: number; model?: string; failAt?: number } = {}
): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    model: options.model ?? 'bge-small-zh-v1.5',
    dim: options.dim ?? 3,
    calls,
    async embed(texts) {
      calls.push([...texts])
      if (options.failAt !== undefined && calls.length === options.failAt) {
        throw Object.assign(new Error('推理失败'), { code: 'run-failed' })
      }
      return texts.map((text) => {
        const seed = text.length
        return Float32Array.from([seed % 7, 1, 0])
      })
    }
  }
}

describe('themeEmbeddingText', () => {
  it('标题 + 。 + 摘要；缺一边时不留多余标点', () => {
    expect(themeEmbeddingText('写代码', '调试 GUI')).toBe('写代码。调试 GUI')
    expect(themeEmbeddingText('写代码', '')).toBe('写代码')
    expect(themeEmbeddingText('', '调试 GUI')).toBe('调试 GUI')
    expect(themeEmbeddingText('  写代码  ', '  调试  ')).toBe('写代码。调试')
    expect(themeEmbeddingText('', '')).toBe('')
  })
})

describe('listThemeTexts', () => {
  it('只取 level=1；跳过空文本；onlyMissing 排除已有向量', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题一', '摘要一')
      seedTheme(db, 2, '主题二')
      seedTheme(db, 3, '', '')
      seedTheme(db, 4, 'level2', '', { level: 2 })

      const all = listThemeTexts(db)
      expect(all).toEqual([
        { id: 1, text: '主题一。摘要一' },
        { id: 2, text: '主题二' }
      ])

      await embedThemeVectors(db, fakeEmbedder({ dim: 3 }), { now: 1 })
      expect(listThemeTexts(db, { onlyMissing: true })).toEqual([])
      expect(listThemeTexts(db).map((item) => item.id)).toEqual([1, 2])
    } finally {
      db.close()
    }
  })
})

describe('embedThemeVectors', () => {
  it('写入归一化向量（模型名/维度/时间），只送非空主题', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题一', '摘要一')
      seedTheme(db, 2, '主题二')
      seedTheme(db, 3, '', '')

      const embedder = fakeEmbedder({ dim: 3 })
      const result = await embedThemeVectors(db, embedder, { now: 42 })
      expect(result.ok).toBe(true)
      expect(result.themes).toBe(2)
      expect(result.embedded).toBe(2)
      expect(result.model).toBe('bge-small-zh-v1.5')
      expect(result.dim).toBe(3)
      expect(embedder.calls).toEqual([['主题一。摘要一', '主题二']])

      const read = readThemeVectors(db, { model: 'bge-small-zh-v1.5' })
      expect(read.vectors.map((item) => item.nodeId)).toEqual([1, 2])
      expect(read.model).toBe('bge-small-zh-v1.5')
      const row = db
        .prepare('SELECT model, dim, updated_at FROM node_embeddings WHERE node_id = 1')
        .get() as { model: string; dim: number; updated_at: number }
      expect(row).toEqual({ model: 'bge-small-zh-v1.5', dim: 3, updated_at: 42 })
    } finally {
      db.close()
    }
  })

  it('onlyMissing：第二次不重复推理', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题一')
      const embedder = fakeEmbedder()
      const first = await embedThemeVectors(db, embedder, { now: 1 })
      expect(first.embedded).toBe(1)
      const second = await embedThemeVectors(db, embedder, { now: 2 })
      expect(second.themes).toBe(0)
      expect(second.embedded).toBe(0)
      expect(embedder.calls).toHaveLength(1)

      // 新主题出现后只补它
      seedTheme(db, 2, '主题二')
      const third = await embedThemeVectors(db, embedder, { now: 3 })
      expect(third.themes).toBe(1)
      expect(embedder.calls.at(-1)).toEqual(['主题二'])
    } finally {
      db.close()
    }
  })

  it('推理失败返回 ok:false 与错误码，已写批次保留', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题一')
      seedTheme(db, 2, '主题二')
      const embedder = fakeEmbedder({ failAt: 2 })
      const result = await embedThemeVectors(db, embedder, { now: 1, writeChunkSize: 1 })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('run-failed')
      expect(result.embedded).toBe(1) // 第一批已落库，幂等重跑会补第二批
      expect(db.prepare('SELECT COUNT(*) AS n FROM node_embeddings').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('维度不符的向量不写库（skipped 计数）', async () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, '主题一')
      const embedder: Embedder = {
        model: 'bge-small-zh-v1.5',
        dim: 512,
        async embed(texts) {
          return texts.map(() => Float32Array.from([1, 0, 0])) // 只有 3 维
        }
      }
      const result = await embedThemeVectors(db, embedder, { now: 1 })
      expect(result.ok).toBe(true)
      expect(result.embedded).toBe(0)
      expect(result.skipped).toBe(1)
    } finally {
      db.close()
    }
  })
})
