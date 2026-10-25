/**
 * E2E 确定性假向量（M2 P2 · S7）
 *
 * 这层是测试注入点，不是业务能力：重点钉住「确定性」「L2 归一化」「与真模型名分开」
 * 和「同一段内容的逐字空格 OCR 形态算成同一向量」——在线路径 E2E 的断言全靠这几条。
 */

import { describe, expect, it } from 'vitest'
import {
  createDeterministicFakeEmbedder,
  fakeEmbedText,
  FAKE_EMBEDDING_DIM,
  FAKE_EMBEDDING_MODEL
} from '../../src/main/fake-embedding'
import { cosineSimilarity } from '../../src/understand/graph-edges'
import { EMBEDDING_MODEL_NAME } from '../../src/understand/embedding/types'

function l2Norm(vec: Float32Array): number {
  let sum = 0
  for (const value of vec) sum += value * value
  return Math.sqrt(sum)
}

describe('E2E 假向量', () => {
  it('模型名与真模型分开：假向量不会被当成真向量复用', () => {
    const { embedder } = createDeterministicFakeEmbedder()
    expect(embedder.model).toBe(FAKE_EMBEDDING_MODEL)
    expect(embedder.model).not.toBe(EMBEDDING_MODEL_NAME)
    expect(embedder.dim).toBe(FAKE_EMBEDDING_DIM)
  })

  it('确定性 + L2 归一化：同一文本永远得到同一单位向量', async () => {
    const { embedder, counters } = createDeterministicFakeEmbedder()
    const [first, second, other] = await embedder.embed(['改按钮样式', '改按钮样式', '查接口文档'])

    expect(counters.texts).toBe(3)
    expect(Array.from(first)).toEqual(Array.from(second))
    expect(l2Norm(first)).toBeCloseTo(1, 6)
    expect(cosineSimilarity(first, second)).toBeCloseTo(1, 6)
    // 不相干的文本要明显低于新主题阈值（0.78），E2E 才能稳定断言「两条时刻各建一个主题」
    expect(cosineSimilarity(first, other)).toBeLessThan(0.78)
  })

  it('OCR 逐字空格形态与无空格形态等价（同一段内容只有一个向量）', async () => {
    const { embedder } = createDeterministicFakeEmbedder()
    const [spaced, plain] = await embedder.embed(['改 按 钮 样 式', '改按钮样式'])
    expect(cosineSimilarity(spaced, plain)).toBeCloseTo(1, 6)
  })

  it('共享内容越多越相似：同前缀文本高于不相干文本', async () => {
    const { embedder } = createDeterministicFakeEmbedder()
    const [base, extended, unrelated] = await embedder.embed([
      '改按钮样式',
      '改按钮样式调整',
      '查接口文档'
    ])
    expect(cosineSimilarity(base, extended)).toBeGreaterThan(cosineSimilarity(base, unrelated))
  })

  it('空文本返回零向量、单字文本单位化，都不抛错', async () => {
    const { embedder } = createDeterministicFakeEmbedder()
    const [empty, single] = await embedder.embed(['', '改'])
    expect(empty.length).toBe(FAKE_EMBEDDING_DIM)
    expect(l2Norm(empty)).toBe(0)
    expect(l2Norm(single)).toBeCloseTo(1, 6)
    expect(Array.from(fakeEmbedText('  '))).toEqual(Array.from(empty))
  })
})
