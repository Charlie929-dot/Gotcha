/**
 * 图谱 v3 回填的主进程接线（打开图谱窗口时跑一次，后台、可重入）
 *
 * - 结构回填（时刻 / 主归属）永远跑：几毫秒到几百毫秒，幂等；
 * - 模型就绪时再补主题向量并重建 embedding 边（`onlyMissing`，第二次几乎不耗时）；
 * - 模型缺失不报错：结构照常回填，向量留到用户装好模型后的下一次打开；
 * - 任何失败只记 code / 级别，不把主题正文或向量写日志；
 * - 同一进程 60s 内重复打开不重复跑（避免连点开图把 CPU 拉满）。
 */

import type { Db } from '../db'
import { backfillGraphStructures, type GraphBackfillReport } from '../understand/graph-backfill'
import { createLocalEmbedder, isModelReady } from '../understand/embedding/session'
import type { Embedder } from '../understand/embedding/types'
import type { ThemeEmbeddingResult } from '../understand/theme-embeddings'

export type BackfillLogLevel = 'info' | 'warn' | 'error'

export interface GraphBackfillRuntimeDeps {
  db: Db
  /** 模型目录（已按设置解析过） */
  modelDir: string
  log: (level: BackfillLogLevel, msg: string, data?: Record<string, unknown>) => void
  /** 用例注入假 embedder；缺省用真实 onnxruntime */
  createEmbedder?: (modelDir: string) => Promise<Embedder>
  now?: () => number
  /** 两次回填的最小间隔（默认 60s；用例传 0） */
  minIntervalMs?: number
}

export interface GraphBackfillRunResult {
  status: 'done' | 'skipped'
  /** 模型缺失 / 加载失败时为 null */
  embeddings: ThemeEmbeddingResult | null
  report: GraphBackfillReport | null
  /** 跳过的原因（status='skipped'） */
  reason?: 'throttled' | 'busy'
}

/** 进程内缓存：同一个模型目录只加载一次会话（Electron 主进程常驻） */
const embedderCache = new Map<string, Promise<Embedder>>()
let lastRunAt = 0
let running = false

/** 仅供用例清理状态 */
export function resetGraphBackfillRuntimeState(): void {
  embedderCache.clear()
  lastRunAt = 0
  running = false
}

function getEmbedder(modelDir: string, factory: (dir: string) => Promise<Embedder>): Promise<Embedder> {
  const cached = embedderCache.get(modelDir)
  if (cached) return cached
  const created = factory(modelDir).catch((error: unknown) => {
    // 失败不缓存，下次打开还能重试
    embedderCache.delete(modelDir)
    throw error
  })
  embedderCache.set(modelDir, created)
  return created
}

/** 打开图谱窗口时调用；失败已就地记录，不会向调用方抛错 */
export async function runGraphBackfill(deps: GraphBackfillRuntimeDeps): Promise<GraphBackfillRunResult> {
  const now = deps.now?.() ?? Date.now()
  const minInterval = deps.minIntervalMs ?? 60_000
  if (running) return { status: 'skipped', embeddings: null, report: null, reason: 'busy' }
  if (minInterval > 0 && now - lastRunAt < minInterval) {
    return { status: 'skipped', embeddings: null, report: null, reason: 'throttled' }
  }
  running = true
  lastRunAt = now
  try {
    if (!isModelReady(deps.modelDir) && !deps.createEmbedder) {
      deps.log('info', 'graph backfill: model missing, structure only', { modelDirExists: false })
      const report = await backfillGraphStructures(deps.db, { now })
      deps.log('info', 'graph backfill done (structure only)', {
        moments: report.moments.created,
        existingMoments: report.moments.existing,
        memberships: report.memberships.inserted
      })
      return { status: 'done', embeddings: null, report }
    }

    let embedder: Embedder | null = null
    try {
      const factory = deps.createEmbedder ?? ((dir: string) => createLocalEmbedder({ modelDir: dir }))
      embedder = await getEmbedder(deps.modelDir, factory)
    } catch (error) {
      deps.log('warn', 'graph backfill: embedder unavailable, structure only', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }

    const report = await backfillGraphStructures(deps.db, embedder ? { now, embedder } : { now })
    deps.log('info', 'graph backfill done', {
      moments: report.moments.created,
      memberships: report.memberships.inserted,
      embeddings: report.embeddings?.embedded ?? 0,
      edges: report.edges?.inserted ?? 0,
      embeddingsOk: report.embeddings?.ok ?? null
    })
    return { status: 'done', embeddings: report.embeddings, report }
  } catch (error) {
    deps.log('warn', 'graph backfill failed', {
      error: error instanceof Error ? error.name : 'unknown'
    })
    return { status: 'done', embeddings: null, report: null }
  } finally {
    running = false
  }
}
