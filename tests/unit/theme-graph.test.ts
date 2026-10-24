import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { backfillThemeGraph } from '../../src/understand/graph-backfill'
import { queryGlobalGraph } from '../../src/understand/graph-query'
import type { Embedder } from '../../src/understand/embedding/types'
import { GRAPH_THRESHOLD_DEFAULTS, type GraphThresholds } from '../../src/understand/graph-thresholds'

function at(hour: number, minute = 0): number {
  return new Date(2026, 9, 22, hour, minute, 0, 0).getTime()
}

function seedTheme(db: Db, id: number, type: string, eventIds: readonly number[], summary = ''): void {
  db.prepare(
    `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  ).run(id, type, `主题 ${id}`, summary, at(9), at(14), JSON.stringify(eventIds))
}

/**
 * 关键词 → 向量（已归一化）：
 * - 审查草案 / 主题 1、2 → [1,0]
 * - 设计文档 / 主题 3 → [0.6,0.8]
 * - 周报 / 主题 4 → [0,1]
 */
function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  const mapping: Array<[string, number[]]> = [
    ['审查草案', [1, 0]],
    ['设计文档', [0.6, 0.8]],
    ['周报', [0, 1]],
    ['主题 1', [1, 0]],
    ['主题 2', [1, 0]],
    ['主题 3', [0.6, 0.8]],
    ['主题 4', [0, 1]]
  ]
  return {
    model: 'fake-bge',
    dim: 2,
    calls,
    async embed(texts) {
      calls.push([...texts])
      return texts.map((text) => {
        for (const [needle, values] of mapping) {
          if (text.includes(needle)) return Float32Array.from(values)
        }
        return Float32Array.from([1, 0])
      })
    }
  }
}

const THRESHOLDS: GraphThresholds = {
  ...GRAPH_THRESHOLD_DEFAULTS,
  themeMergeSim: 0.95,
  themeMemberMinSim: 0.75,
  themeDuplicateSim: 0.95,
  themeSecondaryMax: 2,
  edgeMinSim: 0.5,
  edgeTopK: 4,
  edgeMutual: true
}

function seedGraph(db: Db): void {
  insertEvent(db, { ts: at(9), app: 'Code', windowTitle: 'a.ts', ocrText: '审查草案 A' })
  insertEvent(db, { ts: at(9, 1), app: 'Code', windowTitle: 'a.ts', ocrText: '审查草案 B' })
  insertEvent(db, { ts: at(11), app: 'Chrome', windowTitle: '设计', ocrText: '设计文档 C' })
  insertEvent(db, { ts: at(13), app: 'Word', windowTitle: '周报', ocrText: '周报 D' })

  seedTheme(db, 1, 'knowledge', [1, 2], '摘要一')
  seedTheme(db, 2, 'knowledge', [1, 2], '摘要二')
  seedTheme(db, 3, 'activity', [3], '设计摘要')
  seedTheme(db, 4, 'activity', [4], '周报摘要')
}

describe('backfillThemeGraph', () => {
  it('近重复主题合并（同 type）→ 重算向量/质心 → 连边 → 次归属；第二次幂等', async () => {
    const db = openDatabase(':memory:')
    try {
      seedGraph(db)
      const embedder = fakeEmbedder()
      const first = await backfillThemeGraph(db, { now: 100, embedder, thresholds: THRESHOLDS })

      expect(first.deferred).toBeNull()
      expect(first.events?.embedded).toBe(4)
      expect(first.merges?.applied).toBe(1)
      expect(first.merges?.merges[0].into).toBe(1)
      expect(first.merges?.merges[0].from).toEqual([2])
      expect(first.centroids?.themes).toBe(3)
      expect(first.secondary?.inserted).toBe(2)
      expect(first.structure.edges?.inserted).toBe(2)

      // 合并后：存活 3 个主题，源节点不出现在全局图
      const graph = queryGlobalGraph(db)
      expect(graph.themes.map((theme) => theme.id).sort()).toEqual([1, 3, 4])
      expect(graph.memberships.filter((row) => row.source === 'owner')).toHaveLength(3)
      expect(graph.memberships.filter((row) => row.source === 'secondary')).toHaveLength(2)

      const audit = db.prepare('SELECT from_node, into_node FROM node_merges').all()
      expect(audit).toEqual([{ from_node: 2, into_node: 1 }])

      // 第二次：没有新向量/新合并；边全量替换、次归属不重复写
      const second = await backfillThemeGraph(db, { now: 101, embedder, thresholds: THRESHOLDS })
      expect(second.events?.embedded).toBe(0)
      expect(second.merges).toBeNull()
      expect(second.secondary?.inserted).toBe(0)
      expect(second.structure.edges).toEqual({ deleted: 2, inserted: 2 })
      // 第三次运行仍然没有新推理
      const third = await backfillThemeGraph(db, { now: 102, embedder, thresholds: THRESHOLDS })
      expect(embedder.calls).toHaveLength(3)
      expect(third.secondary?.planned).toBe(2)
    } finally {
      db.close()
    }
  })

  it('关闭合并/次归属时只连边', async () => {
    const db = openDatabase(':memory:')
    try {
      seedGraph(db)
      const report = await backfillThemeGraph(db, {
        now: 100,
        embedder: fakeEmbedder(),
        thresholds: THRESHOLDS,
        merge: false,
        secondary: false
      })
      expect(report.merges).toBeNull()
      expect(report.secondary).toBeNull()
      expect(db.prepare('SELECT COUNT(*) AS n FROM node_merges').get()).toEqual({ n: 0 })
      expect(db.prepare("SELECT COUNT(*) AS n FROM theme_moments WHERE source = 'secondary'").get()).toEqual({
        n: 0
      })
    } finally {
      db.close()
    }
  })

  it('没有 embedder 时退回旧路径：deferred 标记、不碰事件向量/合并', async () => {
    const db = openDatabase(':memory:')
    try {
      seedGraph(db)
      const report = await backfillThemeGraph(db, { now: 100, thresholds: THRESHOLDS })
      expect(report.deferred).toBe('no-embedder')
      expect(report.events).toBeNull()
      expect(report.merges).toBeNull()
      expect(report.structure.edges).toBeNull()
      expect(db.prepare("SELECT COUNT(*) AS n FROM event_embeddings").get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })
})
