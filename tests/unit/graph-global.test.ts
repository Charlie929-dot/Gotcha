import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db'
import { queryGlobalGraph } from '../../src/understand/graph-query'

function at(day: number, hour: number): number {
  return new Date(2026, 9, day, hour, 0, 0, 0).getTime()
}

function seedTheme(
  db: ReturnType<typeof openDatabase>,
  id: number,
  options: { level?: number; type?: string; title?: string; tsStart?: number; eventIds?: number[] } = {}
): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, ?, ?, ?, '', ?, ?, ?)`
  ).run(
    id,
    options.level ?? 1,
    options.type ?? 'knowledge',
    options.title ?? `主题 ${id}`,
    options.tsStart ?? at(22, 9),
    (options.tsStart ?? at(22, 9)) + 3_600_000,
    JSON.stringify(options.eventIds ?? [])
  )
}

function seedMoment(db: ReturnType<typeof openDatabase>, id: number, dayKey: string, startTs: number): void {
  db.prepare(
    `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
     VALUES (?, ?, ?, ?, 'Code', 'a.ts', '', ?, 1)`
  ).run(id, startTs, startTs + 60_000, dayKey, JSON.stringify([id * 10]))
}

function seedMembership(
  db: ReturnType<typeof openDatabase>,
  themeId: number,
  momentId: number,
  source = 'owner'
): void {
  db.prepare(
    'INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at) VALUES (?, ?, 1.0, ?, 1)'
  ).run(themeId, momentId, source)
}

function seedEdge(
  db: ReturnType<typeof openDatabase>,
  id: number,
  src: number,
  dst: number,
  kind: 'ai' | 'embedding',
  weight = 0.8
): void {
  db.prepare(
    'INSERT INTO edges (id, src, dst, weight, kind, evidence) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, src, dst, weight, kind, kind === 'embedding' ? '{"model":"bge"}' : '同批')
}

function seedPosition(db: ReturnType<typeof openDatabase>, nodeId: number, x: number, y: number): void {
  db.prepare(
    'INSERT INTO node_positions (node_id, x, y, updated_at) VALUES (?, ?, ?, 1)'
  ).run(nodeId, x, y)
}

describe('queryGlobalGraph', () => {
  it('返回主题/时刻/多归属/只 embedding 边/位置，并统计 memberCount 与 degree', () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1, { title: '写代码', eventIds: [10, 20] })
      seedTheme(db, 2, { title: '查文档', eventIds: [20, 30] })
      seedTheme(db, 3, { type: 'protected', title: '内容已保护' })
      seedTheme(db, 4, { level: 2 })

      seedMoment(db, 1, '2026-10-22', at(22, 9))
      seedMoment(db, 2, '2026-10-23', at(23, 10))
      seedMoment(db, 3, '2026-10-23', at(23, 11)) // 无归属 → 默认不返回

      seedMembership(db, 1, 1)
      seedMembership(db, 1, 2, 'secondary')
      seedMembership(db, 2, 2) // 共享时刻
      seedMembership(db, 99, 3) // 主题不存在 → 丢弃

      seedEdge(db, 100, 1, 2, 'embedding', 0.9)
      seedEdge(db, 101, 2, 3, 'ai', 0.5) // 旧 ai 边默认不出现
      seedEdge(db, 102, 1, 99, 'embedding', 0.7) // 悬空端点 → 丢弃

      seedPosition(db, 1, 10, 20)
      seedPosition(db, 3, 30, 40)
      seedPosition(db, 99, 0, 0) // 非主题节点不返回

      const data = queryGlobalGraph(db)
      expect(data.themes.map((theme) => theme.id)).toEqual([1, 2, 3])
      expect(data.themes.map((theme) => theme.memberCount)).toEqual([2, 1, 0])
      expect(data.themes[0].sourceCount).toBe(2)
      expect(data.themes.map((theme) => theme.degree)).toEqual([1, 1, 0])

      expect(data.moments.map((moment) => moment.id)).toEqual([1, 2])
      expect(data.moments.every((moment) => moment.assigned)).toBe(true)

      expect(data.memberships.map((row) => [row.themeId, row.momentId, row.source])).toEqual([
        [1, 1, 'owner'],
        [1, 2, 'secondary'],
        [2, 2, 'owner']
      ])

      expect(data.edges.map((edge) => edge.id)).toEqual([100])
      expect(data.edges[0].kind).toBe('embedding')

      expect(data.positions).toEqual([
        { nodeId: 1, x: 10, y: 20 },
        { nodeId: 3, x: 30, y: 40 }
      ])

      expect(data.stats).toEqual({
        themes: 3,
        moments: 2,
        memberships: 3,
        edges: 1,
        positions: 2
      })
    } finally {
      db.close()
    }
  })

  it('选项：可含悬空时刻、可回退旧 ai 边、可不要位置', () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1)
      seedTheme(db, 2)
      seedMoment(db, 1, '2026-10-22', at(22, 9))
      seedMoment(db, 2, '2026-10-22', at(22, 10))
      seedMembership(db, 1, 1)
      seedEdge(db, 100, 1, 2, 'ai', 0.5)
      seedPosition(db, 1, 1, 2)

      const withOrphans = queryGlobalGraph(db, { includeOrphanMoments: true })
      expect(withOrphans.moments.map((moment) => [moment.id, moment.assigned])).toEqual([
        [1, true],
        [2, false]
      ])

      const legacy = queryGlobalGraph(db, { includeLegacyAiEdges: true })
      expect(legacy.edges.map((edge) => [edge.id, edge.kind])).toEqual([[100, 'ai']])

      const noPositions = queryGlobalGraph(db, { includePositions: false })
      expect(noPositions.positions).toEqual([])
      expect(noPositions.stats.positions).toBe(0)
    } finally {
      db.close()
    }
  })

  it('空库返回空图而不是抛错', () => {
    const db = openDatabase(':memory:')
    try {
      const data = queryGlobalGraph(db)
      expect(data).toEqual({
        themes: [],
        moments: [],
        memberships: [],
        edges: [],
        positions: [],
        stats: { themes: 0, moments: 0, memberships: 0, edges: 0, positions: 0 }
      })
    } finally {
      db.close()
    }
  })

  it('坏 event_ids 不抛错，按 0 个成员事件处理', () => {
    const db = openDatabase(':memory:')
    try {
      seedMoment(db, 1, '2026-10-22', at(22, 9))
      db.prepare('UPDATE moments SET event_ids = ? WHERE id = 1').run('{oops')
      seedTheme(db, 1)
      seedMembership(db, 1, 1)
      const data = queryGlobalGraph(db)
      expect(data.moments[0].eventIds).toEqual([])
    } finally {
      db.close()
    }
  })
})
