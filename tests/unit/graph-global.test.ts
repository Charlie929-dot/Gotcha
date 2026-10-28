import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase } from '../../src/db'
import {
  MOMENT_SUMMARY_PREVIEW_CHARS,
  queryGlobalGraph,
  queryMomentEvents,
  queryMomentSummary
} from '../../src/understand/graph-query'

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

function seedMoment(
  db: ReturnType<typeof openDatabase>,
  id: number,
  dayKey: string,
  startTs: number,
  summary = ''
): void {
  db.prepare(
    `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
     VALUES (?, ?, ?, ?, 'Code', 'a.ts', ?, ?, 1)`
  ).run(id, startTs, startTs + 60_000, dayKey, summary, JSON.stringify([id * 10]))
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

  it('列表摘要按 60 字截断并打标记，完整正文用 queryMomentSummary 现取', () => {
    const db = openDatabase(':memory:')
    try {
      const long = '长'.repeat(400)
      seedMoment(db, 1, '2026-10-22', at(22, 9), long)
      seedMoment(db, 2, '2026-10-22', at(22, 10), '短短一句')
      seedTheme(db, 1)
      seedMembership(db, 1, 1)
      seedMembership(db, 1, 2)

      const data = queryGlobalGraph(db)
      const byId = new Map(data.moments.map((moment) => [moment.id, moment]))
      expect(byId.get(1)?.ocrSummary).toBe('长'.repeat(MOMENT_SUMMARY_PREVIEW_CHARS))
      expect(byId.get(1)?.ocrTrimmed).toBe(true)
      expect(byId.get(2)?.ocrSummary).toBe('短短一句')
      expect(byId.get(2)?.ocrTrimmed).toBe(false)

      expect(queryMomentSummary(db, 1)).toEqual({ found: true, ocrSummary: long })

      // 老口径（导出 / 调试）：不截断、带成员事件 id
      const fullList = queryGlobalGraph(db, { ocrSummaryChars: 0, includeMomentEventIds: true })
      expect(fullList.moments.every((moment) => moment.ocrTrimmed === false)).toBe(true)
      expect(fullList.moments.find((moment) => moment.id === 1)?.ocrSummary).toBe(long)
      expect(fullList.moments.find((moment) => moment.id === 1)?.eventIds).toEqual([10])
    } finally {
      db.close()
    }
  })

  it('queryMomentSummary：不存在 / 非法 id 不建库也不抛错', () => {
    const db = openDatabase(':memory:')
    try {
      expect(queryMomentSummary(db, 42)).toEqual({ found: false, ocrSummary: null })
      expect(queryMomentSummary(db, 0).found).toBe(false)
      expect(queryMomentSummary(db, 1.5).found).toBe(false)
      seedMoment(db, 3, '2026-10-22', at(22, 9), '有摘要')
      expect(queryMomentSummary(db, 3)).toEqual({ found: true, ocrSummary: '有摘要' })
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
        dayActivity: [],
        stats: { themes: 0, moments: 0, memberships: 0, edges: 0, positions: 0 }
      })
    } finally {
      db.close()
    }
  })

  it('dayActivity：事件含未成时刻的积压，时刻按 day_key 计数，待归纳＝没归属主题的时刻', () => {
    const db = openDatabase(':memory:')
    try {
      // 10-22 两条事件（都进了时刻），10-21 一条事件（还没成时刻的积压）
      insertEvent(db, { ts: at(22, 9), app: 'Code', ocrText: 'a' })
      insertEvent(db, { ts: at(22, 10), app: 'Code', ocrText: 'b' })
      insertEvent(db, { ts: at(21, 9), app: 'Chrome', ocrText: 'c' })
      seedMoment(db, 1, '2026-10-22', at(22, 9))
      seedMoment(db, 2, '2026-10-22', at(22, 10))
      seedMoment(db, 3, '2026-10-21', at(21, 9))
      // 时刻 1 有主题归属 → 只有时刻 2 算「待归纳」；10-21 的时刻一直没主题
      seedTheme(db, 1)
      seedMembership(db, 1, 1)

      const data = queryGlobalGraph(db)
      // 时刻 1 挂上了主题 → 出现在图里；2 / 3 没归属，默认不画，但 dayActivity 仍按「这天有多忙」统计
      expect(data.moments.map((moment) => moment.id)).toEqual([1])
      expect(data.dayActivity).toEqual([
        { dayKey: '2026-10-21', events: 1, moments: 1, pending: 1 },
        // 事件 2 条都成了时刻（events 2 / moments 2），但只有 1 个时刻挂上了主题
        { dayKey: '2026-10-22', events: 2, moments: 2, pending: 1 }
      ])
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
      // 全局图列表默认不带成员事件 id（画布用不到，4k 时刻约 0.2 MB）
      expect(data.moments[0].eventIds).toBeUndefined()
      expect(queryGlobalGraph(db, { includeMomentEventIds: true }).moments[0].eventIds).toEqual([])
    } finally {
      db.close()
    }
  })

  it('已合并节点不出现：主题/归属/边/位置都按存活节点过滤', () => {
    const db = openDatabase(':memory:')
    try {
      seedTheme(db, 1)
      seedTheme(db, 2)
      seedTheme(db, 3)
      db.prepare('UPDATE nodes SET merged_into = 1 WHERE id = 2').run()
      seedMoment(db, 1, '2026-10-22', at(22, 9))
      seedMembership(db, 1, 1)
      seedMembership(db, 2, 1) // 源节点的残留归属（合并后应已迁走，这里验证查询过滤）
      seedEdge(db, 100, 1, 2, 'embedding')
      seedEdge(db, 101, 1, 3, 'embedding')
      seedPosition(db, 2, 1, 2)
      seedPosition(db, 3, 3, 4)

      const data = queryGlobalGraph(db)
      expect(data.themes.map((theme) => theme.id).sort()).toEqual([1, 3])
      expect(data.memberships).toEqual([
        { themeId: 1, momentId: 1, weight: 1, source: 'owner' }
      ])
      expect(data.edges.map((edge) => edge.id)).toEqual([101])
      expect(data.positions.map((position) => position.nodeId)).toEqual([3])
      expect(data.stats).toEqual({ themes: 2, moments: 1, memberships: 1, edges: 1, positions: 1 })
    } finally {
      db.close()
    }
  })
})

