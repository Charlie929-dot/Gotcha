/**
 * 在线归属运行时（M2 P2 · S6；docs/m2-graph-redesign.md §9.1）
 *
 * 采集跑起来之后，每 60s 把「新时刻」走一遍在线闭环：
 *
 *   新时刻（S1 落库）→ 本地事件向量 → `assignMoment()`（S2）
 *     ├─ assigned   → 写 `theme_moments`（owner / secondary）+ 重算主题质心
 *     ├─ new-theme  → 建主题（本地兜底标题 + 待命名标记）+ 命名入队（S4/S5）
 *     └─ ambiguous  → 候选 top1/top2 入确认队列（S4/S5）
 *   命名 / 确认结果回来 → 写回节点标题 / 类型 / 归属 → 标题向量与全局边增量刷新
 *
 * 与「补历史」（按日批量归纳）共存：
 * - 本运行时可用（开关打开 + 本地模型就绪）时，**自动**批量归纳让位（`shouldAutoRun`），
 *   新数据只走在线路径；手动「立即归纳」仍保留为补历史 / 调试入口；
 * - 两条路径互相跳过对方处理过的数据：本运行时跳过事件已进节点 `source_events` 的时刻，
 *   批量归纳跳过 `theme_moments` 已有归属的时刻（`cloud/batch.ts`）。
 *
 * 暂停 / 预算（D18 / D22 / D24）：
 * - 采集暂停 → 停定时器 + `queue.pause()`（abort 在途、零出网）；恢复后再按原顺序补；
 * - 撤销出网授权 → `pauseEgress()` 立刻 abort 在途，本地归属继续跑（D24 只管出网）；
 * - 没有客户端 / 超每日预算 → 队列把任务留住、零请求（`waitingClient`），每个 tick `wake()` 重试；
 * - 请求失败 / 输出非法 → 指数退避（`graph.retry_backoff_minutes`），退避期间只做本地归属。
 *
 * 本文件不写库（写库在 `understand/theme-online.ts`）、不直接碰 Electron；日志只带计数 / 错误名。
 */

import type { Db } from '../db'
import { getNumberSetting, getSetting } from '../db/settings'
import type { Embedder } from '../understand/embedding/types'
import type { LlmClient } from '../understand/cloud/llm-client'
import { readInducedEventIds } from '../understand/cloud/batch'
import { readUsage, recordUsage } from '../understand/induction'
import {
  buildEmbeddingEdges,
  readThemeVectors,
  writeEmbeddingEdges
} from '../understand/graph-edges'
import { readGraphThresholds, type GraphThresholds } from '../understand/graph-thresholds'
import { embedThemeVectors } from '../understand/theme-embeddings'
import { assignMoment, readAssignThemes } from '../understand/theme-assign'
import type { ConfirmMoment, ConfirmTheme } from '../understand/theme-confirm'
import { parseBackoffMinutes } from '../understand/service'
import {
  applyAssignmentDecision,
  applyNamingToNode,
  candidateThemeIds,
  createOnlineTheme,
  embedMomentEvents,
  ONLINE_MAX_MOMENTS_PER_TICK,
  ONLINE_MOMENT_LOOKBACK_DAYS,
  persistAssignment,
  readConfirmThemes,
  readMomentVectors,
  readRepresentativeMoments,
  refreshOnlineThemeCentroid,
  resolveThemeRoot,
  selectOnlineMoments,
  selectPendingNameThemes,
  toRedactableMoment
} from '../understand/theme-online'
import {
  createThemeQueue,
  type ConfirmAssignmentsFn,
  type NameThemeFn,
  type ThemeQueue,
  type ThemeQueueDeps
} from '../understand/theme-queue'
import type { ClientResolution } from './induction-runtime'

export const THEME_ONLINE_DEFAULTS = {
  /** 与 `moment-runtime` 的 60s tick 对齐：时刻刚落库，下一分钟就能归属 */
  intervalMs: 60_000,
  /** 回看窗口（天）：更早的交给「补历史」 */
  lookbackDays: ONLINE_MOMENT_LOOKBACK_DAYS,
  /** 一轮最多处理多少时刻（embedding 在主进程里跑，别一次太多） */
  maxMomentsPerTick: ONLINE_MAX_MOMENTS_PER_TICK,
  /** 确认后仍没定下来的时刻，隔多久再试（避免每 60s 对同一批白跑一次调用） */
  pendingRetryMs: 15 * 60_000,
  /** 退避上限（与批量归纳同口径） */
  maxBackoffMs: 30 * 60_000
} as const

