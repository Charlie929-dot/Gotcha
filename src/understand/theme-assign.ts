/**
 * 时刻 → 主题归属（M2 P2 · S2，docs/m2-graph-redesign.md §5.2 + 2026-10-25 重标）
 *
 * 纯本地、零出网：给一个时刻向量和一批主题质心，算出
 * - 主归属（owner）、次归属（secondaries），
 * - 以及「要不要出网让 LLM 确认」（ambiguous）。
 *
 * 判据来自真机标定（§5.2 那张 gap 分档表），不是拍脑袋的绝对阈值：
 * 1. top1 < `themeNewMinSim` → 新建主题（0.78 时 98.4% 的时刻都过线，它只管「像不像任何主题」）；
 * 2. top1 / top2 **互为近重复**（主题间相似度 ≥ `themeDuplicateSim`，实测 65.9% 的时刻都是这种）
 *    → 选谁语义等价，直接取 argmax，**不出网**；
 * 3. 其余情况 gap = top1 − top2：`gap < themeGapConfirm` 才 ambiguous（需要 LLM 确认）。
 *
 * 次归属沿用 §5.2：`sim ≥ themeMemberMinSim`，排除与 owner 近重复的主题，上限 `themeSecondaryMax`。
 * `protected`（内容已保护）主题不参与归属，也不做候选。
 */

import type { Db } from '../db'
import { cosineSimilarity, decodeVector, normalizeVector } from './graph-edges'
import { GRAPH_THRESHOLD_DEFAULTS, type GraphThresholds } from './graph-thresholds'
import { averageVectors } from './theme-centroids'

export interface AssignThemeCandidate {
  id: number
  vec: Float32Array
  /** 节点类型；`protected` 会被跳过 */
  type?: string
}

export interface AssignMomentInput {
  /** 时刻质心（成员事件均值 + L2，见 `computeMomentVectors`） */
  momentVec: Float32Array
  themes: readonly AssignThemeCandidate[]
  /** 缺省用 `GRAPH_THRESHOLD_DEFAULTS` */
  thresholds?: GraphThresholds
}

export type AssignReason =
  /** 直接归到 owner（不需要 LLM） */
  | 'assigned'
  /** 两个不同主题都像，交给 LLM 确认（本轮不落库） */
  | 'ambiguous'
  /** 没有合适的已有主题，应当新建（命名可能要 LLM，属 S4） */
  | 'new-theme'

export interface ScoredTheme {
  id: number
  sim: number
}

export interface MomentAssignment {
  reason: AssignReason
  /** 主归属；ambiguous / new-theme 时为 null（候选见 top1） */
  owner: ScoredTheme | null
  secondaries: ScoredTheme[]
  top1: ScoredTheme | null
  top2: ScoredTheme | null
  /** top1 − top2，只有一个候选时为 Infinity */
  gap: number
  /** top1 与 top2 是否互为近重复（选谁语义等价） */
  nearDuplicateTop: boolean
}

interface ScoredCandidate extends ScoredTheme {
  vec: Float32Array
}

/**
 * 归属判定（纯函数、确定性：相似度并列时 id 小的优先）。
 * 不写库、不调用 LLM；调用方拿 `ambiguous` 去排确认队列。
 */
export function assignMoment(input: AssignMomentInput): MomentAssignment {
  const thresholds = input.thresholds ?? GRAPH_THRESHOLD_DEFAULTS
  const scored: ScoredCandidate[] = []
  for (const theme of input.themes) {
    if (theme.type === 'protected') continue
    if (theme.vec.length === 0 || theme.vec.length !== input.momentVec.length) continue
    scored.push({ id: theme.id, sim: cosineSimilarity(input.momentVec, theme.vec), vec: theme.vec })
  }
  scored.sort((a, b) => (b.sim === a.sim ? a.id - b.id : b.sim - a.sim))

  const top1 = scored[0] ?? null
  const top2 = scored[1] ?? null
  const empty: MomentAssignment = {
    reason: 'new-theme',
    owner: null,
    secondaries: [],
    top1: top1 ? { id: top1.id, sim: top1.sim } : null,
    top2: top2 ? { id: top2.id, sim: top2.sim } : null,
    gap: top1 && top2 ? top1.sim - top2.sim : Number.POSITIVE_INFINITY,
    nearDuplicateTop: false
  }
  if (!top1 || top1.sim < thresholds.themeNewMinSim) return empty

  const nearDuplicateTop = top2
    ? cosineSimilarity(top1.vec, top2.vec) >= thresholds.themeDuplicateSim
    : false
  const gap = top2 ? top1.sim - top2.sim : Number.POSITIVE_INFINITY

  // 两个不同主题都像、又分不出高下 → 交给 LLM；近重复不算「分不出」
  if (!nearDuplicateTop && gap < thresholds.themeGapConfirm) {
    return { ...empty, reason: 'ambiguous', nearDuplicateTop, gap }
  }

  const owner: ScoredTheme = { id: top1.id, sim: top1.sim }
  const secondaries: ScoredTheme[] = []
  const max = Math.max(0, Math.floor(thresholds.themeSecondaryMax))
  for (const candidate of scored.slice(1)) {
    if (secondaries.length >= max) break
    if (candidate.sim < thresholds.themeMemberMinSim) break
    // 与 owner 近重复的主题不做次归属（§5.2 第 3 条）
    if (cosineSimilarity(top1.vec, candidate.vec) >= thresholds.themeDuplicateSim) continue
    secondaries.push({ id: candidate.id, sim: candidate.sim })
  }

  return {
    reason: 'assigned',
    owner,
    secondaries,
    top1: { id: top1.id, sim: top1.sim },
    top2: top2 ? { id: top2.id, sim: top2.sim } : null,
    gap,
    nearDuplicateTop
  }
}

