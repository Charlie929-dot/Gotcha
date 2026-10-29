/**
 * 个人记忆 · 向量回想排序（recall.ts）
 *
 * 这组用例守的是「想起什么」的口径：时间衰减让昨天的话比去年的更容易想起，去重不让同一段话占满
 * 一次回想，MMR 让「想到的」不是同一句的复读；维度不符 / 零向量必须当噪声丢掉而不是抛错。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HALF_LIFE_DAYS,
  cosine,
  recencyWeight,
  selectRecalls,
  textHash,
  type RecallCandidate
} from '../../src/memory/recall'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-29T23:00:00').getTime()

function vec(values: number[]): Float32Array {
  return new Float32Array(values)
}

function candidate(id: string, values: number[], ts: number | null = NOW): RecallCandidate {
  return { id, vec: vec(values), ts }
}

describe('cosine / recencyWeight', () => {
  it('余弦：同向 1、正交 0、维度不符 / 零向量 0', () => {
    expect(cosine(vec([1, 0]), vec([1, 0]))).toBeCloseTo(1, 6)
    expect(cosine(vec([1, 0]), vec([0, 1]))).toBeCloseTo(0, 6)
    expect(cosine(vec([1, 0]), vec([1, 0, 0]))).toBe(0)
    expect(cosine(vec([0, 0]), vec([1, 0]))).toBe(0)
    expect(cosine(vec([]), vec([]))).toBe(0)
  })

  it('时间衰减：半衰期 90 天，90 天前权重 0.5、180 天前 0.25', () => {
    expect(recencyWeight(NOW, NOW, DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(1, 6)
    expect(recencyWeight(NOW - 90 * DAY, NOW, DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 6)
    expect(recencyWeight(NOW - 180 * DAY, NOW, DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(0.25, 6)
    // 没有时间 / 未来时间 / 关掉衰减：都不打折
    expect(recencyWeight(null, NOW, DEFAULT_HALF_LIFE_DAYS)).toBe(1)
    expect(recencyWeight(NOW + 5 * DAY, NOW, DEFAULT_HALF_LIFE_DAYS)).toBe(1)
    expect(recencyWeight(NOW - 500 * DAY, NOW, 0)).toBe(1)
  })
})

describe('selectRecalls · 过滤与排序', () => {
  it('维度不符 / 零向量 / 低于阈值的候选都被丢掉，不抛错', () => {
    const hits = selectRecalls(
      [
        candidate('wrong-dim', [1, 0, 0]),
        candidate('zero', [0, 0]),
        candidate('off-topic', [0, 1]),
        candidate('good', [1, 0])
      ],
      vec([1, 0]),
      { now: NOW }
    )
    expect(hits.map((hit) => hit.id)).toEqual(['good'])
  })

  it('相关性高的排前面，score = 余弦 × 时间权重', () => {
    const hits = selectRecalls(
      [candidate('a', [0.6, 0.8]), candidate('b', [1, 0]), candidate('c', [0.8, 0.6])],
      vec([1, 0]),
      { now: NOW, topK: 3 }
    )
    expect(hits.map((hit) => hit.id)).toEqual(['b', 'c', 'a'])
    expect(hits[0].similarity).toBeCloseTo(1, 6)
    expect(hits[0].score).toBeCloseTo(1, 6)
    expect(hits[1].similarity).toBeCloseTo(0.8, 6)
  })

  it('同样相似时新的优先：180 天前的 1.0 打不过今天的 0.9', () => {
    const old = candidate('old', [1, 0], NOW - 180 * DAY)
    const fresh = candidate('fresh', [0.9, 0.4358899], NOW)
    const hits = selectRecalls([old, fresh], vec([1, 0]), { now: NOW, topK: 2 })
    expect(hits.map((hit) => hit.id)).toEqual(['fresh', 'old'])
    expect(hits[1].score).toBeLessThan(hits[0].score)
    expect(hits[1].recency).toBeCloseTo(0.25, 6)
  })

  it('topK 封顶，分数相同按 id 稳定排序', () => {
    const hits = selectRecalls(
      [candidate('c', [1, 0]), candidate('a', [1, 0]), candidate('b', [1, 0]), candidate('d', [1, 0])],
      vec([1, 0]),
      { now: NOW, topK: 2 }
    )
    expect(hits.map((hit) => hit.id)).toEqual(['a', 'b'])
  })

  it('空 query / topK <= 0 返回空', () => {
    expect(selectRecalls([candidate('a', [1, 0])], vec([]), { now: NOW })).toEqual([])
    expect(selectRecalls([candidate('a', [1, 0])], vec([1, 0]), { now: NOW, topK: 0 })).toEqual([])
  })
})

describe('selectRecalls · 去重与 MMR', () => {
  it('同一 dedupeKey 只留分最高的那条（同一段话切成几条时不占满回想）', () => {
    const candidates: RecallCandidate[] = [
      { ...candidate('split-1', [1, 0]), dedupeKey: 'diary:abc' },
      { ...candidate('split-2', [0.8, 0.6]), dedupeKey: 'diary:abc' },
      candidate('other', [0.6, 0.8])
    ]
    const hits = selectRecalls(candidates, vec([1, 0]), { now: NOW, topK: 3 })
    expect(hits.map((hit) => hit.id)).toEqual(['split-1', 'other'])
  })

  it('MMR 会把「几乎一样的两条」换成更多样的一条', () => {
    const duplicated: RecallCandidate[] = [
      candidate('first', [1, 0]),
      candidate('near-dup', [0.99, 0.14]),
      candidate('diverse', [0.6, 0.8])
    ]
    // 相关性权重低 → 坚决去复读：第二条选 diverse
    const diverse = selectRecalls(duplicated, vec([1, 0]), { now: NOW, topK: 3, mmrLambda: 0.4 })
    expect(diverse.map((hit) => hit.id)).toEqual(['first', 'diverse', 'near-dup'])
    // 相关性权重高 → 允许近似重复先上
    const similar = selectRecalls(duplicated, vec([1, 0]), { now: NOW, topK: 3, mmrLambda: 0.9 })
    expect(similar.map((hit) => hit.id)).toEqual(['first', 'near-dup', 'diverse'])
  })
})

describe('textHash', () => {
  it('只对空白不敏感（正文改一个字就换指纹）', () => {
    const base = textHash('今天早上有点困， 昨晚没睡好。')
    expect(textHash('今天早上有点困，    昨晚没睡好。')).toBe(base)
    expect(textHash('  今天早上有点困， 昨晚没睡好。 ')).toBe(base)
    expect(textHash('今天早上有点困，昨晚没睡好。')).not.toBe(base)
    expect(textHash('今天早上有点困， 昨晚睡得还行。')).not.toBe(base)
  })
})
