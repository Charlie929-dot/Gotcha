/**
 * P0 性能/交互 harness 的合成数据（确定性种子，零真实用户数据）。
 *
 * 规模档位对应方案 §12：
 * - `base`：210 主题 + ~800 时刻（对齐 2026-10-24 只读快照）；
 * - `1k`：500 + 500；`2k`：1000 + 1000，用于性能对比。
 */

import { dayKey, dayStart } from './calendar'
import type { GlobalGraphInput, MomentSeed, ThemeEdgeSeed, ThemeSeed } from './foam-adapter'

export type DatasetSize = 'base' | '1k' | '2k'

export const DATASET_SIZES: DatasetSize[] = ['base', '1k', '2k']

export interface DatasetProfile {
  label: string
  themes: number
  moments: number
}

export const DATASET_PROFILES: Record<DatasetSize, DatasetProfile> = {
  base: { label: '210 主题 · ~800 时刻', themes: 210, moments: 800 },
  '1k': { label: '500 + 500（1k 节点）', themes: 500, moments: 500 },
  '2k': { label: '1000 + 1000（2k 节点）', themes: 1000, moments: 1000 }
}

const THEME_TITLES = [
  'GUI 修复',
  '时间线',
  '归纳管线',
  '设置抽屉',
  '采集窗口',
  'Foam 布局',
  '向量检索',
  'OCR 摘要',
  '热键注册',
  '安装包',
  '单元测试',
  'E2E 回归',
  '供应商设置',
  '图谱交互',
  '数据库迁移',
  '性能调优',
  '气泡动画',
  '隐私脱敏',
  '打包配置',
  '文档同步'
]

const MOMENT_TITLES = [
  '改 CSS 间距',
  '调 batch 上限',
  '写迁移脚本',
  '截图对比',
  '跑单测',
  '看日志',
  '改 preload',
  '读设计稿',
  '试新配色',
  '整理 PR',
  '排查慢查询',
  '改热键',
  '写文档',
  '改提示文案',
  '对需求'
]

const APPS = ['Code', 'Chrome', 'Explorer', 'Notion']
const TYPES = ['knowledge', 'knowledge', 'knowledge', 'activity', 'activity', 'protected']
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]
}

function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

export interface SyntheticDataset {
  size: DatasetSize
  input: GlobalGraphInput
  /** 生成耗时基准（毫秒），用于状态栏 */
  generatedAt: number
}

/**
 * 生成合成全局图：主题与时刻按「潜在簇」聚集，主题边按簇内/簇间给相似度，
 * 时刻 30% 带次归属（多归属场景）。
 */
export function buildSyntheticGraph(
  size: DatasetSize,
  now: number = Date.now(),
  seed = 20261024
): SyntheticDataset {
  const profile = DATASET_PROFILES[size]
  const random = mulberry32(seed + profile.themes * 131 + profile.moments)
  const today = dayStart(now)
  const daySpan = 60
  const clusterCount = Math.max(8, Math.round(Math.sqrt(profile.themes) / 2))

  const themes: ThemeSeed[] = []
  for (let i = 1; i <= profile.themes; i += 1) {
    // 越靠后的主题越新（近 60 天，向近期倾斜）。
    const ageDays = Math.floor(Math.pow(random(), 1.6) * daySpan)
    const startDay = today - ageDays * DAY_MS
    const tsStart = startDay + intBetween(random, 7, 23) * 60 * MINUTE_MS
    const durationHours = 1 + Math.floor(random() * 8)
    const cluster = i % clusterCount
    themes.push({
      id: i,
      type: pick(random, TYPES),
      title: `${pick(random, THEME_TITLES)} ${i}`,
      summary: `第 ${i} 个主题，簇 ${cluster}，合成数据。`,
      tsStart,
      tsEnd: tsStart + durationHours * 60 * MINUTE_MS,
      sourceCount: intBetween(random, 1, 40)
    })
  }

  const moments: MomentSeed[] = []
  for (let i = 1; i <= profile.moments; i += 1) {
    const theme = themes[Math.floor(random() * themes.length)]
    const shared = random() < 0.3
    const themeIds = [theme.id]
    if (shared && themes.length > 1) {
      let secondary = themes[Math.floor(random() * themes.length)].id
      if (secondary === theme.id) secondary = themes[(Math.floor(random() * themes.length) + 1) % themes.length].id
      if (secondary !== theme.id) themeIds.push(secondary)
    }
    // 时刻落在主题活跃区间附近：60% 在主题时间段内，其余落在 ±3 天。
    const base = random() < 0.6 ? theme.tsStart : theme.tsStart + intBetween(random, -3, 3) * DAY_MS
    const ts = dayStart(base) + intBetween(random, 8, 22) * 60 * MINUTE_MS + intBetween(random, 0, 59) * MINUTE_MS
    moments.push({
      id: i,
      ts,
      dayKey: dayKey(ts),
      app: pick(random, APPS),
      title: pick(random, MOMENT_TITLES),
      themeIds
    })
  }

  // 主题边：簇内相似度高、簇间低；每主题 top-4 + 互选 + ≥0.64（方案 §6.1）。
  const clusterOf = new Map<number, number>()
  themes.forEach((theme, index) => clusterOf.set(theme.id, index % clusterCount))
  const candidates: ThemeEdgeSeed[] = []
  for (let i = 0; i < themes.length; i += 1) {
    for (let j = i + 1; j < themes.length; j += 1) {
      const sameCluster = clusterOf.get(themes[i].id) === clusterOf.get(themes[j].id)
      const weight = sameCluster ? 0.78 + 0.2 * random() : 0.55 + 0.3 * random()
      if (weight >= 0.64) {
        candidates.push({ source: themes[i].id, target: themes[j].id, weight })
      }
    }
  }
  const topK = new Map<number, Set<number>>()
  const edges: ThemeEdgeSeed[] = []
  const seen = new Set<string>()
  const byTheme = new Map<number, ThemeEdgeSeed[]>()
  for (const edge of candidates) {
    for (const [self, other] of [
      [edge.source, edge.target],
      [edge.target, edge.source]
    ] as const) {
      if (!byTheme.has(self)) byTheme.set(self, [])
      byTheme.get(self)!.push({ source: self, target: other, weight: edge.weight })
    }
  }
  for (const [themeId, list] of byTheme) {
    list.sort((a, b) => b.weight - a.weight)
    const wanted = new Set(list.slice(0, 4).map(edge => edge.target))
    topK.set(themeId, wanted)
  }
  for (const edge of candidates) {
    const aWantsB = topK.get(edge.source)?.has(edge.target) ?? false
    const bWantsA = topK.get(edge.target)?.has(edge.source) ?? false
    if (!aWantsB || !bWantsA) continue
    const key = `${edge.source}|${edge.target}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push(edge)
  }

  return {
    size,
    input: { themes, moments, edges },
    generatedAt: Date.now()
  }
}
