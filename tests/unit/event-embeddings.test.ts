import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import {
  countMissingEventVectors,
  embedEventVectors,
  eventEmbeddingText,
  listEventTexts,
  readEventVectors
} from '../../src/understand/event-embeddings'
import type { Embedder } from '../../src/understand/embedding/types'

function at(hour: number): number {
  return new Date(2026, 9, 22, hour, 0, 0, 0).getTime()
}

/** 事件 1,2 → 时刻 10（有 owner 归属）；事件 3 → 时刻 11（无归属） */
function seed(db: Db): void {
  insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts', ocrText: '写 代码' })
  insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts', ocrText: 'a.ts 写代码' })
  insertEvent(db, { ts: at(11), app: 'Chrome', windowTitle: 'docs', ocrText: '' })
  db.prepare(
    `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
     VALUES (10, ?, ?, '2026-10-22', 'Code', 'a.ts', '', '[1,2]', 1),
            (11, ?, ?, '2026-10-22', 'Chrome', 'docs', '', '[3]', 1)`
  ).run(at(9), at(9), at(11), at(11))
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (1, 1, 'knowledge', '主题一', '', 1, 2, '[1]')`
  ).run()
  db.prepare(
    `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (1, 10, 1.0, 'owner', 1)`
  ).run()
}

function fakeEmbedder(options: { dim?: number; failAt?: number } = {}): Embedder & {
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    model: 'fake-bge',
    dim: options.dim ?? 3,
    calls,
    async embed(texts) {
      calls.push([...texts])
      if (options.failAt !== undefined && calls.length === options.failAt) {
        throw Object.assign(new Error('推理失败'), { code: 'run-failed' })
      }
      return texts.map((text) => Float32Array.from([text.length % 5, 1, 0]))
    }
  }
}

describe('eventEmbeddingText', () => {
  it('标题 + 。 + OCR；标题已在正文开头不重复；压缩空白与截断', () => {
    expect(eventEmbeddingText('a.ts', '写代码')).toBe('a.ts。写代码')
    expect(eventEmbeddingText('a.ts', 'a.ts 写代码')).toBe('a.ts 写代码')
    expect(eventEmbeddingText('', '只有正文')).toBe('只有正文')
    expect(eventEmbeddingText('只有标题', '')).toBe('只有标题')
    expect(eventEmbeddingText('  标题  ', '  正   文 ')).toBe('标题。正 文')
    expect(eventEmbeddingText('', 'a'.repeat(900)).length).toBe(600)
  })
})

describe('listEventTexts', () => {
  it('assigned 只取 owner/manual 归属时刻引用的事件；all 取全部；onlyMissing 排除已算', async () => {
    const db = openDatabase(':memory:')
    try {
      seed(db)
      const assigned = listEventTexts(db, { model: 'fake-bge' })
      expect(assigned.map((item) => item.id)).toEqual([1, 2])
      expect(listEventTexts(db, { scope: 'all' }).map((item) => item.id)).toEqual([1, 2, 3])

      await embedEventVectors(db, fakeEmbedder(), { now: 5 })
      expect(listEventTexts(db, { onlyMissing: true, model: 'fake-bge' })).toEqual([])
      // 换模型后旧向量不算
      expect(listEventTexts(db, { onlyMissing: true, model: 'other' }).map((item) => item.id)).toEqual([1, 2])
    } finally {
      db.close()
    }
  })
})

describe('embedEventVectors', () => {
  it('写入模型/维度/时间；第二次 onlyMissing 不重复推理', async () => {
    const db = openDatabase(':memory:')
    try {
      seed(db)
      const embedder = fakeEmbedder()
      const first = await embedEventVectors(db, embedder, { now: 42 })
      expect(first.ok).toBe(true)
      expect(first.events).toBe(2)
      expect(first.embedded).toBe(2)
      expect(first.model).toBe('fake-bge')
      expect(first.dim).toBe(3)
      expect(embedder.calls).toEqual([['a.ts。写 代码', 'a.ts 写代码']])

      const row = db
        .prepare('SELECT model, dim, updated_at FROM event_embeddings WHERE event_id = 1')
        .get()
      expect(row).toEqual({ model: 'fake-bge', dim: 3, updated_at: 42 })

      const second = await embedEventVectors(db, embedder, { now: 43 })
      expect(second.events).toBe(0)
      expect(second.embedded).toBe(0)
      expect(embedder.calls).toHaveLength(1)

      expect(countMissingEventVectors(db, 'fake-bge')).toBe(0)
      expect(countMissingEventVectors(db, 'other')).toBe(2)
    } finally {
      db.close()
    }
  })

  it('推理失败返回 ok:false 与错误码，已写批次保留', async () => {
    const db = openDatabase(':memory:')
    try {
      seed(db)
      const result = await embedEventVectors(db, fakeEmbedder({ failAt: 2 }), {
        now: 1,
        writeChunkSize: 1
      })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('run-failed')
      expect(result.embedded).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS n FROM event_embeddings').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('维度不符不写库（skipped 计数）', async () => {
    const db = openDatabase(':memory:')
    try {
      seed(db)
      const embedder: Embedder = {
        model: 'fake-bge',
        dim: 512,
        async embed(texts) {
          return texts.map(() => Float32Array.from([1, 0, 0]))
        }
      }
      const result = await embedEventVectors(db, embedder, { now: 1 })
      expect(result.embedded).toBe(0)
      expect(result.skipped).toBe(2)
    } finally {
      db.close()
    }
  })
})

describe('readEventVectors', () => {
  it('按模型读回；维度不一致的行跳过', async () => {
    const db = openDatabase(':memory:')
    try {
      seed(db)
      await embedEventVectors(db, fakeEmbedder(), { now: 1 })
      const read = readEventVectors(db, { model: 'fake-bge' })
      expect(read.model).toBe('fake-bge')
      expect([...read.vectors.keys()]).toEqual([1, 2])

      db.prepare(
        `INSERT INTO event_embeddings (event_id, model, dim, vec, updated_at)
         VALUES (3, 'fake-bge', 9, x'00000000', 1)`
      ).run()
      expect(readEventVectors(db, { model: 'fake-bge' }).skipped).toBe(1)
      expect(readEventVectors(db, { model: 'other' }).vectors.size).toBe(0)
    } finally {
      db.close()
    }
  })
})
