/**
 * 时刻向量、主题质心与合并计划（docs/m2-graph-redesign.md §5.1；增量口径见 P2 · S3）
 *
 * - 时刻向量 = 成员事件向量的均值再 L2（与 v0.2 的「成员均值质心」口径一致）；
 * - 主题质心 = 该主题 owner 归属时刻的成员事件向量均值再 L2；
 * - `membersHash` = 参与求均值的（去重）事件 id 集合指纹：成员没变就整行复用，不必重算；
 * - 合并候选/连通分量是纯函数（只吃向量与成员数），不碰库、不调模型，用例用假向量；
 * - 铁律：合并判定只用**成员事件质心**，`title+summary` 向量（`node_embeddings`）只用于连线。
 */

import type { Db } from '../db'
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  normalizeVector
} from './graph-edges'
import { eventIdsFingerprint } from './vector-fingerprint'
import { readOwnerMemberships } from './theme-membership'
import { readMomentEventIds } from './moments'

/** 一条已归一化的质心向量 + 参与求均值的去重事件数 */
export interface ThemeCentroid {
  nodeId: number
  vec: Float32Array
  memberEvents: number
  /** 参与求均值的事件 id 集合指纹；老行为 undefined（下次维护补上） */
  membersHash?: string
}

/** 主题身份（合并候选要同 type，否则不合并） */
export interface ThemeIdentity {
  id: number
  type: string
  vec: Float32Array
}

export interface MergeCandidate {
  a: number
  b: number
  sim: number
}

/** 一次合并计划：`from` 全部并入 `into`（`into` 保留 id 与位置） */
export interface ThemeMergePlan {
  into: number
  from: number[]
  reason: string
}

/** 均值向量（不归一化；空输入返回 null；维度不一致的向量跳过） */
export function averageVectors(vectors: readonly Float32Array[]): Float32Array | null {
  let dim = 0
  for (const vec of vectors) {
    if (vec.length > 0) {
      dim = vec.length
      break
    }
  }
  if (dim === 0) return null
  const sum = new Float32Array(dim)
  let count = 0
  for (const vec of vectors) {
    if (vec.length !== dim) continue
    for (let i = 0; i < dim; i += 1) sum[i] += vec[i]
    count += 1
  }
  if (count === 0) return null
  for (let i = 0; i < dim; i += 1) sum[i] /= count
  return sum
}

/** 按成员事件求时刻向量（均值 + L2；没有可用事件向量的时刻不返回） */
export function computeMomentVectors(
  momentEventIds: ReadonlyMap<number, readonly number[]>,
  eventVectors: ReadonlyMap<number, Float32Array>
): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>()
  for (const [momentId, eventIds] of momentEventIds) {
    const vectors: Float32Array[] = []
    for (const eventId of eventIds) {
      const vec = eventVectors.get(eventId)
      if (vec) vectors.push(vec)
    }
    const mean = averageVectors(vectors)
    if (mean) out.set(momentId, normalizeVector(mean))
  }
  return out
}

/**
 * 按 owner 归属求主题质心。
 * 同一事件被多个时刻引用只算一次（去重），成员事件数取去重后实际有向量的条数。
 * 同时给每行算 `membersHash`（参与求均值的事件 id 集合指纹），供增量维护判断「成员变了没有」。
 */
