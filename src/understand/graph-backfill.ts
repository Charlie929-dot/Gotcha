/**
 * 图谱 v3 结构回填编排（docs/m2-graph-redesign.md §4.5）
 *
 * 顺序固定：时刻 → 主归属 → 主题向量 → 全局边。每一步都幂等、可重入，
 * 可以整体重跑（事件/主题是追加写的），也可以在某个主题改动后只跑局部。
 *
 * 不做的事：
 * - 不写布局坐标（`node_positions` 由渲染层沉降后回传）；
 * - 不删 `kind='ai'` 旧边，也不改 `nodes.source_events`。
 */

import type { Db } from '../db'
import {
  buildEmbeddingEdges,
  EMBEDDING_EDGE_DEFAULTS,
  readThemeVectors,
  writeEmbeddingEdges,
  type EdgeBuildOptions,
  type ThemeVector
} from './graph-edges'
import { backfillAllMoments, type MomentBackfillResult } from './moments'
import { embedThemeVectors, type ThemeEmbeddingResult } from './theme-embeddings'
import { backfillThemeMemberships, type MembershipBackfillResult } from './theme-membership'
import type { Embedder } from './embedding/types'

export interface GraphBackfillOptions {
  /** 写入 created_at / updated_at 的时间；用例注入固定值 */
  now?: number
  /** 时刻回填最多处理的天数 */
  maxDays?: number
  /** 直接给向量（离线/用例）：有它就不跑模型 */
  embedding?: {
    model: string
    vectors: readonly ThemeVector[]
  } & EdgeBuildOptions
  /** 现算向量（本地模型）：只补缺失向量，再重建边 */
  embedder?: Embedder
  /** 边参数（`embedder` / `embedding` 共用；缺省用 §5.2 初值） */
  edge?: EdgeBuildOptions
}

export interface GraphBackfillReport {
  moments: MomentBackfillResult
  memberships: MembershipBackfillResult
  embeddings: ThemeEmbeddingResult | null
  edges: { deleted: number; inserted: number } | null
}

const EDGE_EVIDENCE_DEFAULTS = {
  threshold: EMBEDDING_EDGE_DEFAULTS.minSim,
  topK: EMBEDDING_EDGE_DEFAULTS.topK,
  mutual: EMBEDDING_EDGE_DEFAULTS.mutual
} as const

/**
 * 回填图谱 v3 结构：时刻 → 主归属 →（可选）向量与 embedding 边。
 * 先跑 `backfillAllMoments` 再跑归属，否则 `source_events` 找不到对应时刻。
 */
export async function backfillGraphStructures(
  db: Db,
  options: GraphBackfillOptions = {}
): Promise<GraphBackfillReport> {
  const moments = backfillAllMoments(db, { now: options.now, maxDays: options.maxDays })
  const memberships = backfillThemeMemberships(db, { now: options.now })

  // 现算向量：只在给了 embedder 时跑；失败不阻塞结构回填（结果里带 ok:false）
  let embeddings: ThemeEmbeddingResult | null = null
  let model = options.embedding?.model ?? null
  if (options.embedder) {
    embeddings = await embedThemeVectors(db, options.embedder, { now: options.now })
    model = options.embedder.model
  }

  let vectors: readonly ThemeVector[] = options.embedding?.vectors ?? []
  if (!options.embedding?.vectors && model) {
    vectors = readThemeVectors(db, { model }).vectors
  }

  let edges: GraphBackfillReport['edges'] = null
  if (model && vectors.length > 0) {
    const edgeOptions: EdgeBuildOptions = options.edge ?? options.embedding ?? {}
    const built = buildEmbeddingEdges(vectors, edgeOptions)
    edges = writeEmbeddingEdges(db, built, {
      model,
      threshold: edgeOptions.minSim ?? EDGE_EVIDENCE_DEFAULTS.threshold,
      topK: edgeOptions.topK ?? EDGE_EVIDENCE_DEFAULTS.topK,
      mutual: edgeOptions.mutual ?? EDGE_EVIDENCE_DEFAULTS.mutual
    })
  }

  return { moments, memberships, embeddings, edges }
}
