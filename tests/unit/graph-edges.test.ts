import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/db'
import {
  buildEmbeddingEdges,
  cosineSimilarity,
  EMBEDDING_EDGE_DEFAULTS,
  normalizeVector,
  readThemeVectors,
  writeEmbeddingEdges,
  writeThemeVectors,
  type ThemeVector
} from '../../src/understand/graph-edges'

/** 3 维向量便于手算（真模型是 512 维，输入口径一致） */
function vec(x: number, y: number, z = 0): Float32Array {
  return Float32Array.from([x, y, z])
}

function vectorOf(nodeId: number, x: number, y: number, z = 0): ThemeVector {
  return { nodeId, vec: normalizeVector(vec(x, y, z)) }
}

describe('cosineSimilarity / normalizeVector', () => {
  it('同向=1、正交=0、反向=-1、维度不一致=0', () => {
    expect(cosineSimilarity(vec(1, 0), vec(2, 0))).toBe(1)
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBe(0)
    expect(cosineSimilarity(vec(1, 0), vec(-1, 0))).toBe(-1)
    expect(cosineSimilarity(vec(1, 0), Float32Array.from([1, 0]))).toBe(0)
  })

  it('L2 归一化后模长为 1，零向量原样返回', () => {
    const normalized = normalizeVector(vec(3, 4))
    expect(normalized[0]).toBeCloseTo(0.6)
    expect(normalized[1]).toBeCloseTo(0.8)
    expect(Math.hypot(...normalized)).toBeCloseTo(1)
    const zero = normalizeVector(vec(0, 0))
    expect([...zero]).toEqual([0, 0, 0])
  })
})

describe('buildEmbeddingEdges', () => {
  it('阈值过滤 + 无向去重 + src<dst + 按 (src,dst) 排序', () => {
    const edges = buildEmbeddingEdges(
      [vectorOf(1, 1, 0), vectorOf(2, 1, 0.1), vectorOf(3, 0, 1)],
      { minSim: 0.9, topK: 4, mutual: true }
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].src).toBe(1)
    expect(edges[0].dst).toBe(2)
    expect(edges[0].weight).toBeCloseTo(cosineSimilarity(vec(1, 0), normalizeVector(vec(1, 0.1))))
  })

  it('top-k 只保留每个节点最相似的 k 个（k=1 时每个节点只出一条）', () => {
    const vectors = [vectorOf(1, 1, 0), vectorOf(2, 1, 0.1), vectorOf(3, 0.1, 1), vectorOf(4, 0, 1)]
    const one = buildEmbeddingEdges(vectors, { minSim: 0, topK: 1, mutual: false })
    expect(one.map((edge) => `${edge.src}-${edge.dst}`)).toEqual(['1-2', '3-4'])

    const two = buildEmbeddingEdges(vectors, { minSim: 0, topK: 2, mutual: false })
    expect(two.map((edge) => `${edge.src}-${edge.dst}`)).toEqual([
      '1-2',
      '1-3',
      '2-3',
      '2-4',
      '3-4'
    ])
  })

  it('互选：单向 top-k 不成就没有边', () => {
    // 2 与 3 更近：1 的 top1 是 2，但 2 的 top1 是 3 → 1-2 在互选下被丢掉
    const vectors = [vectorOf(1, 1, 0), vectorOf(2, 1, 0.1), vectorOf(3, 1, 0.2)]
    const mutualEdges = buildEmbeddingEdges(vectors, { minSim: 0.5, topK: 1, mutual: true })
    expect(mutualEdges.map((edge) => `${edge.src}-${edge.dst}`)).toEqual(['2-3'])
    const looseEdges = buildEmbeddingEdges(vectors, { minSim: 0.5, topK: 1, mutual: false })
    expect(looseEdges.map((edge) => `${edge.src}-${edge.dst}`)).toEqual(['1-2', '2-3'])
  })

  it('默认参数与 §5.2 初值一致；自环/重复/空输入安全', () => {
    expect(EMBEDDING_EDGE_DEFAULTS).toEqual({ minSim: 0.64, topK: 4, mutual: true })
    expect(buildEmbeddingEdges([])).toEqual([])
    expect(buildEmbeddingEdges([vectorOf(1, 1, 0)])).toEqual([])
    expect(
      buildEmbeddingEdges([vectorOf(1, 1, 0), vectorOf(1, 1, 0), vectorOf(2, 1, 0)])
    ).toHaveLength(1)
  })

  it('确定性：同一输入两次结果完全一致', () => {
    const vectors = [vectorOf(5, 1, 0), vectorOf(2, 1, 0.1), vectorOf(9, 1, 0.2), vectorOf(7, 0.9, 0.3)]
    expect(buildEmbeddingEdges(vectors)).toEqual(buildEmbeddingEdges(vectors))
  })
})

