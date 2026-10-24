/**
 * 次归属回填（docs/m2-graph-redesign.md §5.2 / §5.3）
 *
 * - 存量时刻的主归属不动（`source_events` → owner 就是事实），只补次归属；
 * - 相似度口径：时刻质心 vs 主题质心（成员事件均值，和合并判定同一口径）；
 *   不用 `title+summary` 向量：它是抽象概括，与原始 OCR 距离远（实测 top1 只有 20.6%）；
 * - 排除近重复：候选主题与**任一**主归属主题的主题间相似度 ≥ `duplicateSim` 时不加；
 * - 上限 `max`（默认 2）；`protected` 主题不参与；
 * - 幂等：只增不重复，删除范围内不再成立的次归属；永不碰 `owner` / `manual`。
 */

import type { Db } from '../db'
import { cosineSimilarity } from './graph-edges'

export interface SecondaryTheme {
  id: number
  type: string
  vec: Float32Array
}

export interface SecondaryMoment {
  id: number
  vec: Float32Array
}

export interface SecondaryPlan {
  momentId: number
  themeId: number
  sim: number
}

export interface SecondaryPlanOptions {
  /** 次归属最低相似度 */
  minSim: number
  /** 与主归属主题达到它视为近重复，不做次归属 */
  duplicateSim: number
  /** 每个时刻最多几条次归属 */
  max: number
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/**
 * 计算次归属计划（纯函数，确定性输出：按 momentId 升序、sim 降序、themeId 升序）。
 * 只处理有主归属的时刻；主题相似度用主题质心两两计算，结果缓存。
 */
export function planSecondaryMemberships(
  moments: readonly SecondaryMoment[],
  themes: readonly SecondaryTheme[],
  owners: ReadonlyMap<number, readonly number[]>,
  options: SecondaryPlanOptions
): SecondaryPlan[] {
  const max = Math.max(0, Math.floor(options.max))
  if (max === 0) return []
  const themeById = new Map<number, SecondaryTheme>()
  for (const theme of themes) themeById.set(theme.id, theme)

  const themeSim = new Map<string, number>()
  const simOfThemes = (a: number, b: number): number => {
    const key = pairKey(a, b)
    const cached = themeSim.get(key)
    if (cached !== undefined) return cached
    const themeA = themeById.get(a)
    const themeB = themeById.get(b)
    const sim = themeA && themeB ? cosineSimilarity(themeA.vec, themeB.vec) : 0
    themeSim.set(key, sim)
    return sim
  }

  const plans: SecondaryPlan[] = []
  const sortedMoments = [...moments].sort((a, b) => a.id - b.id)
  for (const moment of sortedMoments) {
    const ownerIds = owners.get(moment.id) ?? []
    const ownerThemes = ownerIds.filter((id) => themeById.has(id))
    if (ownerThemes.length === 0) continue

    const candidates: Array<{ id: number; sim: number }> = []
    for (const theme of themes) {
      if (theme.type === 'protected') continue
      if (ownerThemes.includes(theme.id)) continue
      const sim = cosineSimilarity(moment.vec, theme.vec)
      if (sim < options.minSim) continue
      candidates.push({ id: theme.id, sim })
    }
    candidates.sort((a, b) => (b.sim === a.sim ? a.id - b.id : b.sim - a.sim))

    let added = 0
    for (const candidate of candidates) {
      if (added >= max) break
      const nearDuplicate = ownerThemes.some(
        (ownerId) => simOfThemes(ownerId, candidate.id) >= options.duplicateSim
      )
      if (nearDuplicate) continue
      plans.push({ momentId: moment.id, themeId: candidate.id, sim: candidate.sim })
      added += 1
    }
  }

  plans.sort((a, b) =>
    a.momentId === b.momentId ? (b.sim === a.sim ? a.themeId - b.themeId : b.sim - a.sim) : a.momentId - b.momentId
  )
  return plans
}

export interface ApplySecondaryOptions {
  now?: number
}

export interface SecondaryBackfillResult {
  /** 计划条数 */
  planned: number
  /** 新插入的次归属行数 */
  inserted: number
  /** 删除的过时次归属行数 */
  removed: number
  /** 参与计算的时刻数（`scopeMomentIds`） */
  moments: number
}

/**
 * 落库次归属。
 * - `scopeMomentIds`：本次参与计算的时刻（有主归属的那些）；只在这些范围内做增删，
 *   避免误删手工归属或范围外数据；
 * - 无主归属却残留的次归属（历史脏数据）顺手清理；
 * - 只写 `source='secondary'`、权重 1.0（等权，避免共享时刻把主题拉偏）。
 */
export function applySecondaryMemberships(
  db: Db,
  plans: readonly SecondaryPlan[],
  scopeMomentIds: readonly number[],
  options: ApplySecondaryOptions = {}
): SecondaryBackfillResult {
  const now = options.now ?? Date.now()
  const scope = [...new Set(scopeMomentIds.filter((id) => Number.isInteger(id) && id > 0))]
  const plannedByMoment = new Map<number, Set<number>>()
  for (const plan of plans) {
    let set = plannedByMoment.get(plan.momentId)
    if (!set) {
      set = new Set<number>()
      plannedByMoment.set(plan.momentId, set)
    }
    set.add(plan.themeId)
  }

  const readSecondaries = db.prepare(
    "SELECT theme_id FROM theme_moments WHERE moment_id = ? AND source = 'secondary'"
  )
  const deleteMembership = db.prepare(
    'DELETE FROM theme_moments WHERE moment_id = ? AND theme_id = ? AND source = ?'
  )
  const insertMembership = db.prepare(
    `INSERT OR IGNORE INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (?, ?, 1.0, 'secondary', ?)`
  )

  let inserted = 0
  let removed = 0
  const run = db.transaction(() => {
    for (const momentId of scope) {
      const keep = plannedByMoment.get(momentId) ?? new Set<number>()
      const existing = readSecondaries.all(momentId) as Array<{ theme_id: number }>
      for (const row of existing) {
        if (keep.has(row.theme_id)) continue
        removed += deleteMembership.run(momentId, row.theme_id, 'secondary').changes
      }
    }
    for (const plan of plans) {
      if (!Number.isInteger(plan.momentId) || !Number.isInteger(plan.themeId)) continue
      inserted += insertMembership.run(plan.themeId, plan.momentId, now).changes
    }
    // 没有主归属却残留次归属 = 脏数据
    removed += db
      .prepare(
        `DELETE FROM theme_moments
         WHERE source = 'secondary'
           AND moment_id NOT IN (SELECT moment_id FROM theme_moments WHERE source IN ('owner', 'manual'))`
      )
      .run().changes
  })
  run()

  return { planned: plans.length, inserted, removed, moments: scope.length }
}
