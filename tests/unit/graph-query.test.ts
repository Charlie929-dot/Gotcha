import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { queryGraphDay, queryNodeEvents } from '../../src/understand/graph-query'

function at(hour: number, minute = 0): number {
  const date = new Date(2026, 9, 22, hour, minute, 0, 0)
  return date.getTime()
}

function dayRange(): { from: number; to: number } {
  return { from: at(0), to: at(23, 59) }
}

interface SeedNode {
  id: number
  level?: number
  type?: string
  title?: string
  summary?: string
  tsStart: number
  tsEnd?: number
  sourceEvents?: string | null
}

function seedNode(db: Db, node: SeedNode): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    node.id,
    node.level ?? 1,
    node.type ?? 'knowledge',
    node.title ?? `节点 ${node.id}`,
    node.summary ?? '',
    node.tsStart,
    node.tsEnd ?? node.tsStart,
    node.sourceEvents ?? '[]'
  )
}

function seedEdge(db: Db, id: number, src: number, dst: number, weight = 0.5): void {
  db.prepare(
    "INSERT INTO edges (id, src, dst, weight, kind, evidence) VALUES (?, ?, ?, ?, 'ai', '理由')"
  ).run(id, src, dst, weight)
}

describe('queryGraphDay', () => {
  it('只返回与日窗口相交的 level=1 节点，并统计 source_events / degree', () => {
    const db = openDatabase(':memory:')
    seedNode(db, { id: 1, tsStart: at(9), tsEnd: at(10) })
    seedNode(db, { id: 2, tsStart: at(11), tsEnd: at(12) })
    // 前一天：不与该日相交
    seedNode(db, { id: 3, tsStart: at(0) - 86_400_000, tsEnd: at(0) - 86_400_000 + 60_000 })
    // 跨午夜：ts_start 在前一天 23:00、ts_end 在当天 01:00，应与当天相交
    seedNode(db, { id: 4, tsStart: at(0) - 3_600_000, tsEnd: at(1) })
    // level 2：M2 不展示
    seedNode(db, { id: 5, level: 2, tsStart: at(15) })
    // 坏 source_events 不抛错，sourceCount 记 0
    seedNode(db, { id: 6, tsStart: at(16), sourceEvents: '{oops' })

    seedEdge(db, 100, 1, 2, 0.8)
    seedEdge(db, 101, 1, 4, 0.4)
    seedEdge(db, 102, 1, 3, 0.9) // 3 不在结果集 → 丢弃
    seedEdge(db, 103, 5, 1, 0.2) // 5 不在结果集 → 丢弃

    db.prepare('UPDATE nodes SET source_events = ? WHERE id = 1').run(JSON.stringify([7, 8, 8]))

    const data = queryGraphDay(db, dayRange().from, dayRange().to)
    expect(data.nodes.map((node) => node.id)).toEqual([4, 1, 2, 6])
    expect(data.nodes.find((node) => node.id === 1)?.sourceCount).toBe(2)
    expect(data.nodes.find((node) => node.id === 1)?.degree).toBe(2)
    expect(data.nodes.find((node) => node.id === 2)?.degree).toBe(1)
    expect(data.nodes.find((node) => node.id === 6)?.sourceCount).toBe(0)
    expect(data.edges.map((edge) => edge.id).sort((a, b) => a - b)).toEqual([100, 101])
    expect(data.edges.find((edge) => edge.id === 100)?.weight).toBe(0.8)
    db.close()
  })

  it('空日 / 非法时间区间返回空图', () => {
    const db = openDatabase(':memory:')
    seedNode(db, { id: 1, tsStart: at(9) })

    expect(queryGraphDay(db, at(0) + 5 * 86_400_000, at(23) + 5 * 86_400_000)).toEqual({
      nodes: [],
      edges: []
    })
    expect(queryGraphDay(db, Number.NaN, at(23))).toEqual({ nodes: [], edges: [] })
    expect(queryGraphDay(db, at(12), at(11))).toEqual({ nodes: [], edges: [] })
    db.close()
  })

  it('无节点时不返回任何边', () => {
    const db = openDatabase(':memory:')
    seedEdge(db, 100, 1, 2)
    expect(queryGraphDay(db, dayRange().from, dayRange().to)).toEqual({ nodes: [], edges: [] })
    db.close()
  })
})

