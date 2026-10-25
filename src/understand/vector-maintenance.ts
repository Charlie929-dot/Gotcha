/**
 * 向量增量维护（M2 P2 · S3，docs/m2-graph-redesign.md §5.1 / §5.2）
 *
 * 目标：**只算变化行**。
 * - 标题向量：文本指纹（`node_embeddings.text_hash`）一致就复用，别每次打开图谱重跑 400 次推理；
 * - 主题质心：成员事件 id 集合指纹（`theme_centroids.members_hash`）一致就复用，别再整表求均值；
 * - 新时刻：只算它自己的质心（`maintainMomentVectors`），不牵连别的时刻/主题。
 *
 * 为什么不靠「写入时删旧行」做失效：那种做法要求每个改标题/摘要/归属的调用点都记得删，
 * 漏一处就永远留过期向量（今天的归纳批量路径就会原地改摘要）；指纹是**自愈**的——
 * 输入变了就重算，输入没变就跳过，谁改的、什么时候改的都不重要。
 *
 * 老库（v6 之前）的 `text_hash` / `members_hash` 是 NULL：第一次维护各自重算一次补上指纹。
 * 全程本地、零出网；推理仍由调用方传入 embedder（本模块只处理「哪些行要算」与质心算术）。
 */

import type { Db } from '../db'
import { readEventVectors } from './event-embeddings'
import { readMomentEventIds } from './moments'
import { momentVector } from './theme-assign'
import {
  computeThemeCentroids,
  deleteThemeCentroids,
  planThemeCentroids,
  readThemeCentroids,
  writeThemeCentroids,
  type ThemeCentroid,
  type ThemeMembershipRef
} from './theme-centroids'
import { readOwnerMemberships } from './theme-membership'

export const VECTOR_MAINTENANCE_DEFAULTS = {
  /** 一次维护最多重算多少个主题质心（在线路径分片用；回填路径不设上限） */
  centroidChunk: 64
} as const

export interface ThemeCentroidSyncReport {
  /** 同步后库里的质心数 */
  themes: number
  /** 本次判定需要重算的主题数 */
  stale: number
  /** 实际写入（重算）的条数 */
  recomputed: number
  /** 指纹一致、直接复用的条数 */
  reused: number
  /** 成员已经没了而删掉的条数 */
  deleted: number
  /** 有归属但还没有可用事件向量的主题数（等下一轮） */
  pending: number
  /** 参与求均值的事件数合计（去重后） */
  memberEvents: number
  /** 维度不一致 / 坏行跳过数 */
  skipped: number
  ms: number
}

export interface SyncThemeCentroidsOptions {
  model: string
  dim: number
  now?: number
  /** 缺省现读 owner + manual 归属 */
  memberships?: readonly ThemeMembershipRef[]
  momentEventIds?: ReadonlyMap<number, readonly number[]>
  /** 缺省现读该模型的事件向量 */
  eventVectors?: ReadonlyMap<number, Float32Array>
}

export interface SyncThemeCentroidsResult {
  centroids: Map<number, ThemeCentroid>
  report: ThemeCentroidSyncReport
}

/**
 * 同步主题质心：只重算 `planThemeCentroids` 挑出来的行，其余整行复用。
 * 返回同步后的**全量**质心（合并/次归属/画布都要全量），调用方不必再读一次库。
 */
export function syncThemeCentroids(
  db: Db,
  options: SyncThemeCentroidsOptions
): SyncThemeCentroidsResult {
  const started = Date.now()
  const now = options.now ?? started
  const memberships = options.memberships ?? readOwnerMemberships(db)
  const momentEventIds = options.momentEventIds ?? readMomentEventIds(db)
  const eventVectors =
    options.eventVectors ?? readEventVectors(db, { model: options.model }).vectors

  const plan = planThemeCentroids(db, {
    model: options.model,
    dim: options.dim,
    memberships,
    momentEventIds,
    eventVectorIds: new Set(eventVectors.keys())
  })

  let recomputed = 0
  let skipped = 0
  if (plan.stale.length > 0) {
    const stale = new Set(plan.stale)
    const subset = memberships.filter((row) => stale.has(row.themeId))
    const computed = computeThemeCentroids(subset, momentEventIds, eventVectors)
    const written = writeThemeCentroids(db, [...computed.values()], { model: options.model, now })
    recomputed = written.written
    skipped += written.skipped
  }
  const deleted = deleteThemeCentroids(db, plan.dropped)

  const read = readThemeCentroids(db, { model: options.model })
  skipped += read.skipped
  let memberEvents = 0
  for (const centroid of read.centroids.values()) memberEvents += centroid.memberEvents

  return {
    centroids: read.centroids,
    report: {
      themes: read.centroids.size,
      stale: plan.stale.length,
      recomputed,
      reused: plan.reused,
      deleted,
      pending: plan.pending,
      memberEvents,
      skipped,
      ms: Date.now() - started
    }
  }
}

export type RefreshThemeCentroidStatus = 'ok' | 'no-members' | 'no-vectors'

export interface RefreshThemeCentroidResult {
  status: RefreshThemeCentroidStatus
  centroid: ThemeCentroid | null
}

/**
 * 只重算**一个**主题的质心（在线路径里「新时刻归到这个主题」之后的最小增量）。
 * - 没有成员了 → 删掉这行，返回 `no-members`；
 * - 有成员但都还没有向量 → 不动库（保留旧行），返回 `no-vectors`。
 */
export function refreshThemeCentroid(
  db: Db,
  themeId: number,
  options: SyncThemeCentroidsOptions
): RefreshThemeCentroidResult {
  if (!Number.isInteger(themeId) || themeId <= 0) return { status: 'no-members', centroid: null }
  const now = options.now ?? Date.now()
  const memberships = (
    options.memberships ?? readOwnerMemberships(db)
  ).filter((row) => row.themeId === themeId)
  if (memberships.length === 0) {
    deleteThemeCentroids(db, [themeId])
    return { status: 'no-members', centroid: null }
  }
  const momentEventIds = options.momentEventIds ?? readMomentEventIds(db)
  const eventVectors =
    options.eventVectors ?? readEventVectors(db, { model: options.model }).vectors
  const computed = computeThemeCentroids(memberships, momentEventIds, eventVectors)
  const centroid = computed.get(themeId)
  if (!centroid) return { status: 'no-vectors', centroid: null }
  writeThemeCentroids(db, [centroid], { model: options.model, now })
  return { status: 'ok', centroid }
}

export interface MomentVectorsResult {
  /** 请求的时刻数 */
  requested: number
  /** 算出来的时刻数 */
  computed: number
  /** 没有事件向量的时刻 id（升序） */
  missing: number[]
  vectors: Map<number, Float32Array>
}

/**
 * 只算这些时刻自己的质心（新时刻落库后的增量入口）。
 * 不读写主题质心、不碰别的时刻——「新时刻只算它自己的质心」就在这里。
 */
export function maintainMomentVectors(
  db: Db,
  momentIds: readonly number[]
): MomentVectorsResult {
  const vectors = new Map<number, Float32Array>()
  const missing: number[] = []
  const seen = new Set<number>()
  for (const momentId of momentIds) {
    if (!Number.isInteger(momentId) || momentId <= 0 || seen.has(momentId)) continue
    seen.add(momentId)
    const vec = momentVector(db, momentId)
    if (vec) vectors.set(momentId, vec)
    else missing.push(momentId)
  }
  missing.sort((a, b) => a - b)
  return { requested: seen.size, computed: vectors.size, missing, vectors }
}
