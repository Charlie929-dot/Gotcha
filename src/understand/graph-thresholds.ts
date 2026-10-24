/**
 * 图谱相似度阈值（docs/m2-graph-redesign.md §5.2）
 *
 * - 全部走 `settings` 表（不建新表），键名见 `GRAPH_THRESHOLD_KEYS`；
 * - 读库失败 / 值越界 / 非数字时回退默认值（不静默接受脏值，也不因一个坏键让图谱不可用）；
 * - 默认值在**合并后的真实主题集**上标定（§5.1 / §17），换模型要重新标定。
 */

import type { Db } from '../db'
import { getSetting } from '../db/settings'

export interface GraphThresholds {
  /** 新时刻低于它则新建主题（P2 在线 assigner 用） */
  themeNewMinSim: number
  /** 次归属最低相似度（时刻质心 vs 主题质心） */
  themeMemberMinSim: number
  /** 与主主题达到它视为近重复，不做次归属 */
  themeDuplicateSim: number
  /** 自动合并阈值（主题质心 vs 主题质心） */
  themeMergeSim: number
  /** 每个时刻最多几条次归属 */
  themeSecondaryMax: number
  /** 主题间连线阈值 */
  edgeMinSim: number
  /** 每主题最多邻居数 */
  edgeTopK: number
  /** 是否要求互选 */
  edgeMutual: boolean
}

export const GRAPH_THRESHOLD_KEYS = {
  themeNewMinSim: 'graph.theme_new_min_sim',
  themeMemberMinSim: 'graph.theme_member_min_sim',
  themeDuplicateSim: 'graph.theme_duplicate_sim',
  themeMergeSim: 'graph.theme_merge_sim',
  themeSecondaryMax: 'graph.theme_secondary_max',
  edgeMinSim: 'graph.edge_min_sim',
  edgeTopK: 'graph.edge_top_k',
  edgeMutual: 'graph.edge_mutual'
} as const

/**
 * 初值 = §5.2 表格；`themeMemberMinSim` / `themeDuplicateSim` 已在 2026-10-24
 * 真实库质心口径上重新标定（见 §5.1 标定表与 §17 实测），不是 v0.2 的 node→node 数字：
 * 质心口径下 0.80 会让 95% 的时刻匹配到非主归属主题（与 v0.2 的「均值抹平」同病），
 * 0.92 + 近重复排除后只剩 78/823 个时刻有次归属、共 103 行。
 */
export const GRAPH_THRESHOLD_DEFAULTS: GraphThresholds = {
  themeNewMinSim: 0.78,
  themeMemberMinSim: 0.92,
  themeDuplicateSim: 0.92,
  themeMergeSim: 0.95,
  themeSecondaryMax: 2,
  edgeMinSim: 0.64,
  edgeTopK: 4,
  edgeMutual: true
}

/** 各阈值的合法区间（越界按默认值处理，不写回设置） */
const SIM_RANGE: Readonly<Record<keyof GraphThresholds, { min: number; max: number }>> = {
  themeNewMinSim: { min: 0, max: 1 },
  themeMemberMinSim: { min: 0, max: 1 },
  themeDuplicateSim: { min: 0, max: 1 },
  themeMergeSim: { min: 0, max: 1 },
  themeSecondaryMax: { min: 0, max: 10 },
  edgeMinSim: { min: 0, max: 1 },
  edgeTopK: { min: 0, max: 32 },
  edgeMutual: { min: 0, max: 1 }
}

/** 设置面板 / IPC 校验用的阈值元信息（区间 + 是否整数） */
export const GRAPH_THRESHOLD_LIMITS: Readonly<
  Record<keyof GraphThresholds, { min: number; max: number; integer: boolean }>
> = {
  themeNewMinSim: { ...SIM_RANGE.themeNewMinSim, integer: false },
  themeMemberMinSim: { ...SIM_RANGE.themeMemberMinSim, integer: false },
  themeDuplicateSim: { ...SIM_RANGE.themeDuplicateSim, integer: false },
  themeMergeSim: { ...SIM_RANGE.themeMergeSim, integer: false },
  themeSecondaryMax: { ...SIM_RANGE.themeSecondaryMax, integer: true },
  edgeMinSim: { ...SIM_RANGE.edgeMinSim, integer: false },
  edgeTopK: { ...SIM_RANGE.edgeTopK, integer: true },
  edgeMutual: { ...SIM_RANGE.edgeMutual, integer: true }
}

/**
 * 校验设置 patch 里的 `thresholds` 对象（未知键 / 越界 / 类型不符整单拒绝）。
 * `edgeMutual` 接受 boolean 或 0/1。
 */
export function parseThresholdPatch(
  input: unknown
): { ok: true; patch: Partial<GraphThresholds> } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'thresholds 必须是对象' }
  }
  const patch: Partial<GraphThresholds> = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in GRAPH_THRESHOLD_KEYS)) {
      return { ok: false, error: `未知阈值项：${key}` }
    }
    const name = key as keyof GraphThresholds
    const limits = GRAPH_THRESHOLD_LIMITS[name]
    if (name === 'edgeMutual') {
      if (typeof raw !== 'boolean' && raw !== 0 && raw !== 1) {
        return { ok: false, error: 'edgeMutual 必须是布尔值' }
      }
      patch.edgeMutual = raw === true || raw === 1
      continue
    }
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      raw < limits.min ||
      raw > limits.max ||
      (limits.integer && !Number.isInteger(raw))
    ) {
      return {
        ok: false,
        error: `${key} 必须是 ${limits.min}–${limits.max} 之间的${limits.integer ? '整数' : '数字'}`
      }
    }
    ;(patch as Record<string, number>)[name] = raw
  }
  return { ok: true, patch }
}

function readNumberSetting(db: Db | null, key: string, fallback: number, integer = false): number {
  if (!db) return fallback
  const raw = getSetting(db, key).trim()
  if (raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  if (integer && !Number.isInteger(value)) return fallback
  return value
}

function clamp(value: number, range: { min: number; max: number }): number {
  if (value < range.min || value > range.max) return Number.NaN
  return value
}

/**
 * 读阈值；单个键非法只影响它自己（回退默认），其余照常生效。
 * `db=null`（未建库 / 只读降级）返回默认值，不触发建库（A3）。
 */
export function readGraphThresholds(db: Db | null): GraphThresholds {
  const defaults = GRAPH_THRESHOLD_DEFAULTS
  if (!db) return { ...defaults }

  const read = (
    name: keyof GraphThresholds,
    fallback: number,
    integer = false
  ): number => {
    const value = readNumberSetting(db, GRAPH_THRESHOLD_KEYS[name], fallback, integer)
    const clamped = clamp(value, SIM_RANGE[name])
    return Number.isFinite(clamped) ? clamped : fallback
  }

  return {
    themeNewMinSim: read('themeNewMinSim', defaults.themeNewMinSim),
    themeMemberMinSim: read('themeMemberMinSim', defaults.themeMemberMinSim),
    themeDuplicateSim: read('themeDuplicateSim', defaults.themeDuplicateSim),
    themeMergeSim: read('themeMergeSim', defaults.themeMergeSim),
    themeSecondaryMax: Math.floor(read('themeSecondaryMax', defaults.themeSecondaryMax, true)),
    edgeMinSim: read('edgeMinSim', defaults.edgeMinSim),
    edgeTopK: Math.floor(read('edgeTopK', defaults.edgeTopK, true)),
    edgeMutual: read('edgeMutual', defaults.edgeMutual ? 1 : 0, true) !== 0
  }
}
