/**
 * 个人记忆 · 向量回想排序（纯函数，不碰库、不碰网络、不 import `src/chain/`）
 *
 * 方案见 `docs/agent/llm-call.md` §4（D57）：每轮 act 用「当前问题 / 工具查询」做 query，
 * 从日记 / 对话 / 观测的向量里取 top 6–8 条「你想到的」注入下一轮，并明确标注**是联想，不一定是证据**。
 *
 * 这一层只做**打分与挑选**，三件事：
 *
 * 1. **时间衰减**：半衰期默认 90 天，越久越淡 —— 「昨天说过的话」比「去年今天说过的话」更容易想起；
 * 2. **去重**：同一段内容可能被切成几条（同一天的评论 / 回复），`dedupeKey` 相同的只留分最高的；
 * 3. **MMR**：只在最相似的那几条里挑会全是同一件事的复述，所以每挑一条就按「与已挑内容的相似度」扣分，
 *    让「想到的」既相关又不是同一句的复读。
 *
 * 为什么自己写而不 import `src/chain/derive`：个人记忆是另一套系统（AGENTS 第 12 条），
 * 那套是冻结的信息链；余弦 / 打包那几行复制过来比跨系统耦合便宜（也免得以后改一边影响另一边）。
 */

import { createHash } from 'node:crypto'

/** 一条可被回想的候选（来自 `mem_vectors` 的一次行读） */
export interface RecallCandidate {
  /** 稳定键，例如 `diary:<uid>` / `conversation:<id>` / `observation:<uid>` */
  id: string
  vec: Float32Array
  /** 内容时间（本地毫秒）；null = 没有时间，不参与衰减 */
  ts?: number | null
  /**
   * 去重键：同一条日记的正文 / 评论 / 回复切成几条时用同一个键（默认用 `id`）。
   * 只留分最高的那条，避免一次回想被同一段话占满。
   */
  dedupeKey?: string
  /** 调用方要带回的东西（条目行、对话片段、观测文案） */
  payload?: unknown
}

export interface RecallOptions {
  /** 当前时间（毫秒）：衰减基准，测试注入固定钟 */
  now: number
  /** 取前几条，默认 7（方案 §3.3 的 6–8） */
  topK?: number
  /** 低于这个余弦直接不参与，默认 0.30（负余弦 / 噪声不占位置） */
  minSimilarity?: number
  /** 时间衰减半衰期（天），默认 90；<=0 表示不衰减 */
  halfLifeDays?: number
  /** MMR 的相关性权重：1 = 纯相关（不去重），0.7 = 相关为主、略去复读 */
  mmrLambda?: number
}

export interface RecallHit {
  id: string
  /** 最终排序分（相关性 × 时间衰减，MMR 只影响挑选顺序） */
  score: number
  /** 原始余弦 */
  similarity: number
  /** 时间权重（0–1） */
  recency: number
  /** 被 MMR 扣过分之后的选择分 */
  mmrScore: number
  ts: number | null
  payload?: unknown
}

export const DEFAULT_TOP_K = 7
export const DEFAULT_MIN_SIMILARITY = 0.3
export const DEFAULT_HALF_LIFE_DAYS = 90
export const DEFAULT_MMR_LAMBDA = 0.7

const DAY_MS = 24 * 60 * 60 * 1000

/** 余弦相似度；维度不一致 / 零向量返回 0（当噪声处理，不抛错） */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

/** 时间衰减权重：`0.5 ^ (ageDays / halfLife)`；没有时间 / 未来时间算 1 */
export function recencyWeight(ts: number | null | undefined, now: number, halfLifeDays: number): number {
  if (ts === null || ts === undefined) return 1
  if (!(halfLifeDays > 0)) return 1
  const ageDays = Math.max(0, now - ts) / DAY_MS
  return Math.pow(0.5, ageDays / halfLifeDays)
}

/** 正文指纹：同步时判断「这条要不要重新向量化」（与 `mem_vectors.text_hash` 对得上） */
export function textHash(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim().toLowerCase()
  return createHash('sha1').update(normalized).digest('hex')
}

/**
 * 挑出「此刻想到的」：余弦 → 时间衰减 → 去重 → MMR。
 *
 * 返回按挑选顺序排好的命中；调用方据此拼 `[日记 2026-10-28] …` 的注入文本。
 */
export function selectRecalls(
  candidates: readonly RecallCandidate[],
  queryVec: Float32Array,
  options: RecallOptions
): RecallHit[] {
  const topK = options.topK ?? DEFAULT_TOP_K
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  const lambda = options.mmrLambda ?? DEFAULT_MMR_LAMBDA
  if (topK <= 0) return []
  if (queryVec.length === 0) return []

  interface Scored {
    candidate: RecallCandidate
    hit: RecallHit
    key: string
  }

  // 1) 余弦 + 时间衰减；维度不符 / 零向量 / 低于阈值的直接出局
  const scored: Scored[] = []
  for (const candidate of candidates) {
    if (candidate.vec.length !== queryVec.length) continue
    const similarity = cosine(queryVec, candidate.vec)
    if (!(similarity >= minSimilarity)) continue
    const recency = recencyWeight(candidate.ts ?? null, options.now, halfLifeDays)
    scored.push({
      candidate,
      key: candidate.dedupeKey ?? candidate.id,
      hit: {
        id: candidate.id,
        score: similarity * recency,
        similarity,
        recency,
        mmrScore: 0,
        ts: candidate.ts ?? null,
        payload: candidate.payload
      }
    })
  }
  if (scored.length === 0) return []

  // 2) 去重：同一个 dedupeKey 只留分最高的（同分按 id 稳定排序）
  const best = new Map<string, Scored>()
  for (const item of scored) {
    const current = best.get(item.key)
    if (
      current === undefined ||
      item.hit.score > current.hit.score ||
      (item.hit.score === current.hit.score && item.hit.id < current.hit.id)
    ) {
      best.set(item.key, item)
    }
  }
  const pool = [...best.values()].sort((left, right) =>
    right.hit.score === left.hit.score
      ? left.hit.id.localeCompare(right.hit.id)
      : right.hit.score - left.hit.score
  )

  // 3) MMR：每轮挑「相关 - λ 之外的重复度」最高的；选中后把它作为已选集合参与下一轮惩罚
  const picked: Scored[] = []
  const remaining = [...pool]
  while (picked.length < topK && remaining.length > 0) {
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index]
      let redundancy = 0
      for (const chosen of picked) {
        redundancy = Math.max(redundancy, cosine(item.candidate.vec, chosen.candidate.vec))
      }
      const mmrScore = lambda * item.hit.score - (1 - lambda) * redundancy
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIndex = index
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1)
    chosen.hit.mmrScore = bestScore
    picked.push(chosen)
  }

  return picked.map((item) => item.hit)
}