describe('queryMomentEvents', () => {
  it('返回时刻成员事件（按时间排序）并保留缺失 id', () => {
    const db = openDatabase(':memory:')
    try {
      const first = insertEvent(db, { ts: at(22, 9), app: 'Code', windowTitle: 'a.ts', ocrText: 'x' })
      const second = insertEvent(db, { ts: at(22, 10), app: 'Chrome', windowTitle: '文档', ocrText: 'y' })
      seedMoment(db, 7, '2026-10-22', at(22, 9))
      // 故意乱序 + 一个不存在的 id
      db.prepare('UPDATE moments SET event_ids = ? WHERE id = 7').run(
        JSON.stringify([second, 999_999, first])
      )

      const result = queryMomentEvents(db, 7)
      expect(result.found).toBe(true)
      expect(result.malformed).toBe(false)
      expect(result.events.map((event) => event.id)).toEqual([first, second])
      expect(result.events[0].windowTitle).toBe('a.ts')
      expect(result.missingIds).toEqual([999_999])
    } finally {
      db.close()
    }
  })

  it('时刻不存在 / 非法 id / 坏 JSON 都不抛错', () => {
    const db = openDatabase(':memory:')
    try {
      expect(queryMomentEvents(db, 42)).toEqual({
        found: false,
        events: [],
        missingIds: [],
        malformed: false
      })
      expect(queryMomentEvents(db, 0).found).toBe(false)
      expect(queryMomentEvents(db, 1.5).found).toBe(false)

      seedMoment(db, 8, '2026-10-22', at(22, 9))
      db.prepare('UPDATE moments SET event_ids = ? WHERE id = 8').run('{oops')
      const malformed = queryMomentEvents(db, 8)
      expect(malformed.found).toBe(true)
      expect(malformed.malformed).toBe(true)
      expect(malformed.events).toEqual([])
    } finally {
      db.close()
    }
  })
})
