/**
 * 主题向量与全局相似边（docs/m2-graph-redesign.md §4.3 / §4.4 / §6.1）
 *
 * - 向量：`node_embeddings.vec` 存 Float32Array（小端 BLOB），写入前 L2 归一化；
 * - 全局边：主题向量余弦相似度 → 阈值 → top-k → 互选；无向、按 (src,dst) 去重、weight 取较大；
 * - 构建是纯函数（只吃向量，不碰库、不调模型），真实向量由回填/在线服务提供，用例用假向量；
 * - 铁律：距离编码只用 `weight`（sim），线宽不编码相似度（G3）；成员边不进 edges 表。
 */

import type { Db } from '../db'
import { isFiniteNumber } from './source-events'

/** 初值（§5.2 表格）；必须在合并后的真实主题集上重新标定，不能直接套 v0.2 的数字 */
export const EMBEDDING_EDGE_DEFAULTS = {
  minSim: 0.64,
  topK: 4,
  mutual: true
} as const

/** 一条主题向量（已归一化或未归一化都可以，cosine 会自己算范数） */
export interface ThemeVector {
  nodeId: number
  vec: Float32Array
}

export interface EmbeddingEdge {
  src: number
  dst: number
  weight: number
}

export interface EdgeBuildOptions {
  /** 相似度阈值（低于它不连边） */
  minSim?: number
  /** 每个主题最多邻居数 */
  topK?: number
  /** 是否要求互选（双向都在对方 top-k 内） */
  mutual?: boolean
}

export interface EdgeEvidence {
  model: string
  threshold: number
  topK: number
  mutual: boolean
}

/** 余弦相似度；维度不一致或含非法值返回 0（宁可少一条边，也不让 NaN 进图） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  const sim = dot / Math.sqrt(normA * normB)
  return Number.isFinite(sim) ? sim : 0
}

/** L2 归一化（返回新数组；零向量原样返回拷贝，调用方自行判断） */
export function normalizeVector(vec: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i]
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return Float32Array.from(vec)
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm
  return out
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/**
 * 由主题向量构建全局边（确定性输出）。
 * - 每个节点只保留相似度最高的 topK 个邻居（`>= minSim`），并集再去重；
 * - `mutual=true` 时要求双向都在对方 top-k 内；
 * - 无向：统一 `src < dst`，weight 取该对相似度（对称，天然相同）。
 */
export function buildEmbeddingEdges(
  vectors: readonly ThemeVector[],
  options: EdgeBuildOptions = {}
): EmbeddingEdge[] {
  const minSim = isFiniteNumber(options.minSim) ? options.minSim : EMBEDDING_EDGE_DEFAULTS.minSim
  const topK = Math.max(0, Math.floor(options.topK ?? EMBEDDING_EDGE_DEFAULTS.topK))
  const mutual = options.mutual ?? EMBEDDING_EDGE_DEFAULTS.mutual
  if (topK === 0 || vectors.length < 2) return []

  // 同一 nodeId 重复出现时保留第一条，避免自环
  const byId = new Map<number, Float32Array>()
  for (const item of vectors) {
    if (!Number.isInteger(item.nodeId) || item.nodeId <= 0) continue
    if (!byId.has(item.nodeId)) byId.set(item.nodeId, item.vec)
  }
  const ids = [...byId.keys()].sort((a, b) => a - b)
  if (ids.length < 2) return []

  const neighbors = new Map<number, number[]>()
  const sims = new Map<string, number>()
  for (const id of ids) {
    const vec = byId.get(id) as Float32Array
    const scored: Array<{ id: number; sim: number }> = []
    for (const other of ids) {
      if (other === id) continue
      const sim = cosineSimilarity(vec, byId.get(other) as Float32Array)
      if (sim < minSim) continue
      scored.push({ id: other, sim })
      const key = pairKey(id, other)
      // 对称：保留先算到的即可；浮点结果对称，重复计算也不会漂移
      if (!sims.has(key)) sims.set(key, sim)
    }
    scored.sort((a, b) => (b.sim === a.sim ? a.id - b.id : b.sim - a.sim))
    neighbors.set(
      id,
      scored.slice(0, topK).map((item) => item.id)
    )
  }

  const seen = new Set<string>()
  const edges: EmbeddingEdge[] = []
  for (const id of ids) {
    const list = neighbors.get(id) ?? []
    for (const other of list) {
      if (mutual && !(neighbors.get(other) ?? []).includes(id)) continue
      const key = pairKey(id, other)
      if (seen.has(key)) continue
      seen.add(key)
      const weight = sims.get(key)
      if (!isFiniteNumber(weight)) continue
      edges.push({
        src: Math.min(id, other),
        dst: Math.max(id, other),
        weight
      })
    }
  }
  edges.sort((a, b) => (a.src === b.src ? a.dst - b.dst : a.src - b.src))
  return edges
}