export type ThemeOnlineLogLevel = 'info' | 'warn'

export interface ThemeOnlineRuntimeDeps {
  db: Db
  /** 主进程的供应商解析；`ok:false` = 缺 key / 未配置 */
  resolveClient: () => ClientResolution
  /** D24 确认门（每次出队现读） */
  readConsent: () => boolean
  /** 本地向量模型是否就绪（false = 只处理待命名，不归属） */
  readEmbeddingsReady: () => boolean
  /** 惰性加载本地向量会话；缺省 = 不加载（只做待命名 / 不归属） */
  loadEmbedder?: () => Promise<Embedder | null>
  /** 开关 `graph.online_themes`（缺省视为开） */
  readEnabled?: () => boolean
  /** 相似度阈值（缺省现读 settings） */
  readThresholds?: () => GraphThresholds
  now?: () => number
  intervalMs?: number
  lookbackDays?: number
  maxMomentsPerTick?: number
  pendingRetryMs?: number
  log?: (level: ThemeOnlineLogLevel, msg: string, data?: Record<string, unknown>) => void
  /** 有新主题 / 新归属 / 新命名时通知画布（缺省不发） */
  onGraphChanged?: (outcome: { nodes: number; edges: number; placeholders: number }) => void
  /** 用例注入点 */
  queue?: ThemeQueue
  name?: NameThemeFn
  confirm?: ConfirmAssignmentsFn
  maxPendingMoments?: number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export type OnlineTickReason =
  | 'disabled'
  | 'paused'
  | 'disposed'
  | 'busy'
  | 'error'
  | 'empty'

export interface OnlineTickResult {
  status: 'done' | 'skipped'
  reason?: OnlineTickReason
  /** 本轮选中的未归属时刻数 */
  moments: number
  /** 新算的事件向量数 */
  embedded: number
  /** 直接归属到已有主题的时刻数 */
  assigned: number
  /** 新建主题数 */
  created: number
  /** 进了模糊确认队列的时刻数 */
  ambiguous: number
  /** 成员事件还没有向量（模型算不出来 / 空文本）的时刻数 */
  missingVectors: number
  /** 因为事件已被节点覆盖而跳过的时刻数（批量归纳先到一步） */
  skippedCovered: number
  /** 因为还在等上一轮确认而跳过的时刻数 */
  skippedPending: number
  /** 入队 / 重排的命名任务数 */
  named: number
  /** 命名结果回写节点数 */
  namedApplied: number
  /** 确认结果落库的归属数 + 新建数（上一轮） */
  confirmed: number
  /** 重算质心的主题数 */
  centroids: number
  /** 重算标题向量的条数 */
  titles: number
  /** 重建的 embedding 边数 */
  edges: number
}

export interface ThemeOnlineRuntime {
  /** 采集 running：起定时器并立刻跑一轮 */
  start(): void
  /** 采集 paused / stopping：停定时器 + 零出网（在途 abort） */
  pause(): void
  /** 撤销 / 恢复出网授权（D24）：只管出网，本地归属照跑 */
  pauseEgress(): void
  resumeEgress(): void
  /** 客户端 / 设置变化后叫一下：重试等待中的任务 */
  wake(): void
  /** 设置保存后重新判断开关（关掉 = 立刻停出网） */
  reconfigure(): void
  /** 跑一轮（用例直接调；定时器也走这里） */
  runOnce(): Promise<OnlineTickResult>
  /** 等队列跑空并刷新派生数据（用例 / 优雅退出用） */
  drain(): Promise<void>
  getState(): {
    running: boolean
    paused: boolean
    failureStreak: number
    nextLlmAt: number
    dirtyThemes: number
    queue: ReturnType<ThemeQueue['getState']>
  }
  dispose(): void
}

function emptyTick(
  status: 'done' | 'skipped',
  reason?: OnlineTickReason
): OnlineTickResult {
  return {
    status,
    ...(reason ? { reason } : {}),
    moments: 0,
    embedded: 0,
    assigned: 0,
    created: 0,
    ambiguous: 0,
    missingVectors: 0,
    skippedCovered: 0,
    skippedPending: 0,
    named: 0,
    namedApplied: 0,
    confirmed: 0,
    centroids: 0,
    titles: 0,
    edges: 0
  }
}

export function createThemeOnlineRuntime(deps: ThemeOnlineRuntimeDeps): ThemeOnlineRuntime {
  const now = (): number => deps.now?.() ?? Date.now()
  const intervalMs = Math.max(5_000, deps.intervalMs ?? THEME_ONLINE_DEFAULTS.intervalMs)
  const lookbackMs =
    Math.max(1, deps.lookbackDays ?? THEME_ONLINE_DEFAULTS.lookbackDays) * 86_400_000
  const maxMoments = Math.max(
    1,
    deps.maxMomentsPerTick ?? THEME_ONLINE_DEFAULTS.maxMomentsPerTick
  )
  const pendingRetryMs = Math.max(
    0,
    deps.pendingRetryMs ?? THEME_ONLINE_DEFAULTS.pendingRetryMs
  )
  const log = deps.log
  const readEnabled = deps.readEnabled ?? ((): boolean => true)
  const readThresholds = deps.readThresholds ?? ((): GraphThresholds => readGraphThresholds(deps.db))

  let timer: ReturnType<typeof setInterval> | null = null
  let paused = false
  let disposed = false
  let running = false
  let embedderPromise: Promise<Embedder | null> | null = null

  /** 失败退避（与批量归纳同口径，但独立计数） */
  let failureStreak = 0
  let nextLlmAt = 0
  /** 等确认的时刻（本轮到过一次、模型没定下来的）：一段时间内不再选 */
  let pendingConfirm = new Set<number>()
  let pendingConfirmUntil = 0
  /** 需要重算质心 / 标题向量 / 边的主题 */
  const dirtyThemes = new Set<number>()
  /** 回调里已经发生的写库（下一次 tick 报告 / 通知画布） */
  let callbackNamed = 0
  let callbackConfirmed = 0

  const budgetTokens = (): number =>
    Math.max(1, getNumberSetting(deps.db, 'graph.budget_tokens_per_day', 1_000_000))
  const overBudget = (): boolean => {
    const usage = readUsage(deps.db, now())
    return usage.promptTokens + usage.completionTokens >= budgetTokens()
  }
  /** 队列每次出队都走这里：null = 现阶段不该出网（任务留住、零请求） */
  const gatedClient = (): LlmClient | null => {
    if (!readEnabled()) return null
    if (!deps.readConsent()) return null
    if (overBudget()) return null
    const resolved = deps.resolveClient()
    return resolved.ok ? resolved.client : null
  }

  const llmAllowed = (): boolean => now() >= nextLlmAt

  const noteFailure = (): void => {
    failureStreak = Math.min(failureStreak + 1, 1_000)
    const minutes = parseBackoffMinutes(getSetting(deps.db, 'graph.retry_backoff_minutes'))
    const index = Math.min(failureStreak - 1, minutes.length - 1)
    nextLlmAt =
      now() + Math.min(Math.max(1, minutes[index] ?? 1) * 60_000, THEME_ONLINE_DEFAULTS.maxBackoffMs)
  }
  const noteSuccess = (): void => {
    failureStreak = 0
    nextLlmAt = 0
  }

  const recordOutcomeUsage = (usage: { promptTokens: number; completionTokens: number } | undefined): void => {
    if (!usage) return
    try {
      recordUsage(deps.db, now(), {
        calls: 1,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens
      })
    } catch (error) {
      // 记账失败不影响归属；预算判断下一轮会偏乐观一次，可接受
      log?.('warn', 'theme online usage record failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  const handleNaming: NonNullable<ThemeQueueDeps['onNaming']> = (themeId, outcome) => {
    const status = applyNamingToNode(deps.db, themeId, outcome)
    recordOutcomeUsage(outcome.usage)
    if (outcome.source === 'llm') noteSuccess()
    else if (outcome.reason === 'llm-error' || outcome.reason === 'invalid-output') {
      noteFailure()
      // 退避期间不再发队列里剩下的任务：否则一轮里排的 50 条会继续打满
      queue.pause()
    }
    if (status === 'updated') {
      dirtyThemes.add(themeId)
      callbackNamed += 1
    }
  }

  const handleConfirm: NonNullable<ThemeQueueDeps['onConfirm']> = (outcome) => {
    recordOutcomeUsage(outcome.usage)
    if (outcome.failed) {
      if (outcome.reason === 'llm-error' || outcome.reason === 'invalid-output') {
        noteFailure()
        queue.pause()
      }
    } else {
      noteSuccess()
    }
    const touched = new Set<number>()
    for (const decision of outcome.decisions) {
      const applied = applyAssignmentDecision(deps.db, decision, { now: now() })
      if (applied.status === 'assigned') {
        for (const id of applied.themeIds) touched.add(id)
        callbackConfirmed += 1
      } else if (applied.status === 'created' && applied.createdThemeId !== undefined) {
        touched.add(applied.createdThemeId)
        callbackConfirmed += 1
      }
    }
    for (const id of touched) dirtyThemes.add(id)
    if (outcome.pendingMomentIds.length > 0) {
      pendingConfirm = new Set(outcome.pendingMomentIds)
      pendingConfirmUntil = now() + pendingRetryMs
    }
    if (outcome.errors.length > 0) {
      log?.('warn', 'theme online confirm issues', {
        failed: outcome.failed,
        reason: outcome.reason ?? null,
        errors: outcome.errors.length,
        pending: outcome.pendingMomentIds.length
      })
    }
  }

  const queue =
    deps.queue ??
    createThemeQueue({
      resolveClient: gatedClient,
      onNaming: handleNaming,
      onConfirm: handleConfirm,
      ...(deps.name ? { name: deps.name } : {}),
      ...(deps.confirm ? { confirm: deps.confirm } : {}),
      ...(deps.maxPendingMoments !== undefined
        ? { maxPendingMoments: deps.maxPendingMoments }
        : {}),
      ...(log ? { log } : {})
    })

  async function getEmbedder(): Promise<Embedder | null> {
    if (!deps.loadEmbedder) return null
    if (!deps.readEmbeddingsReady()) return null
    if (!embedderPromise) {
      embedderPromise = deps
        .loadEmbedder()
        .catch((error: unknown) => {
          log?.('warn', 'theme online embedder unavailable', {
            error: error instanceof Error ? error.name : 'unknown'
          })
          return null
        })
        .then((embedder) => {
          // 失败不要缓存：用户装好模型 / 修好路径后下一轮还能重试
          if (!embedder) embedderPromise = null
          return embedder
        })
    }
    return embedderPromise
  }

  /** 把 dirty 主题的质心 / 标题向量 / 全局边刷新一遍（只算变化行） */
  async function flushDirty(): Promise<{ centroids: number; titles: number; edges: number }> {
    if (dirtyThemes.size === 0) return { centroids: 0, titles: 0, edges: 0 }
    const embedder = await getEmbedder()
    if (!embedder) return { centroids: 0, titles: 0, edges: 0 }
    const current = now()
    let centroids = 0
    for (const themeId of dirtyThemes) {
      const root = resolveThemeRoot(deps.db, themeId)
      if (root === null) continue
      try {
        const centroid = refreshOnlineThemeCentroid(deps.db, root, {
          model: embedder.model,
          dim: embedder.dim,
          now: current
        })
        if (centroid) centroids += 1
      } catch (error) {
        log?.('warn', 'theme online centroid failed', {
          error: error instanceof Error ? error.name : 'unknown'
        })
      }
    }
    let titles = 0
    try {
      const embedded = await embedThemeVectors(deps.db, embedder, { now: current })
      titles = embedded.embedded
    } catch (error) {
      log?.('warn', 'theme online title embedding failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }
    let edges = 0
    try {
      const thresholds = readThresholds()
      const { vectors } = readThemeVectors(deps.db, { model: embedder.model })
      if (vectors.length > 0) {
        const built = buildEmbeddingEdges(vectors, {
          minSim: thresholds.edgeMinSim,
          topK: thresholds.edgeTopK,
          mutual: thresholds.edgeMutual
        })
        const written = writeEmbeddingEdges(deps.db, built, {
          model: embedder.model,
          threshold: thresholds.edgeMinSim,
          topK: thresholds.edgeTopK,
          mutual: thresholds.edgeMutual
        })
        edges = written.inserted
      }
    } catch (error) {
      log?.('warn', 'theme online edge rebuild failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }
    dirtyThemes.clear()
    return { centroids, titles, edges }
  }

  /** 待命名的主题重排（含上次进程留下的：兜底标题不能永远留在库上） */
  function enqueuePendingNames(): number {
    if (!llmAllowed()) return 0
    let named = 0
    for (const themeId of selectPendingNameThemes(deps.db, 50)) {
      const moments = readRepresentativeMoments(deps.db, themeId)
      if (moments.length === 0) continue
      const result = queue.enqueueNaming(
        themeId,
        moments.map((moment) => toRedactableMoment(moment))
      )
      if (result.status !== 'disposed' && result.status !== 'full') named += 1
    }
    return named
  }

  /** 本地归属：选未归属时刻 → 算向量 → 归属 / 建主题 / 排队确认 */
  async function processMoments(): Promise<{
    moments: number
    embedded: number
    assigned: number
    created: number
    ambiguous: number
    missingVectors: number
    skippedCovered: number
    skippedPending: number
    namesQueued: number
  }> {
    const current = now()
    const embedder = await getEmbedder()
    if (!embedder) {
      return {
        moments: 0,
        embedded: 0,
        assigned: 0,
        created: 0,
        ambiguous: 0,
        missingVectors: 0,
        skippedCovered: 0,
        skippedPending: 0,
        namesQueued: 0
      }
    }
    if (pendingConfirm.size > 0 && current >= pendingConfirmUntil) {
      pendingConfirm = new Set()
      pendingConfirmUntil = 0
    }
    const since = current - lookbackMs
    const covered = readInducedEventIds(deps.db, since, current)
    const selected = selectOnlineMoments(deps.db, {
      since,
      limit: maxMoments,
      coveredEventIds: covered,
      excludeMomentIds: pendingConfirm
    })
    if (selected.moments.length === 0) {
      return {
        moments: 0,
        embedded: 0,
        assigned: 0,
        created: 0,
        ambiguous: 0,
        missingVectors: 0,
        skippedCovered: selected.skippedCovered,
        skippedPending: selected.skippedPending,
        namesQueued: 0
      }
    }

    const embeddings = await embedMomentEvents(deps.db, embedder, selected.moments, {
      now: current
    })
    const vectors = readMomentVectors(
      deps.db,
      selected.moments.map((moment) => moment.id),
      embedder.model
    )
    const thresholds = readThresholds()
    const themes = readAssignThemes(deps.db)
    const liveThemes = new Map(themes.map((theme) => [theme.id, theme]))
    const candidates = (): typeof themes => [...liveThemes.values()]

    let assigned = 0
    let created = 0
    let missingVectors = 0
    let namesQueued = 0
    const confirmMoments: ConfirmMoment[] = []
    const confirmThemeIds = new Set<number>()

    for (const moment of selected.moments) {
      const vector = vectors.get(moment.id)
      if (!vector) {
        missingVectors += 1
        continue
      }
      const assignment = assignMoment({ momentVec: vector, themes: candidates(), thresholds })
      if (assignment.reason === 'assigned' && assignment.owner) {
        const persisted = persistAssignment(deps.db, moment.id, assignment, { now: current })
        for (const id of persisted.themeIds) {
          const centroid = refreshOnlineThemeCentroid(deps.db, id, {
            model: embedder.model,
            dim: embedder.dim,
            now: current
          })
          if (centroid) {
            liveThemes.set(centroid.nodeId, {
              id: centroid.nodeId,
              vec: centroid.vec
            })
          }
          dirtyThemes.add(id)
        }
        assigned += 1
        continue
      }
      if (assignment.reason === 'new-theme') {
        const createdTheme = createOnlineTheme(deps.db, { moment, now: current })
        const centroid = refreshOnlineThemeCentroid(deps.db, createdTheme.themeId, {
          model: embedder.model,
          dim: embedder.dim,
          now: current
        })
        if (centroid) {
          liveThemes.set(centroid.nodeId, { id: centroid.nodeId, vec: centroid.vec })
        }
        dirtyThemes.add(createdTheme.themeId)
        if (llmAllowed()) {
          const enqueued = queue.enqueueNaming(createdTheme.themeId, [toRedactableMoment(moment)])
          if (enqueued.status !== 'disposed' && enqueued.status !== 'full') namesQueued += 1
        }
        created += 1
        continue
      }
      const ids = candidateThemeIds(assignment)
      confirmMoments.push({
        momentId: moment.id,
        app: moment.app,
        title: moment.title,
        ocr: moment.ocr,
        candidateThemeIds: ids
      })
      for (const id of ids) confirmThemeIds.add(id)
    }

    if (confirmMoments.length > 0 && llmAllowed()) {
      const themesView: ConfirmTheme[] = readConfirmThemes(deps.db, [...confirmThemeIds])
      const allowed = new Set(themesView.map((theme) => theme.themeId))
      const usable = confirmMoments.filter((moment) =>
        moment.candidateThemeIds.some((id) => allowed.has(id))
      )
      if (usable.length > 0) queue.enqueueConfirm(usable, themesView)
    }

    return {
      moments: selected.moments.length,
      embedded: embeddings.embedded,
      assigned,
      created,
      ambiguous: confirmMoments.length,
      missingVectors,
      skippedCovered: selected.skippedCovered,
      skippedPending: selected.skippedPending,
      namesQueued
    }
  }

  async function runOnceInternal(): Promise<OnlineTickResult> {
    if (disposed) return emptyTick('skipped', 'disposed')
    if (running) return emptyTick('skipped', 'busy')
    if (paused) return emptyTick('skipped', 'paused')
    if (!readEnabled()) {
      queue.pause()
      return emptyTick('skipped', 'disabled')
    }
    running = true
    const namedApplied = callbackNamed
    const confirmed = callbackConfirmed
    callbackNamed = 0
    callbackConfirmed = 0
    try {
      // 退避结束：把因失败被钳住的队列放出来（出网仍由 gatedClient 把关）
      if (llmAllowed() && queue.getState().paused) queue.resume()
      const named = enqueuePendingNames()
      const local = await processMoments()
      const flush = await flushDirty()
      queue.wake()
      const { namesQueued, ...localCounts } = local
      const result: OnlineTickResult = {
        status: 'done',
        ...localCounts,
        named: named + namesQueued,
        namedApplied,
        confirmed,
        ...flush
      }
      const touched =
        result.created + result.assigned + result.namedApplied + result.confirmed + flush.titles + flush.edges
      if (touched + result.ambiguous > 0) {
        log?.('info', 'theme online tick', {
          moments: result.moments,
          embedded: result.embedded,
          assigned: result.assigned,
          created: result.created,
          ambiguous: result.ambiguous,
          missingVectors: result.missingVectors,
          skippedCovered: result.skippedCovered,
          named: result.named,
          namedApplied: result.namedApplied,
          confirmed: result.confirmed,
          centroids: result.centroids,
          titles: result.titles,
          edges: result.edges,
          failures: queue.getState().failures,
          waitingClient: queue.getState().waitingClient
        })
        deps.onGraphChanged?.({
          nodes: result.created + result.assigned + result.namedApplied + result.confirmed,
          edges: result.edges,
          placeholders: 0
        })
      }
      if (result.moments === 0 && result.named === 0 && flush.edges === 0) {
        result.status = 'skipped'
        result.reason = 'empty'
      }
      return result
    } catch (error) {
      log?.('warn', 'theme online tick failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
      return emptyTick('skipped', 'error')
    } finally {
      running = false
    }
  }

  function tick(): void {
    void runOnceInternal()
  }

  function schedule(): void {
    if (timer || disposed || paused) return
    const scheduleFn = deps.setInterval ?? setInterval
    timer = scheduleFn(tick, intervalMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function clearTimer(): void {
    if (!timer) return
    const unschedule = deps.clearInterval ?? clearInterval
    unschedule(timer)
    timer = null
  }

  return {
    start(): void {
      if (disposed) return
      paused = false
      // 退避期间不要把上一轮因失败被钳住的队列放出来（恢复采集 ≠ 恢复出网）
      if (llmAllowed()) queue.resume()
      schedule()
      if (!running) tick()
    },
    pause(): void {
      if (disposed) return
      paused = true
      clearTimer()
      queue.pause()
    },
    pauseEgress(): void {
      queue.pause()
    },
    resumeEgress(): void {
      // 采集还暂停着 / 还在退避期就别恢复出网（D18 / D22 都优先于「恢复授权」）
      if (paused || disposed || !llmAllowed()) return
      queue.resume()
      queue.wake()
    },
    wake(): void {
      if (disposed) return
      queue.wake()
      if (!paused) tick()
    },
    reconfigure(): void {
      if (disposed) return
      if (!readEnabled()) {
        queue.pause()
        return
      }
      queue.wake()
      if (!paused) tick()
    },
    runOnce: runOnceInternal,
    async drain(): Promise<void> {
      await queue.drain()
      await flushDirty()
    },
    getState() {
      return {
        running,
        paused,
        failureStreak,
        nextLlmAt,
        dirtyThemes: dirtyThemes.size,
        queue: queue.getState()
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      clearTimer()
      queue.dispose()
      dirtyThemes.clear()
    }
  }
}
