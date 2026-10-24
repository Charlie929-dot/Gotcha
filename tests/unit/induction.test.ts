import { describe, expect, it } from 'vitest'
import { openDatabase, insertEvent } from '../../src/db'
import { readCursor } from '../../src/understand/cloud/batch'
import {
  persistInduction,
  readUsage,
  type InductionPersistInput
} from '../../src/understand/induction'
import type { Moment } from '../../src/understand/cloud/batch'
import type { InductionResult } from '../../src/understand/structure/schema'

const DAY = 24 * 60 * 60 * 1000

function moment(overrides: Partial<Moment> = {}): Moment {
  return {
    app: 'code.exe',
    title: 'src/understand/service.ts',
    startTs: 1_700_000_000_000,
    endTs: 1_700_000_060_000,
    ocr: 'induction service',
    eventIds: [1, 2],
    sensitive: false,
    ...overrides
  }
}

function result(overrides: Partial<InductionResult> = {}): InductionResult {
  return {
    nodes: [
      { title: '实现归纳调度', summary: '写了 service 调度与暂停语义', type: 'activity', eventIds: [1, 2] }
    ],
    edges: [],
    ...overrides
  }
}

function input(overrides: Partial<InductionPersistInput> = {}): InductionPersistInput {
  return {
    result: result(),
    moments: [moment()],
    cursor: { ts: 1_700_000_060_000, id: 2 },
    usage: { calls: 1, promptTokens: 100, completionTokens: 20 },
    now: 1_700_000_100_000,
    ...overrides
  }
}

function setup(): {
  db: ReturnType<typeof openDatabase>
  close: () => void
} {
  const db = openDatabase(':memory:')
  insertEvent(db, { ts: 1_700_000_000_000, app: 'code.exe', windowTitle: 'service.ts' })
  insertEvent(db, { ts: 1_700_000_060_000, app: 'code.exe', windowTitle: 'service.ts' })
  return { db, close: () => db.close() }
}

