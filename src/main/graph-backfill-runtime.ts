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
import {
  backfillGraphStructures,
  backfillThemeGraph,
  type GraphBackfillReport,
  type ThemeGraphReport
} from '../understand/graph-backfill'
import { createLocalEmbedder, isModelReady } from '../understand/embedding/session'
import type { Embedder } from '../understand/embedding/types'
import type { ThemeEmbeddingResult } from '../understand/theme-embeddings'

export type BackfillLogLevel = 'info' | 'warn' | 'error'

/**
 * 本地向量模型的推理参数。
 *
 * **`batchSize` 必须保持 1**（2026-10-25 实测，本机 4 线程 / 256 token）：
 * `onnxruntime-node` 的 `session.run()` 在推理期间**独占主进程 JS 线程**（50ms 心跳在 1.2s 推理里
 * 0 次触发）。批 32 时单次调用卡 1.2–2.5s，1126 条待算事件 = 连续几十秒「打开图谱就卡死」；
 * 批 1 单次只卡 ~60ms，而吞吐不变（批 1 = 38.8ms/条，批 8 = 41.1ms/条，批 32 = 37ms/条——
 * 批内长度不同要补齐到最长，批大反而做了无用计算）。
 * 线程数保持 4：1 线程实测 80–125ms/条，明显更慢。
 */
export const BACKFILL_EMBEDDER_OPTIONS = {
  /** 事件文本长（OCR）：截 256 token */
  maxLength: 256,
  /** 一次推理几条：见上，1 = 最不卡 */
  batchSize: 1,
  intraOpNumThreads: 4
} as const

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
  /** 结构回填结果（兼容旧字段；完整报告见 `theme`） */
  report: GraphBackfillReport | null
  /** P0.5 全流程报告（事件向量 / 质心 / 合并 / 次归属） */
  theme: ThemeGraphReport | null
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

/**
 * 进程内共享的本地向量会话：图谱回填（打开图谱）与在线归属（采集时）共用同一份，
 * 同一模型目录只加载一次（`onnxruntime` 会话 ~0.5s + 90MB 模型，不能每个 tick 重建）。
 * 用例可注入 `createEmbedder`；真实路径用批 1 的推理参数（见上）。
 */
export async function loadSharedEmbedder(
  modelDir: string,
  options: {
    log?: (level: BackfillLogLevel, msg: string, data?: Record<string, unknown>) => void
    createEmbedder?: (dir: string) => Promise<Embedder>
  } = {}
): Promise<Embedder | null> {
  const factory =
    options.createEmbedder ??
    ((dir: string) =>
      createLocalEmbedder({
        modelDir: dir,
        ...BACKFILL_EMBEDDER_OPTIONS
      }))
  try {
    return await getEmbedder(modelDir, factory)
  } catch (error) {
    options.log?.('warn', 'shared embedder unavailable', {
      error: error instanceof Error ? error.name : 'unknown'
    })
    return null
  }
}

/** 打开图谱窗口时调用；失败已就地记录，不会向调用方抛错 */
export async function runGraphBackfill(deps: GraphBackfillRuntimeDeps): Promise<GraphBackfillRunResult> {
  const now = deps.now?.() ?? Date.now()
  const minInterval = deps.minIntervalMs ?? 60_000
  if (running) return { status: 'skipped', embeddings: null, report: null, theme: null, reason: 'busy' }
  if (minInterval > 0 && now - lastRunAt < minInterval) {
    return { status: 'skipped', embeddings: null, report: null, theme: null, reason: 'throttled' }
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
      return { status: 'done', embeddings: null, report, theme: null }
    }

    let embedder: Embedder | null = null
    try {
      const factory =
        deps.createEmbedder ??
        ((dir: string) =>
          createLocalEmbedder({
            modelDir: dir,
            ...BACKFILL_EMBEDDER_OPTIONS
          }))
      embedder = await getEmbedder(deps.modelDir, factory)
    } catch (error) {
      deps.log('warn', 'graph backfill: embedder unavailable, structure only', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }

    if (!embedder) {
      const report = await backfillGraphStructures(deps.db, { now })
      return { status: 'done', embeddings: null, report, theme: null }
    }

    const theme = await backfillThemeGraph(deps.db, { now, embedder })
    deps.log('info', 'graph backfill done', {
      moments: theme.structure.moments.created,
      memberships: theme.structure.memberships.inserted,
      embeddings: theme.structure.embeddings?.embedded ?? 0,
      eventVectors: theme.events?.embedded ?? 0,
      merges: theme.merges?.applied ?? 0,
      secondary: theme.secondary?.inserted ?? 0,
      edges: theme.structure.edges?.inserted ?? 0,
      embeddingsOk: theme.structure.embeddings?.ok ?? null,
      deferred: theme.deferred
    })
    return {
      status: 'done',
      embeddings: theme.structure.embeddings ?? null,
      report: theme.structure,
      theme
    }
  } catch (error) {
    deps.log('warn', 'graph backfill failed', {
      error: error instanceof Error ? error.name : 'unknown'
    })
    return { status: 'done', embeddings: null, report: null, theme: null }
  } finally {
    running = false
  }
}
