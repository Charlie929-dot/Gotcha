/**
 * E2E 确定性假向量（M2 P2 · S7；docs/m2-graph-redesign.md §9.1 / §13.2）
 *
 * 只在 `GOTCHA_FAKE_EMBEDDING=1` **且** `GOTCHA_USER_DATA` 存在 **且** 非打包态时由
 * `main/index.ts` 注入；正常启动 / 打包产物不会走到这里。它满足 `Embedder` 契约
 * （`model` / `dim` / L2 归一化向量），不加载 95 MB 模型、不 import onnxruntime。
 *
 * 为什么不能拿真模型跑在线路径 E2E（gotchas.md「真模型 E2E 里『立即归纳』不再是唯一的
 * 建主题路径」）：真模型要加载 ~0.5 s，且相似度不可控——断言「哪个时刻归到哪个主题」
 * 会随模型输出漂。假向量按文本确定性生成：**同一段文本永远得到同一个向量**（余弦 1），
 * 字符二元组重叠越多越相似，够 E2E 区分「同一个时刻」与「不相干的新主题」。
 *
 * 模型名刻意与真模型不同（`fake-embedding-v1` ≠ `bge-small-zh-v1.5`）：库里按 `model` 过滤，
 * 假向量永远不会被当成真向量复用（与 `EMBEDDING_MODEL_NAME` 换模型的语义一致）。
 */

import { EMBEDDING_DIM, type Embedder } from '../understand/embedding/types'

/** 假向量模型标识（写进 `event_embeddings.model` / `node_embeddings.model`） */
export const FAKE_EMBEDDING_MODEL = 'fake-embedding-v1'

/** 默认维度与真模型一致：不用改任何下游常量就能落库 */
export const FAKE_EMBEDDING_DIM = EMBEDDING_DIM

/** FNV-1a 32 位（与 vector-fingerprint 的口径无关，只做确定性散列） */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * 文本 → 单位向量。
 * - 先去掉所有空白并转小写：OCR 的中文是「改 按 钮」逐字空格形态（gotchas.md），
 *   归一后才能与同一段内容的无空格形态得到同一个向量；
 * - 以字符二元组为特征（单字文本退化成单字），散列到维度上，正负号由散列高位决定；
 * - 空文本返回零向量（调用方本来就会跳过空文本，这里只是不抛错）。
 */
export function fakeEmbedText(text: string, dim = FAKE_EMBEDDING_DIM): Float32Array {
  const vector = new Float32Array(dim)
  const normalized = text.replace(/\s+/g, '').toLowerCase()
  if (normalized.length === 0) return vector

  const features: string[] = []
  if (normalized.length === 1) {
    features.push(normalized)
  } else {
    for (let i = 0; i + 1 < normalized.length; i += 1) features.push(normalized.slice(i, i + 2))
  }

  for (const feature of features) {
    const hash = fnv1a(feature)
    const index = hash % dim
    const sign = (hash & 0x80000000) !== 0 ? -1 : 1
    vector[index] += sign
  }

  let sum = 0
  for (let i = 0; i < dim; i += 1) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) vector[i] /= norm
  }
  return vector
}

export interface DeterministicFakeEmbedder {
  embedder: Embedder
  /** 被 embed 的文本条数（E2E 可断言「没有重复算已有向量」） */
  counters: { texts: number }
}

export function createDeterministicFakeEmbedder(options: { dim?: number } = {}): DeterministicFakeEmbedder {
  const dim = Math.max(1, Math.floor(options.dim ?? FAKE_EMBEDDING_DIM))
  const counters = { texts: 0 }
  const embedder: Embedder = {
    model: FAKE_EMBEDDING_MODEL,
    dim,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      counters.texts += texts.length
      return texts.map((text) => fakeEmbedText(text, dim))
    }
  }
  return { embedder, counters }
}