export function computeThemeCentroids(
  memberships: readonly { themeId: number; momentId: number }[],
  momentEventIds: ReadonlyMap<number, readonly number[]>,
  eventVectors: ReadonlyMap<number, Float32Array>
): Map<number, ThemeCentroid> {
  const seen = new Map<number, Set<number>>()
  const sum = new Map<number, { vec: Float32Array; dim: number }>()
  const count = new Map<number, number>()
  const contributing = new Map<number, number[]>()

  const accumulate = (themeId: number, eventId: number, vec: Float32Array): void => {
    let ids = seen.get(themeId)
    if (!ids) {
      ids = new Set<number>()
      seen.set(themeId, ids)
    }
    if (ids.has(eventId)) return
    ids.add(eventId)
    let acc = sum.get(themeId)
    if (!acc) {
      acc = { vec: new Float32Array(vec.length), dim: vec.length }
      sum.set(themeId, acc)
    }
    if (vec.length !== acc.dim) return
    for (let i = 0; i < acc.dim; i += 1) acc.vec[i] += vec[i]
    count.set(themeId, (count.get(themeId) ?? 0) + 1)
    const list = contributing.get(themeId)
    if (list) list.push(eventId)
    else contributing.set(themeId, [eventId])
  }

  for (const membership of memberships) {
    const eventIds = momentEventIds.get(membership.momentId)
    if (!eventIds) continue
    for (const eventId of eventIds) {
      const vec = eventVectors.get(eventId)
      if (vec) accumulate(membership.themeId, eventId, vec)
    }
  }

  const out = new Map<number, ThemeCentroid>()
  for (const [themeId, acc] of sum) {
    const n = count.get(themeId) ?? 0
    if (n === 0) continue
    const mean = new Float32Array(acc.dim)
    for (let i = 0; i < acc.dim; i += 1) mean[i] = acc.vec[i] / n
    out.set(themeId, {
      nodeId: themeId,
      vec: normalizeVector(mean),
      memberEvents: n,
      membersHash: eventIdsFingerprint(contributing.get(themeId) ?? [])
    })
  }
  return out
}

/**
 * 找合并候选对：同 type、质心相似度 ≥ minSim。
 * 输出按 sim 降序、再按 id 升序（确定性，便于用例与审计复现）。
 */
export function findMergeCandidates(
  themes: readonly ThemeIdentity[],
  minSim: number
): MergeCandidate[] {
  const sorted = [...themes].sort((a, b) => a.id - b.id)
  const candidates: MergeCandidate[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]
      const b = sorted[j]
      if (a.type !== b.type) continue
      const sim = cosineSimilarity(a.vec, b.vec)
      if (!Number.isFinite(sim) || sim < minSim) continue
      candidates.push({ a: a.id, b: b.id, sim })
    }
  }
  candidates.sort((x, y) => (y.sim === x.sim ? (x.a === y.a ? x.b - y.b : x.a - y.a) : y.sim - x.sim))
  return candidates
}

/**
 * 主题成员 → 需要重算质心的主题（P2 · S3 增量）。
 *
 * 输入都是「现读或注入」：归属（owner + manual）、时刻→事件 id、以及**已有该模型向量的**事件 id。
 * 判据只看 `members_hash`（参与求均值的事件 id 集合指纹）：
 * - 没有质心行 / 换了模型 / 指纹变了 → `stale`（重算）；
 * - 指纹一致 → `reused`（整行复用，不解 BLOB、不做加法）；
 * - 有归属但一个可用向量都没有（模型没算完）→ `pending`，原行留着，等下一轮；
 * - 有质心行但成员已经没了（主题被合并 / 归属被清）→ `dropped`。
 *
 * 纯读；写与删由调用方（`vector-maintenance.ts` 的 `syncThemeCentroids`）落库。
 */
export interface ThemeMembershipRef {
  themeId: number
  momentId: number
}

export interface ThemeCentroidPlanOptions {
  model: string
  dim: number
  memberships?: readonly ThemeMembershipRef[]
  momentEventIds?: ReadonlyMap<number, readonly number[]>
  /** 有该 model+dim 向量的事件 id（缺省现读 `event_embeddings`） */
  eventVectorIds?: ReadonlySet<number>
}

export interface ThemeCentroidPlan {
  /** 需要重算（或新建）的主题 id，升序 */
  stale: number[]
  /** 指纹一致、直接复用的主题数 */
  reused: number
  /** 成员已经没了、该删掉质心行的主题 id，升序 */
  dropped: number[]
  /** 有归属但还没有可用事件向量的主题数（原行保留，等向量补齐） */
  pending: number
}

/** 有该模型 + 维度向量的事件 id（只读 id，不解 BLOB） */
export function readEventVectorIds(db: Db, model: string, dim: number): Set<number> {
  const rows = db
    .prepare('SELECT event_id FROM event_embeddings WHERE model = ? AND dim = ? ORDER BY event_id ASC')
    .all(model, Math.floor(dim)) as Array<{ event_id: number }>
  return new Set(rows.map((row) => row.event_id))
}

