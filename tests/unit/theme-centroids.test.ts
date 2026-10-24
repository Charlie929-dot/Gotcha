import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db'
import {
  averageVectors,
  computeMomentVectors,
  computeThemeCentroids,
  findMergeCandidates,
  planThemeMerges,
  readThemeCentroids,
  writeThemeCentroids
} from '../../src/understand/theme-centroids'

function vec(values: readonly number[]): Float32Array {
  return Float32Array.from(values)
}

function theme(id: number, type: string, values: readonly number[]) {
  return { id, type, vec: vec(values) }
}

describe('averageVectors / moment / theme 质心', () => {
  it('均值后按 L2 归一化；空输入与维度不一致的向量被跳过', () => {
    const mean = averageVectors([vec([1, 1]), vec([1, 1])])
    expect(mean).not.toBeNull()
    expect([...(mean as Float32Array)]).toEqual([1, 1])

    expect(averageVectors([])).toBeNull()
    const mixed = averageVectors([vec([2, 0]), vec([4, 0, 1])])
    expect([...(mixed as Float32Array)]).toEqual([2, 0])
  })

  it('时刻向量 = 成员事件均值；缺向量的事件忽略', () => {
    const momentEventIds = new Map<number, number[]>([
      [10, [1, 2]],
      [11, [3]]
    ])
    const eventVectors = new Map<number, Float32Array>([
      [1, vec([1, 0])],
      [2, vec([1, 0])],
      [3, vec([0, 1])]
    ])
    const moments = computeMomentVectors(momentEventIds, eventVectors)
    expect([...(moments.get(10) as Float32Array)]).toEqual([1, 0])
    expect([...(moments.get(11) as Float32Array)]).toEqual([0, 1])
    // 事件 2 没有向量 → 仍由事件 1 算
    expect(moments.has(99)).toBe(false)
  })

  it('主题质心只算 owner 归属、事件去重、返回成员事件数', () => {
    const memberships = [
      { themeId: 1, momentId: 10 },
      { themeId: 1, momentId: 11 }
    ]
    const momentEventIds = new Map<number, number[]>([
      [10, [1, 2]],
      [11, [2, 3]] // 事件 2 与主题 1 的上一个时刻重复
    ])
    const eventVectors = new Map<number, Float32Array>([
      [1, vec([1, 0])],
      [2, vec([1, 0])],
      [3, vec([0, 1])]
    ])
    const centroids = computeThemeCentroids(memberships, momentEventIds, eventVectors)
    const centroid = centroids.get(1)
    expect(centroid?.memberEvents).toBe(3)
    const [x, y] = centroid?.vec ?? []
    expect(x).toBeCloseTo(0.8944, 3)
    expect(y).toBeCloseTo(0.4472, 3)
    // 没有成员向量的主题不产出质心
    expect(computeThemeCentroids([{ themeId: 2, momentId: 99 }], momentEventIds, eventVectors).size).toBe(0)
  })
})

describe('findMergeCandidates', () => {
  it('同 type 且相似度 ≥ 阈值才成对；输出确定性', () => {
    const themes = [
      theme(1, 'knowledge', [1, 0]),
      theme(2, 'knowledge', [0.99, 0.141]),
      theme(3, 'activity', [1, 0]),
      theme(4, 'knowledge', [0, 1])
    ]
    const candidates = findMergeCandidates(themes, 0.95)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].a).toBe(1)
    expect(candidates[0].b).toBe(2)
    expect(candidates[0].sim).toBeGreaterThan(0.99)
    expect(findMergeCandidates(themes, 1.1)).toEqual([])
  })
})

describe('planThemeMerges', () => {
  it('按连通分量合并；存活节点取成员事件最多者，并列取小 id', () => {
    const themes = [
      theme(1, 'knowledge', [1, 0]),
      theme(2, 'knowledge', [1, 0]),
      theme(3, 'knowledge', [1, 0]),
      theme(4, 'knowledge', [0, 1]),
      theme(5, 'activity', [1, 0])
    ]
    const candidates = findMergeCandidates(themes, 0.95)
    const counts = new Map([
      [1, 2],
      [2, 5],
      [3, 3],
      [4, 1],
      [5, 9]
    ])
    const plans = planThemeMerges(candidates, themes, counts, { minSim: 0.95 })
    expect(plans).toHaveLength(1)
    expect(plans[0].into).toBe(2)
    expect(plans[0].from).toEqual([1, 3])
    expect(plans[0].reason).toContain('分量 3 个')
  })

  it('空候选 / 低于阈值不产出计划', () => {
    const themes = [theme(1, 'knowledge', [1, 0]), theme(2, 'knowledge', [0, 1])]
    expect(planThemeMerges(findMergeCandidates(themes, 0.95), themes, new Map(), { minSim: 0.95 })).toEqual([])
  })
})

describe('质心读写', () => {
  it('按模型读回；维度不一致的行跳过', () => {
    const db = openDatabase(':memory:')
    try {
      const centroids = [
        { nodeId: 1, vec: vec([0.6, 0.8]), memberEvents: 4 },
        { nodeId: 2, vec: vec([1]), memberEvents: 2 }
      ]
      const written = writeThemeCentroids(db, centroids, { model: 'fake', now: 5 })
      expect(written).toEqual({ written: 2, skipped: 0 })

      const read = readThemeCentroids(db, { model: 'fake' })
      expect(read.model).toBe('fake')
      expect(read.centroids.get(1)?.memberEvents).toBe(4)
      const readVec = read.centroids.get(1)?.vec ?? []
      expect(readVec[0]).toBeCloseTo(0.6, 5)
      expect(readVec[1]).toBeCloseTo(0.8, 5)

      // 另一个模型不混读
      expect(readThemeCentroids(db, { model: 'other' }).centroids.size).toBe(0)

      // 手写一条维度不符的坏行 → 读到时跳过
      db.prepare(
        `INSERT INTO theme_centroids (node_id, model, dim, vec, member_events, updated_at)
         VALUES (3, 'fake', 9, x'00000000', 1, 1)`
      ).run()
      expect(readThemeCentroids(db, { model: 'fake' }).skipped).toBe(1)
    } finally {
      db.close()
    }
  })
})