/* ------------------------------------------------------------------ *
 * DB 层（只读；写 `theme_moments` 在 S6 接线时做）
 * ------------------------------------------------------------------ */

export interface StoredAssignmentOk {
  status: 'ok'
  assignment: MomentAssignment
}

export type StoredAssignment =
  | StoredAssignmentOk
  | { status: 'no-moment' | 'no-vectors' | 'no-themes' }

/** 参与归属的存活主题（排除已合并、排除 protected），质心已 L2 归一化 */
export function readAssignThemes(db: Db): AssignThemeCandidate[] {
  const rows = db
    .prepare(
      `SELECT c.node_id AS id, c.dim, c.vec, n.type
         FROM theme_centroids c JOIN nodes n ON n.id = c.node_id
        WHERE n.merged_into IS NULL AND IFNULL(n.type, '') <> 'protected'
        ORDER BY c.node_id ASC`
    )
    .all() as Array<{ id: number; dim: number; vec: Buffer; type: string | null }>
  const themes: AssignThemeCandidate[] = []
  for (const row of rows) {
    const vec = decodeVector(row.vec)
    if (vec.length !== row.dim || vec.length === 0) continue
    themes.push({ id: row.id, vec, type: row.type ?? undefined })
  }
  return themes
}

/** 单个时刻的质心（成员事件向量均值 + L2）；没有任何事件向量时返回 null */
export function momentVector(db: Db, momentId: number): Float32Array | null {
  const row = db.prepare('SELECT event_ids FROM moments WHERE id = ?').get(momentId) as
    | { event_ids: string | null }
    | undefined
  if (!row) return null
  let ids: unknown
  try {
    ids = JSON.parse(row.event_ids ?? '[]')
  } catch {
    return null
  }
  if (!Array.isArray(ids) || ids.length === 0) return null
  const placeholders = ids.map(() => '?').join(',')
  const vectors = db
    .prepare(`SELECT event_id, dim, vec FROM event_embeddings WHERE event_id IN (${placeholders})`)
    .all(...(ids as number[])) as Array<{ event_id: number; dim: number; vec: Buffer }>
  const list: Float32Array[] = []
  for (const vector of vectors) {
    const vec = decodeVector(vector.vec)
    if (vec.length === vector.dim && vec.length > 0) list.push(vec)
  }
  const mean = averageVectors(list)
  return mean ? normalizeVector(mean) : null
}

/**
 * 读一个时刻 + 现有主题，算归属建议（只读：不改 `theme_moments`）。
 * 返回 `no-moment`（没有这个时刻）/ `no-vectors`（成员事件还没算向量）/ `no-themes`（图还是空的）。
 */
export function assignStoredMoment(
  db: Db,
  momentId: number,
  thresholds: GraphThresholds = GRAPH_THRESHOLD_DEFAULTS
): StoredAssignment {
  const vec = momentVector(db, momentId)
  if (!vec) {
    const exists = db.prepare('SELECT 1 AS ok FROM moments WHERE id = ?').get(momentId)
    return { status: exists ? 'no-vectors' : 'no-moment' }
  }
  const themes = readAssignThemes(db)
  if (themes.length === 0) return { status: 'no-themes' }
  return { status: 'ok', assignment: assignMoment({ momentVec: vec, themes, thresholds }) }
}
