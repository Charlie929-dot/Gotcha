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
import { backfillAllMoments, readMomentEventIds, type MomentBackfillResult } from './moments'
import { embedThemeVectors, type ThemeEmbeddingResult } from './theme-embeddings'
import { backfillThemeMemberships, readOwnerMemberships, type MembershipBackfillResult } from './theme-membership'
import type { Embedder } from './embedding/types'
import {
  countMissingEventVectors,
  embedEventVectors,
  readEventVectors,
  type EventEmbeddingResult
} from './event-embeddings'
import {
  computeMomentVectors,
  computeThemeCentroids,
  findMergeCandidates,
  planThemeMerges,
  writeThemeCentroids,
  type ThemeCentroid,
  type ThemeIdentity
} from './theme-centroids'
import { applyThemeMerges, type ThemeMergeReport } from './theme-merge'
import {
  applySecondaryMemberships,
  planSecondaryMemberships,
  type SecondaryBackfillResult
} from './theme-secondary'
import { readGraphThresholds, type GraphThresholds } from './graph-thresholds'

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

/* ------------------------------------------------------------------ *
 * P0.5：合并 → 重连边 → 次归属（docs/m2-graph-redesign.md §5）
 * ------------------------------------------------------------------ */

/** 阈值缺省从 `settings` 读（`readGraphThresholds`），用例可显式注入 */
export interface ThemeGraphOptions extends GraphBackfillOptions {
  thresholds?: GraphThresholds
  /** 关闭合并（调试 / 只用已有数据连边时） */
  merge?: boolean
  /** 关闭次归属回填 */
  secondary?: boolean
}

export interface ThemeGraphReport {
  /** 结构回填结果（`embeddings` / `edges` 由本函数补上） */
  structure: GraphBackfillReport
  events: EventEmbeddingResult | null
  /** 主题质心统计（合并前后各写一次库；这里报最终值） */
  centroids: { themes: number; themeMemberEvents: number } | null
  merges: ThemeMergeReport | null
  secondary: SecondaryBackfillResult | null
  /** 本次没做合并/次归属的原因（`null` = 全跑完） */
  deferred: string | null
}

/** 合并固定点的最大轮数（合并会改变存活主题质心，可能带出新的近重复；实测 2 轮收敛） */
const MAX_MERGE_ROUNDS = 8

function readActiveThemes(db: Db): Array<{ id: number; type: string }> {
  return db
    .prepare(
      'SELECT id, type FROM nodes WHERE level = 1 AND merged_into IS NULL ORDER BY id ASC'
    )
    .all() as Array<{ id: number; type: string }>
}

function rebuildEmbeddingEdges(
  db: Db,
  model: string,
  thresholds: GraphThresholds
): { deleted: number; inserted: number } | null {
  const vectors = readThemeVectors(db, { model }).vectors
  if (vectors.length === 0) return null
  const built = buildEmbeddingEdges(vectors, {
    minSim: thresholds.edgeMinSim,
    topK: thresholds.edgeTopK,
    mutual: thresholds.edgeMutual
  })
  return writeEmbeddingEdges(db, built, {
    model,
    threshold: thresholds.edgeMinSim,
    topK: thresholds.edgeTopK,
    mutual: thresholds.edgeMutual
  })
}

/** 主题 id → 质心向量（写库/计划共用） */
function writeAllCentroids(
  db: Db,
  centroids: ReadonlyMap<number, ThemeCentroid>,
  model: string,
  now: number
): void {
  writeThemeCentroids(db, [...centroids.values()], { model, now })
}

function groupOwners(
  rows: readonly { themeId: number; momentId: number }[]
): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const row of rows) {
    const list = map.get(row.momentId)
    if (list) list.push(row.themeId)
    else map.set(row.momentId, [row.themeId])
  }
  return map
}

/**
 * P0.5 全流程（打开图谱时的后台回填入口）：
 * 结构回填 → 标题向量 → 事件向量（只算缺失）→ 主题质心 → 合并 → 重算标题向量/质心 →
 * 重建 embedding 边 → 次归属。
 *
 * 幂等：每一步 `onlyMissing` / `INSERT OR IGNORE`；合并只在质心完整时进行，
 * 事件向量没算完（模型缺失/中断）时只连边并标记 `deferred`，下次打开继续。
 */