/* ------------------------------------------------------------------ *
 * 向量读写（BLOB 小端 Float32）
 * ------------------------------------------------------------------ */

function encodeVector(vec: Float32Array): Buffer {
  const buffer = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i += 1) buffer.writeFloatLE(vec[i], i * 4)
  return buffer
}

function decodeVector(blob: Buffer): Float32Array {
  const length = Math.floor(blob.byteLength / 4)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) out[i] = blob.readFloatLE(i * 4)
  return out
}

export { encodeVector, decodeVector }

export interface WriteVectorsResult {
  written: number
  /** 维度与声明不一致而跳过的条数（不抛错，交由调用方判断） */
  skipped: number
}

/** 写入 / 覆盖主题向量（已归一化；不会自动归一化，调用方保证口径一致） */
export function writeThemeVectors(
  db: Db,
  vectors: readonly ThemeVector[],
  options: { model: string; dim: number; now?: number }
): WriteVectorsResult {
  const now = options.now ?? Date.now()
  const dim = Math.floor(options.dim)
  const insert = db.prepare(
    `INSERT INTO node_embeddings (node_id, model, dim, vec, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       vec = excluded.vec,
       updated_at = excluded.updated_at`
  )
  let written = 0
  let skipped = 0
  const run = db.transaction(() => {
    for (const item of vectors) {
      if (!Number.isInteger(item.nodeId) || item.nodeId <= 0 || dim <= 0 || item.vec.length !== dim) {
        skipped += 1
        continue
      }
      insert.run(item.nodeId, options.model, dim, encodeVector(item.vec), now)
      written += 1
    }
  })
  run()
  return { written, skipped }
}

export interface ReadVectorsResult {
  /** 首次出现的模型名（混合模型时仍返回第一条，由调用方校验） */
  model: string | null
  vectors: ThemeVector[]
  /** 维度不一致或 BLOB 损坏而跳过的条数 */
  skipped: number
}

/** 读主题向量；`model` 给定时只取该模型的行（换模型后旧向量不参与连线） */
export function readThemeVectors(db: Db, options: { model?: string } = {}): ReadVectorsResult {
  const rows = (
    options.model
      ? db
          .prepare('SELECT node_id, model, dim, vec FROM node_embeddings WHERE model = ? ORDER BY node_id ASC')
          .all(options.model)
      : db.prepare('SELECT node_id, model, dim, vec FROM node_embeddings ORDER BY node_id ASC').all()
  ) as Array<{ node_id: number; model: string; dim: number; vec: Buffer }>

  const vectors: ThemeVector[] = []
  let model: string | null = null
  let skipped = 0
  for (const row of rows) {
    if (model === null) model = row.model
    const vec = decodeVector(row.vec)
    if (row.dim !== vec.length) {
      skipped += 1
      continue
    }
    vectors.push({ nodeId: row.node_id, vec })
  }
  return { model, vectors, skipped }
}

export interface WriteEdgesResult {
  deleted: number
  inserted: number
}

/**
 * 全量重写 `kind='embedding'` 边（先删后插，同一事务）。
 * 旧 `kind='ai'` 边不动：查询层默认过滤，显式清理另开操作（§4.4）。
 */
export function writeEmbeddingEdges(
  db: Db,
  edges: readonly EmbeddingEdge[],
  evidence: EdgeEvidence
): WriteEdgesResult {
  const evidenceText = JSON.stringify(evidence)
  const insert = db.prepare(
    `INSERT INTO edges (src, dst, weight, kind, evidence) VALUES (?, ?, ?, 'embedding', ?)`
  )
  let deleted = 0
  let inserted = 0
  const run = db.transaction(() => {
    deleted = db.prepare("DELETE FROM edges WHERE kind = 'embedding'").run().changes
    for (const edge of edges) {
      insert.run(edge.src, edge.dst, edge.weight, evidenceText)
      inserted += 1
    }
  })
  run()
  return { deleted, inserted }
}