export function planThemeCentroids(
  db: Db,
  options: ThemeCentroidPlanOptions
): ThemeCentroidPlan {
  const memberships = options.memberships ?? readOwnerMemberships(db)
  const momentEventIds = options.momentEventIds ?? readMomentEventIds(db)
  const eventVectorIds =
    options.eventVectorIds ?? readEventVectorIds(db, options.model, options.dim)

  // 每个主题实际能参与求均值的事件 id（去重；事件属于哪个时刻由 `moments` 决定）
  const memberIds = new Map<number, Set<number>>()
  for (const membership of memberships) {
    const eventIds = momentEventIds.get(membership.momentId)
    if (!eventIds || eventIds.length === 0) continue
    let ids = memberIds.get(membership.themeId)
    if (!ids) {
      ids = new Set<number>()
      memberIds.set(membership.themeId, ids)
    }
    for (const eventId of eventIds) {
      if (eventVectorIds.has(eventId)) ids.add(eventId)
    }
  }

  const existing = new Map<number, { model: string; membersHash: string | null }>()
  const rows = db
    .prepare('SELECT node_id, model, members_hash FROM theme_centroids ORDER BY node_id ASC')
    .all() as Array<{ node_id: number; model: string; members_hash: string | null }>
  for (const row of rows) {
    existing.set(row.node_id, { model: row.model, membersHash: row.members_hash ?? null })
  }

  const stale: number[] = []
  const dropped: number[] = []
  let reused = 0
  let pending = 0
  for (const [themeId, ids] of memberIds) {
    if (ids.size === 0) {
      // 有归属、但向量还没算出来：报 pending，别把现有质心删掉
      pending += 1
      continue
    }
    const hash = eventIdsFingerprint(ids)
    const row = existing.get(themeId)
    if (row && row.model === options.model && row.membersHash === hash) {
      reused += 1
      continue
    }
    stale.push(themeId)
  }
  for (const themeId of existing.keys()) {
    if (!memberIds.has(themeId)) dropped.push(themeId)
  }

  stale.sort((a, b) => a - b)
  dropped.sort((a, b) => a - b)
  return { stale, reused, dropped, pending }
}

function findRoot(parent: Map<number, number>, id: number): number {
  let root = parent.get(id) ?? id
  while (root !== (parent.get(root) ?? root)) root = parent.get(root) as number
  // 路径压缩
  let cursor = id
  while (cursor !== root) {
    const next = parent.get(cursor) ?? cursor
    parent.set(cursor, root)
    cursor = next
  }
  return root
}

function union(parent: Map<number, number>, a: number, b: number): void {
  const rootA = findRoot(parent, a)
  const rootB = findRoot(parent, b)
  if (rootA === rootB) return
  if (rootA < rootB) parent.set(rootB, rootA)
  else parent.set(rootA, rootB)
}

/**
 * 由候选对算合并计划：按连通分量合并，一个分量产出一条 plan。
 * - 存活节点 = 成员事件最多的（并列取 id 最小），保留它的 id / 位置 / 标题；
 * - 其余节点按 id 升序进入 `from`，可整体撤销（`node_merges` 有快照）。
 */
export function planThemeMerges(
  candidates: readonly MergeCandidate[],
  themes: readonly ThemeIdentity[],
  memberCounts: ReadonlyMap<number, number>,
  options: { minSim: number }
): ThemeMergePlan[] {
  const byId = new Map<number, ThemeIdentity>()
  for (const theme of themes) byId.set(theme.id, theme)

  const parent = new Map<number, number>()
  const minEdge = new Map<number, number>()
  const valid = candidates.filter(
    (candidate) =>
      candidate.sim >= options.minSim && byId.has(candidate.a) && byId.has(candidate.b) && candidate.a !== candidate.b
  )
  for (const candidate of valid) {
    union(parent, candidate.a, candidate.b)
  }

  const components = new Map<number, Set<number>>()
  for (const candidate of valid) {
    const root = findRoot(parent, candidate.a)
    let set = components.get(root)
    if (!set) {
      set = new Set<number>()
      components.set(root, set)
    }
    set.add(candidate.a)
    set.add(candidate.b)
    const previous = minEdge.get(root)
    if (previous === undefined || candidate.sim < previous) minEdge.set(root, candidate.sim)
  }

  const plans: ThemeMergePlan[] = []
  for (const [root, ids] of components) {
    if (ids.size < 2) continue
    const list = [...ids].sort((a, b) => a - b)
    let into = list[0]
    let bestCount = memberCounts.get(into) ?? 0
    for (const id of list.slice(1)) {
      const count = memberCounts.get(id) ?? 0
      if (count > bestCount) {
        into = id
        bestCount = count
      }
    }
    const from = list.filter((id) => id !== into)
    const minSim = minEdge.get(root) ?? options.minSim
    plans.push({
      into,
      from,
      reason: `质心相似度≥${formatSim(options.minSim)}，分量 ${list.length} 个，最低对 ${formatSim(minSim)}`
    })
  }

  // 确定性输出：先按存活 id，再按分量大小
  plans.sort((a, b) => (a.into === b.into ? b.from.length - a.from.length : a.into - b.into))
  return plans
}