export async function backfillThemeGraph(
  db: Db,
  options: ThemeGraphOptions = {}
): Promise<ThemeGraphReport> {
  const now = options.now ?? Date.now()
  const thresholds = options.thresholds ?? readGraphThresholds(db)

  // 没有 embedder：退回旧路径（用例/离线向量），不碰事件向量与合并
  if (!options.embedder) {
    const structure = await backfillGraphStructures(db, options)
    return {
      structure,
      events: null,
      centroids: null,
      merges: null,
      secondary: null,
      deferred: options.embedding ? null : 'no-embedder'
    }
  }

  const embedder = options.embedder
  const structure = await backfillGraphStructures(db, {
    now,
    ...(options.maxDays !== undefined ? { maxDays: options.maxDays } : {})
  })
  const report: ThemeGraphReport = {
    structure,
    events: null,
    centroids: null,
    merges: null,
    secondary: null,
    deferred: null
  }

  const title = await embedThemeVectors(db, embedder, { now })
  structure.embeddings = title
  if (!title.ok) {
    report.deferred = 'title-embedding-failed'
    structure.edges = rebuildEmbeddingEdges(db, embedder.model, thresholds)
    return report
  }

  const events = await embedEventVectors(db, embedder, { now })
  report.events = events
  if (!events.ok) {
    report.deferred = 'event-embedding-failed'
    structure.edges = rebuildEmbeddingEdges(db, embedder.model, thresholds)
    return report
  }

  const missing = countMissingEventVectors(db, embedder.model)
  if (missing > 0) {
    report.deferred = `event-vectors-incomplete:${missing}`
    structure.edges = rebuildEmbeddingEdges(db, embedder.model, thresholds)
    return report
  }

  const eventVectors = readEventVectors(db, { model: embedder.model }).vectors
  const momentEventIds = readMomentEventIds(db)
  let owners = readOwnerMemberships(db)
  let centroids = computeThemeCentroids(owners, momentEventIds, eventVectors)
  writeAllCentroids(db, centroids, embedder.model, now)

  let mergeReport: ThemeMergeReport | null = null
  if (options.merge !== false) {
    // 合并会改变存活主题的质心（成员并集），可能又贴近别的主题：跑到固定点（有上限）
    const aggregate: ThemeMergeReport = {
      plans: 0,
      applied: 0,
      skipped: 0,
      mergedNodes: 0,
      movedMemberships: 0,
      droppedMemberships: 0,
      touched: [],
      merges: []
    }
    const touched = new Set<number>()
    let rounds = 0
    while (rounds < MAX_MERGE_ROUNDS) {
      const themes = readActiveThemes(db)
      const identity: ThemeIdentity[] = themes
        .filter((theme) => centroids.has(theme.id) && theme.type !== 'protected')
        .map((theme) => ({
          id: theme.id,
          type: theme.type,
          vec: (centroids.get(theme.id) as ThemeCentroid).vec
        }))
      const memberCounts = new Map<number, number>()
      for (const [id, centroid] of centroids) memberCounts.set(id, centroid.memberEvents)
      const candidates = findMergeCandidates(identity, thresholds.themeMergeSim)
      const plans = planThemeMerges(candidates, identity, memberCounts, {
        minSim: thresholds.themeMergeSim
      })
      if (plans.length === 0) break
      const applied = applyThemeMerges(db, plans, { now })
      aggregate.plans += applied.plans
      aggregate.applied += applied.applied
      aggregate.skipped += applied.skipped
      aggregate.mergedNodes += applied.mergedNodes
      aggregate.movedMemberships += applied.movedMemberships
      aggregate.droppedMemberships += applied.droppedMemberships
      aggregate.merges.push(...applied.merges)
      for (const id of applied.touched) touched.add(id)
      // 一个都没合上（候选全被人工撤销过的对挡掉）：已经是固定点，别再空转 8 轮
      if (applied.applied === 0) break
      owners = readOwnerMemberships(db)
      centroids = computeThemeCentroids(owners, momentEventIds, eventVectors)
      writeAllCentroids(db, centroids, embedder.model, now)
      rounds += 1
    }
    aggregate.touched = [...touched].sort((a, b) => a - b)
    if (aggregate.applied > 0) {
      mergeReport = aggregate
      // 合并改了存活主题的摘要/成员：补算标题向量（连边用）
      const reEmbed = await embedThemeVectors(db, embedder, { now })
      if (!reEmbed.ok) {
        report.deferred = 'title-embedding-failed'
        structure.edges = rebuildEmbeddingEdges(db, embedder.model, thresholds)
        return report
      }
      structure.embeddings = {
        ...title,
        themes: title.themes + reEmbed.themes,
        embedded: title.embedded + reEmbed.embedded,
        skipped: title.skipped + reEmbed.skipped,
        ms: title.ms + reEmbed.ms
      }
    }
    if (rounds >= MAX_MERGE_ROUNDS) {
      report.deferred = 'merge-rounds-exhausted'
    }
  }
  report.merges = mergeReport

  structure.edges = rebuildEmbeddingEdges(db, embedder.model, thresholds)
  report.centroids = {
    themes: centroids.size,
    themeMemberEvents: [...centroids.values()].reduce((sum, item) => sum + item.memberEvents, 0)
  }

  if (options.secondary !== false) {
    const momentVectors = computeMomentVectors(momentEventIds, eventVectors)
    const ownedMomentIds = [...new Set(owners.map((row) => row.momentId))]
    const active = readActiveThemes(db)
    const themeInput = active
      .filter((theme) => centroids.has(theme.id) && theme.type !== 'protected')
      .map((theme) => ({
        id: theme.id,
        type: theme.type,
        vec: (centroids.get(theme.id) as ThemeCentroid).vec
      }))
    const moments = ownedMomentIds
      .map((id) => {
        const vec = momentVectors.get(id)
        return vec ? { id, vec } : null
      })
      .filter((item): item is { id: number; vec: Float32Array } => item !== null)
    const plans = planSecondaryMemberships(moments, themeInput, groupOwners(owners), {
      minSim: thresholds.themeMemberMinSim,
      duplicateSim: thresholds.themeDuplicateSim,
      max: thresholds.themeSecondaryMax
    })
    report.secondary = applySecondaryMemberships(db, plans, ownedMomentIds, { now })
  }

  return report
}
