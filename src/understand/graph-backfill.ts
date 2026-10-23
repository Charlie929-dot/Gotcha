/**
 * 图谱 v3 结构回填编排（docs/m2-graph-redesign.md §4.5）
 *
 * 顺序固定：时刻 → 主归属 → （有向量时）全局边。每一步都幂等、可重入，
 * 可以整体重跑（事件/主题是追加写的），也可以在某个主题改动后只跑局部。
 *
 * 不做的事：
 * - 不生成主题向量（需要本地 embedding 运行时，由 P1 向量回填 / P2 在线服务提供）；
 * - 不写布局坐标（`node_positions` 由渲染层沉降后回传）；
 * - 不删 `kind='ai'` 旧边，也不改 `nodes.source_events`。
 */

import type { Db } from '../db'
import {
  buildEmbeddingEdges,
  EMBEDDING_EDGE_DEFAULTS,
  writeEmbeddingEdges,
  type EdgeBuildOptions,
  type ThemeVector
} from './graph-edges'
import { backfillAllMoments, type MomentBackfillResult } from './moments'
import {
  backfillThemeMemberships,
  type MembershipBackfillResult
} from './theme-membership'

export interface GraphBackfillOptions {
  /** 写入 created_at 的时间；用例注入固定值 */
  now?: number
  /** 时刻回填最多处理的天数 */
  maxDays?: number
  /** 有向量时顺便重建全局边；缺省不碰 edges 表 */
  embedding?: {
    model: string
    vectors: readonly ThemeVector[]
  } & EdgeBuildOptions
}

export interface GraphBackfillReport {
  moments: MomentBackfillResult
  memberships: MembershipBackfillResult
  edges: { deleted: number; inserted: number } | null
}

/**
 * 回填图谱 v3 结构：时刻 → 主归属 →（可选）embedding 边。
 * 先跑 `backfillAllMoments` 再跑归属，否则 `source_events` 找不到对应时刻。
 */
export function backfillGraphStructures(
  db: Db,
  options: GraphBackfillOptions = {}
): GraphBackfillReport {
  const moments = backfillAllMoments(db, { now: options.now, maxDays: options.maxDays })
  const memberships = backfillThemeMemberships(db, { now: options.now })

  let edges: GraphBackfillReport['edges'] = null
  if (options.embedding) {
    const built = buildEmbeddingEdges(options.embedding.vectors, {
      minSim: options.embedding.minSim,
      topK: options.embedding.topK,
      mutual: options.embedding.mutual
    })
    edges = writeEmbeddingEdges(db, built, {
      model: options.embedding.model,
      threshold: options.embedding.minSim ?? EMBEDDING_EDGE_DEFAULTS.minSim,
      topK: options.embedding.topK ?? EMBEDDING_EDGE_DEFAULTS.topK,
      mutual: options.embedding.mutual ?? EMBEDDING_EDGE_DEFAULTS.mutual
    })
  }

  return { moments, memberships, edges }
}
