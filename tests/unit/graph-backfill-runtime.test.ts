import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import {
  resetGraphBackfillRuntimeState,
  runGraphBackfill,
  type GraphBackfillRuntimeDeps
} from '../../src/main/graph-backfill-runtime'
import type { Embedder } from '../../src/understand/embedding/types'

function at(hour: number): number {
  return new Date(2026, 9, 22, hour, 0, 0, 0).getTime()
}

function seedTheme(
  db: Db,
  id: number,
  title: string,
  summary: string,
  eventIds: readonly number[] = []
): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, 'knowledge', ?, ?, ?, ?, ?)`
  ).run(id, title, summary, at(9), at(10), JSON.stringify(eventIds))
}

function fakeEmbedder(): Embedder & { calls: number } {
  return {
    model: 'fake-bge',
    dim: 2,
    calls: 0,
    async embed(texts) {
      this.calls += 1
      // 两个主题给不同方向（相似度 0.9：够连边、不触发 0.95 合并）
      return texts.map((text) =>
        text.includes('主题 1') ? Float32Array.from([1, 0]) : Float32Array.from([0.9, 0.4359])
      )
    }
  }
}

function makeDeps(db: Db, overrides: Partial<GraphBackfillRuntimeDeps> = {}): GraphBackfillRuntimeDeps & {
  lines: Array<{ level: string; msg: string }>
} {
  const lines: Array<{ level: string; msg: string }> = []
  return {
    db,
    modelDir: 'Z:\\nope\\bge',
    minIntervalMs: 0,
    log: (level, msg) => {
      lines.push({ level, msg })
    },
    lines,
    ...overrides
  }
}

let dir: string

beforeEach(() => {
  resetGraphBackfillRuntimeState()
  dir = mkdtempSync(join(tmpdir(), 'gotcha-backfill-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetGraphBackfillRuntimeState()
})

describe('runGraphBackfill', () => {
  it('模型缺失时只回填结构（时刻/归属），并如实记日志', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      seedTheme(db, 1, '主题一', '摘要一', [1])
      const deps = makeDeps(db, { modelDir: join(dir, 'missing') })

      const result = await runGraphBackfill(deps)
      expect(result.status).toBe('done')
      expect(result.embeddings).toBeNull()
      expect(result.report?.moments.created).toBe(1)
      expect(result.report?.memberships.inserted).toBe(1)
      expect(deps.lines[0].msg).toContain('structure only')
    } finally {
      db.close()
    }
  })

  it('模型就绪时算向量并连边；同一模型目录会话复用', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      seedTheme(db, 1, '主题一', '摘要一')
      seedTheme(db, 2, '主题二', '摘要二')
      const embedder = fakeEmbedder()
      let created = 0
      const deps = makeDeps(db, {
        modelDir: join(dir, 'model'),
        createEmbedder: async () => {
          created += 1
          return embedder
        }
      })

      const first = await runGraphBackfill(deps)
      expect(first.embeddings?.embedded).toBe(2)
      expect(first.report?.edges?.inserted).toBe(1)

      // 第二次（间隔为 0）：向量已存在，不再送模型；会话仍复用
      const second = await runGraphBackfill(deps)
      expect(second.embeddings?.themes).toBe(0)
      expect(created).toBe(1)
      expect(embedder.calls).toBe(1)
    } finally {
      db.close()
    }
  })

  it('embedder 创建失败降级为结构回填，不抛错', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      seedTheme(db, 1, '主题一', '')
      const deps = makeDeps(db, {
        modelDir: join(dir, 'model'),
        createEmbedder: async () => {
          throw Object.assign(new Error('加载失败'), { code: 'session-failed' })
        }
      })

      const result = await runGraphBackfill(deps)
      expect(result.status).toBe('done')
      expect(result.embeddings).toBeNull()
      expect(result.report?.moments.created).toBe(1)
      expect(deps.lines.some((line) => line.level === 'warn')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('节流：间隔内重复打开直接跳过', async () => {
    const db = openDatabase(':memory:')
    try {
      insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts' })
      seedTheme(db, 1, '主题一', '')
      const deps = makeDeps(db, { minIntervalMs: 60_000, now: () => 1_000 })
      await runGraphBackfill(deps)
      const second = await runGraphBackfill(deps)
      expect(second.status).toBe('skipped')
      expect(second.reason).toBe('throttled')
    } finally {
      db.close()
    }
  })

  it('数据库写失败只记 warn，不向调用方抛错', async () => {
    const db = openDatabase(':memory:')
    const deps = makeDeps(db, { modelDir: join(dir, 'missing') })
    db.close() // 模拟退出时连接已关
    const result = await runGraphBackfill(deps)
    expect(result.status).toBe('done')
    expect(result.report).toBeNull()
    expect(deps.lines.some((line) => line.level === 'warn')).toBe(true)
  })
})