function formatSim(value: number): string {
  return value.toFixed(4)
}

/* ------------------------------------------------------------------ *
 * 质心读写
 * ------------------------------------------------------------------ */

export interface WriteCentroidsResult {
  written: number
  skipped: number
}

/** 写入 / 覆盖主题质心（已 L2 归一化；`member_events` 为去重事件数） */
export function writeThemeCentroids(
  db: Db,
  centroids: readonly ThemeCentroid[],
  options: { model: string; now?: number }
): WriteCentroidsResult {
  const now = options.now ?? Date.now()
  const insert = db.prepare(
    `INSERT INTO theme_centroids (node_id, model, dim, vec, member_events, updated_at, members_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       vec = excluded.vec,
       member_events = excluded.member_events,
       updated_at = excluded.updated_at,
       members_hash = excluded.members_hash`
  )
  let written = 0
  let skipped = 0
  const run = db.transaction(() => {
    for (const centroid of centroids) {
      if (!Number.isInteger(centroid.nodeId) || centroid.nodeId <= 0) {
        skipped += 1
        continue
      }
      if (centroid.vec.length === 0 || !Number.isInteger(centroid.memberEvents)) {
        skipped += 1
        continue
      }
      insert.run(
        centroid.nodeId,
        options.model,
        centroid.vec.length,
        encodeVector(centroid.vec),
        centroid.memberEvents,
        now,
        centroid.membersHash ?? null
      )
      written += 1
    }
  })
  run()
  return { written, skipped }
}

/** 删掉质心行（成员已经没了的主题；主题被合并时 `theme-merge` 也会删） */
export function deleteThemeCentroids(db: Db, nodeIds: readonly number[]): number {
  const ids = nodeIds.filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`DELETE FROM theme_centroids WHERE node_id IN (${placeholders})`).run(...ids).changes
}

export interface ReadCentroidsResult {
  model: string | null
  centroids: Map<number, ThemeCentroid>
  skipped: number
}

/** 读主题质心（`model` 给定时只取该模型，换模型后旧质心不参与合并） */
export function readThemeCentroids(
  db: Db,
  options: { model?: string } = {}
): ReadCentroidsResult {
  const rows = (
    options.model
      ? db
          .prepare(
            'SELECT node_id, model, dim, vec, member_events, members_hash FROM theme_centroids WHERE model = ? ORDER BY node_id ASC'
          )
          .all(options.model)
      : db
          .prepare(
            'SELECT node_id, model, dim, vec, member_events, members_hash FROM theme_centroids ORDER BY node_id ASC'
          )
          .all()
  ) as Array<{
    node_id: number
    model: string
    dim: number
    vec: Buffer
    member_events: number
    members_hash: string | null
  }>

  const centroids = new Map<number, ThemeCentroid>()
  let model: string | null = null
  let skipped = 0
  for (const row of rows) {
    if (model === null) model = row.model
    const vec = decodeVector(row.vec)
    if (row.dim !== vec.length) {
      skipped += 1
      continue
    }
    centroids.set(row.node_id, {
      nodeId: row.node_id,
      vec,
      memberEvents: row.member_events,
      membersHash: row.members_hash ?? undefined
    })
  }
  return { model, centroids, skipped }
}