describe('queryNodeEvents', () => {
  it('按 source_events 取事件并按时间排序，坏 JSON 不抛错', () => {
    const db = openDatabase(':memory:')
    const later = insertEvent(db, { ts: at(10), app: 'chrome', windowTitle: 'B', ocrText: 'b' })
    const earlier = insertEvent(db, { ts: at(9), app: 'notepad', windowTitle: 'A', ocrText: 'a' })
    const sensitive = insertEvent(db, {
      ts: at(11),
      app: 'chrome',
      windowTitle: 'C',
      ocrText: 'secret',
      sensitive: 1
    })
    seedNode(db, {
      id: 1,
      tsStart: at(9),
      tsEnd: at(11),
      sourceEvents: JSON.stringify([later, earlier, sensitive, later])
    })

    const result = queryNodeEvents(db, 1)
    expect(result.found).toBe(true)
    expect(result.malformed).toBe(false)
    expect(result.events.map((event) => event.id)).toEqual([earlier, later, sensitive])
    expect(result.events[0]).toMatchObject({ app: 'notepad', windowTitle: 'A', sensitive: 0 })
    expect(result.events[2].sensitive).toBe(1)
    expect(result.missingIds).toEqual([])
    db.close()
  })

  it('缺失事件 id 单独计数（可溯验收要求为 0），坏 JSON 标记 malformed', () => {
    const db = openDatabase(':memory:')
    const existing = insertEvent(db, { ts: at(9), app: 'chrome', ocrText: 'x' })
    seedNode(db, { id: 1, tsStart: at(9), sourceEvents: JSON.stringify([existing, 999]) })
    seedNode(db, { id: 2, tsStart: at(9), sourceEvents: '{bad json' })
    seedNode(db, { id: 3, tsStart: at(9), sourceEvents: JSON.stringify([1, 'x', -5]) })

    const result = queryNodeEvents(db, 1)
    expect(result.events.map((event) => event.id)).toEqual([existing])
    expect(result.missingIds).toEqual([999])

    const bad = queryNodeEvents(db, 2)
    expect(bad).toEqual({ found: true, events: [], missingIds: [], malformed: true })

    const mixed = queryNodeEvents(db, 3)
    // 只有正整数 id 会被采用；'x' / -5 直接忽略（坏数据，不当作缺失）
    expect(mixed.events.map((event) => event.id)).toEqual([existing])
    expect(mixed.missingIds).toEqual([])
    db.close()
  })

  it('节点不存在 / 非法 id 返回 found=false', () => {
    const db = openDatabase(':memory:')
    expect(queryNodeEvents(db, 123)).toEqual({
      found: false,
      events: [],
      missingIds: [],
      malformed: false
    })
    expect(queryNodeEvents(db, Number.NaN).found).toBe(false)
    db.close()
  })

  it('已合并节点跟随到存活节点（旧引用不断链）', () => {
    const db = openDatabase(':memory:')
    const eventId = insertEvent(db, { ts: at(9), app: 'chrome', ocrText: 'x' })
    seedNode(db, { id: 1, tsStart: at(9), sourceEvents: JSON.stringify([eventId]) })
    seedNode(db, { id: 2, tsStart: at(9), sourceEvents: '[]' })
    db.prepare('UPDATE nodes SET merged_into = 1 WHERE id = 2').run()

    const result = queryNodeEvents(db, 2)
    expect(result.found).toBe(true)
    expect(result.events.map((event) => event.id)).toEqual([eventId])
    db.close()
  })
})
