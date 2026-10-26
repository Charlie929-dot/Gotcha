/**
 * 信息链 · 派生层：标签 / 双链名字的归一与合并分带（契约 v0.8 / D45）
 *
 * 合并口径（拍板记录 §5 第 4 条，D29 同款）：
 * - 与已有名字**相似度 ≥ 0.95**：直接复用，不问模型；
 * - **0.90–0.95**：模糊带，问模型「是不是同一个东西」；
 * - **< 0.90**：新建。
 *
 * 「相似度」= 两个名字各自过一次本地 embedding（bge-small-zh-v1.5）后的余弦；
 * 名字先归一（去首尾标点、空白折叠），精确同名 / 别名命中不花 embedding。
 */

/** 直接复用阈值（≥ 即复用） */
export const MERGE_AUTO_SIM = 0.95

/** 模糊带下界（≥ 且 < `MERGE_AUTO_SIM` 才问模型） */
export const MERGE_ASK_SIM = 0.9

/**
 * 名字两侧要去掉的标点 / 装饰：模型偶尔把名字写成「“记忆球”」「（Hindsight）」。
 * 刻意**不含** `+ # & % $ @ = *` ——「C++」「C#」「AT&T」都是正常名字。
 */
const EDGE_JUNK_START =
  /^[\s"'`“”‘’《》〈〉「」『』【】()（）[\]{}<>·・,，.。:：;；!！?？|/\\~_—–*-]+/
const EDGE_JUNK_END = /[\s"'`“”‘’《》〈〉「」『』【】()（）[\]{}<>·・,，.。:：;；!！?？|/\\~_—–*-]+$/

/** 名字归一：空白折叠、去首尾空白与装饰标点 */
export function normalizeName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim()
  // 两侧装饰可能叠好几层（「“记忆球”」），循环剥到稳定为止
  for (let i = 0; i < 5; i += 1) {
    const next = name.replace(EDGE_JUNK_START, '').replace(EDGE_JUNK_END, '').trim()
    if (next === name) break
    name = next
  }
  return name
}

/**
 * 匹配用的键：归一后再小写、去掉所有空白。
 * 「DeepSeek Harness」/「deepseekharness」/「DeepSeek  Harness」视为同一个。
 */
export function nameKey(raw: string): string {
  return normalizeName(raw).toLowerCase().replace(/\s+/g, '')
}

/** 余弦相似度（embedder 保证向量已 L2 归一化；零向量返回 0，不抛错） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

export type MergeBand = 'reuse' | 'ask' | 'new'

/** 相似度 → 合并分带（没有相似度 / 没有候选时按「新建」） */
export function mergeBand(similarity: number | null | undefined): MergeBand {
  if (similarity === null || similarity === undefined || !Number.isFinite(similarity)) return 'new'
  if (similarity >= MERGE_AUTO_SIM) return 'reuse'
  if (similarity >= MERGE_ASK_SIM) return 'ask'
  return 'new'
}

export interface NamedVector {
  name: string
  vec: Float32Array
}

export interface BestMatch {
  name: string
  similarity: number
}

/** 候选名字向量与一批已有名字向量里最像的一个（没有可比的返回 null） */
export function bestMatch(vec: Float32Array, entries: readonly NamedVector[]): BestMatch | null {
  let best: BestMatch | null = null
  for (const entry of entries) {
    const similarity = cosineSimilarity(vec, entry.vec)
    if (best === null || similarity > best.similarity) best = { name: entry.name, similarity }
  }
  return best
}