describe('persistInduction · 单事务落库', () => {
  it('插入节点与边（level=1 / kind=ai / source_events / ts 区间）', () => {
    const { db, close } = setup()
    try {
      persistInduction(
        db,
        input({
          result: result({
            nodes: [
              { title: 'A', summary: 'S', type: 'knowledge', eventIds: [1] },
              { title: 'B', summary: 'S', type: 'activity', eventIds: [2] }
            ],
            edges: [{ from: 0, to: 1, weight: 0.5, evidence: 'x' }]
          })
        })
      )
      const nodes = db
        .prepare('SELECT id, level, type, title, ts_start, ts_end, source_events FROM nodes ORDER BY id')
        .all() as Array<Record<string, unknown>>
      expect(nodes).toHaveLength(2)
      expect(nodes[0]).toMatchObject({ level: 1, type: 'knowledge', title: 'A', ts_start: 1_700_000_000_000 })
      expect(JSON.parse(String(nodes[0].source_events))).toEqual([1])
      expect(nodes[1]).toMatchObject({ level: 1, type: 'activity', title: 'B', ts_end: 1_700_000_060_000 })
      expect(db.prepare('SELECT src, dst, kind, weight, evidence FROM edges').get()).toMatchObject({
        src: nodes[0].id,
        dst: nodes[1].id,
        kind: 'ai',
        weight: 0.5,
        evidence: 'x'
      })
    } finally {
      close()
    }
  })

  it('同本地日 + 同 type + 归一化标题合并：并集 source_events、扩展区间、摘要取更长', () => {
    const { db, close } = setup()
    try {
      const ts = 1_700_000_000_000
      persistInduction(
        db,
        input({
          moments: [moment({ startTs: ts, endTs: ts + 60_000, eventIds: [1, 2] })],
          result: { nodes: [{ title: '  实现归纳调度  ', summary: '短摘要', type: 'activity', eventIds: [1, 2] }], edges: [] }
        })
      )
      insertEvent(db, { ts: ts + 3_600_000, app: 'code.exe' })
      persistInduction(
        db,
        input({
          moments: [moment({ startTs: ts + 3_600_000, endTs: ts + 3_660_000, eventIds: [3] })],
          cursor: { ts: ts + 3_660_000, id: 3 },
          result: {
            nodes: [{ title: '实现归纳调度', summary: '更长一些的摘要内容', type: 'activity', eventIds: [3] }],
            edges: []
          }
        })
      )
      const rows = db
        .prepare('SELECT id, summary, ts_start, ts_end, source_events FROM nodes')
        .all() as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(rows[0].summary).toBe('更长一些的摘要内容')
      expect(rows[0].ts_start).toBe(ts)
      expect(rows[0].ts_end).toBe(ts + 3_660_000)
      expect(JSON.parse(String(rows[0].source_events))).toEqual([1, 2, 3])
    } finally {
      close()
    }
  })

  it('不同本地日 / 不同 type 不合并', () => {
    const { db, close } = setup()
    try {
      const ts = 1_700_000_000_000
      persistInduction(db, input({ moments: [moment({ startTs: ts, eventIds: [1] })], result: { nodes: [{ title: 'T', summary: 'S', type: 'activity', eventIds: [1] }], edges: [] } }))
      persistInduction(
        db,
        input({
          now: ts + 10 * 60_000,
          moments: [moment({ startTs: ts + DAY, eventIds: [2] })],
          result: {
            nodes: [
              { title: 'T', summary: 'S', type: 'activity', eventIds: [2] },
              { title: 'T', summary: 'S', type: 'knowledge', eventIds: [2] }
            ],
            edges: []
          }
        })
      )
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 3 })
    } finally {
      close()
    }
  })

  it('边按 (src, dst, kind=ai) 去重：weight 取最大、evidence 保留非空', () => {
    const { db, close } = setup()
    try {
      persistInduction(
        db,
        input({
          result: {
            nodes: [
              { title: 'A', summary: 'S', type: 'knowledge', eventIds: [1] },
              { title: 'B', summary: 'S', type: 'activity', eventIds: [2] }
            ],
            edges: [{ from: 0, to: 1, weight: 0.4, evidence: '第一次理由' }]
          }
        })
      )
      persistInduction(
        db,
        input({
          result: {
            nodes: [
              { title: 'A', summary: 'S', type: 'knowledge', eventIds: [1] },
              { title: 'B', summary: 'S', type: 'activity', eventIds: [2] }
            ],
            edges: [{ from: 0, to: 1, weight: 0.9, evidence: '第二次理由' }]
          }
        })
      )
      const rows = db.prepare("SELECT src, dst, weight, kind, evidence FROM edges").all() as Array<
        Record<string, unknown>
      >
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ weight: 0.9, kind: 'ai', evidence: '第一次理由' })
    } finally {
      close()
    }
  })

  it('敏感时刻生成占位节点：type=protected，同一天合并，不含原文', () => {
    const { db, close } = setup()
    try {
      const ts = 1_700_000_000_000
      persistInduction(
        db,
        input({
          result: { nodes: [], edges: [] },
          moments: [moment({ startTs: ts, endTs: ts + 1_000, eventIds: [1, 2] })],
          excludedEventIds: [1, 2]
        })
      )
      const row = db.prepare('SELECT type, title, summary, source_events FROM nodes').get() as Record<
        string,
        unknown
      >
      expect(row).toMatchObject({
        type: 'protected',
        title: '内容已保护',
        summary: '该时刻含敏感内容，未出云（本地占位）'
      })
      expect(JSON.parse(String(row.source_events))).toEqual([1, 2])
      // 占位节点内容不含任何原文
      expect(JSON.stringify(row)).not.toContain('src/understand')
    } finally {
      close()
    }
  })

  it('整段时刻被忽略：写本地「未归纳时段」兜底节点，同一天合并、统计 uncovered', () => {
    const { db, close } = setup()
    try {
      const ts = 1_700_000_000_000
      const stats = persistInduction(
        db,
        input({
          result: { nodes: [], edges: [] },
          moments: [moment({ startTs: ts, endTs: ts + 1_000, eventIds: [1, 2] })],
          uncoveredEventIds: [1, 2]
        })
      )
      expect(stats.uncovered).toBe(2)
      const row = db.prepare('SELECT type, title, summary, source_events FROM nodes').get() as Record<
        string,
        unknown
      >
      expect(row).toMatchObject({
        type: 'activity',
        title: '未归纳时段',
        summary: '该时段模型未归纳，本地兜底（未出云）'
      })
      expect(JSON.parse(String(row.source_events))).toEqual([1, 2])
      // 兜底内容不含原文
      expect(JSON.stringify(row)).not.toContain('src/understand')
    } finally {
      close()
    }
  })

  it('「未归纳时段」与「内容已保护」是两个节点，不会互相合并', () => {
    const { db, close } = setup()
    try {
      const ts = 1_700_000_000_000
      persistInduction(
        db,
        input({
          result: { nodes: [], edges: [] },
          moments: [moment({ startTs: ts, endTs: ts + 1_000, eventIds: [1, 2] })],
          excludedEventIds: [1],
          uncoveredEventIds: [2]
        })
      )
      const rows = db.prepare('SELECT type, title FROM nodes ORDER BY id').all()
      expect(rows).toEqual([
        { type: 'protected', title: '内容已保护' },
        { type: 'activity', title: '未归纳时段' }
      ])
    } finally {
      close()
    }
  })

  it('游标与节点写入同一事务；今日用量累加（calls / prompt_tokens / completion_tokens）', () => {
    const { db, close } = setup()
    try {
      const now = 1_700_000_100_000
      persistInduction(db, input({ now, cursor: { ts: 1_700_000_060_000, id: 2 } }))
      persistInduction(
        db,
        input({ now, cursor: { ts: 1_700_000_200_000, id: 9 }, usage: { calls: 2, promptTokens: 50, completionTokens: 5 } })
      )
      expect(readCursor(db)).toEqual({ ts: 1_700_000_200_000, id: 9 })
      expect(readUsage(db, now)).toEqual({ calls: 3, promptTokens: 150, completionTokens: 25 })
    } finally {
      close()
    }
  })

  it('同一天多次占位合并为一个节点', () => {
    const { db, close } = setup()
    try {
      const ts = 1_700_000_000_000
      persistInduction(
        db,
        input({
          result: { nodes: [], edges: [] },
          moments: [moment({ startTs: ts, endTs: ts + 1_000, eventIds: [1] })],
          excludedEventIds: [1]
        })
      )
      persistInduction(
        db,
        input({
          result: { nodes: [], edges: [] },
          moments: [moment({ startTs: ts + 3_600_000, endTs: ts + 3_601_000, eventIds: [2] })],
          excludedEventIds: [2]
        })
      )
      const rows = db.prepare('SELECT ts_start, ts_end, source_events FROM nodes').all() as Array<
        Record<string, unknown>
      >
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ ts_start: ts, ts_end: ts + 3_601_000 })
      expect(JSON.parse(String(rows[0].source_events))).toEqual([1, 2])
    } finally {
      close()
    }
  })
})