describe('向量与边落库', () => {
  function seedNodes(db: Db, ids: readonly number[]): void {
    for (const id of ids) {
      db.prepare(
        `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events)
         VALUES (?, 1, 'knowledge', ?, '', 1, 2, '[]')`
      ).run(id, `主题 ${id}`)
    }
  }

  it('Float32 向量写读往返一致，维度不符的行跳过', () => {
    const db = openDatabase(':memory:')
    try {
      seedNodes(db, [1, 2])
      const written = writeThemeVectors(
        db,
        [vectorOf(1, 1, 0), vectorOf(2, 0, 1)],
        { model: 'bge-small-zh-v1.5', dim: 3, now: 10 }
      )
      expect(written).toEqual({ written: 2, skipped: 0 })

      const read = readThemeVectors(db)
      expect(read.model).toBe('bge-small-zh-v1.5')
      expect(read.vectors.map((item) => item.nodeId)).toEqual([1, 2])
      expect([...(read.vectors[0].vec)]).toEqual([...normalizeVector(vec(1, 0))])

      // 维度写坏的行不参与读取
      db.prepare("UPDATE node_embeddings SET dim = 5 WHERE node_id = 2").run()
      expect(readThemeVectors(db).skipped).toBe(1)
      expect(readThemeVectors(db).vectors.map((item) => item.nodeId)).toEqual([1])

      // 按模型过滤
      expect(readThemeVectors(db, { model: 'other' }).vectors).toEqual([])
    } finally {
      db.close()
    }
  })

  it('写入 embedding 边时保留旧 ai 边、重跑是替换而不是追加', () => {
    const db = openDatabase(':memory:')
    try {
      seedNodes(db, [1, 2, 3])
      db.prepare(
        "INSERT INTO edges (src, dst, weight, kind, evidence) VALUES (1, 2, 0.5, 'ai', '旧归纳')"
      ).run()

      const evidence = { model: 'bge', threshold: 0.64, topK: 4, mutual: true }
      const first = writeEmbeddingEdges(
        db,
        [
          { src: 1, dst: 2, weight: 0.9 },
          { src: 2, dst: 3, weight: 0.7 }
        ],
        evidence
      )
      expect(first).toEqual({ deleted: 0, inserted: 2 })

      const rows = db
        .prepare('SELECT src, dst, weight, kind, evidence FROM edges ORDER BY kind, id')
        .all() as Array<{ src: number; dst: number; weight: number; kind: string; evidence: string }>
      expect(rows.filter((row) => row.kind === 'ai')).toHaveLength(1)
      const embeddingRows = rows.filter((row) => row.kind === 'embedding')
      expect(embeddingRows.map((row) => [row.src, row.dst, row.weight])).toEqual([
        [1, 2, 0.9],
        [2, 3, 0.7]
      ])
      expect(JSON.parse(embeddingRows[0].evidence)).toEqual(evidence)

      const second = writeEmbeddingEdges(db, [{ src: 1, dst: 3, weight: 0.8 }], evidence)
      expect(second).toEqual({ deleted: 2, inserted: 1 })
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'embedding'")
          .get()
      ).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })
})
