/**
 * 在线标签队列（M2 P2 · S5；docs/m2-graph-redesign.md §9.1 / §9.3）
 *
 * 在线路径里 LLM 只剩命名（`theme-naming.ts`）与模糊归属确认（`theme-confirm.ts`）。
 * 两条调用都短、都便宜，但都有两个不能让步的前提：**同一时刻不并发**（同一批时刻被
 * 两份不同响应写库会互相覆盖）、**暂停期间零出网**（D18）。本模块只做调度：
 *
 * - **串行**：任何时刻最多一个请求在途，按入队顺序执行；
 * - **合并**：同一个主题的命名任务只留最后一份代表时刻；同一个时刻不重复排队（排队中 +
 *   在途都算）；新的确认时刻并进还没发出的最后一批（≤20 条/批，§9.1），少一次请求就少一次出网；
 * - **暂停零出网**：`pause()` 立刻 abort 在途请求，结果**丢弃**、任务放回队首；
 *   暂停期间只入队不发，`resume()` 之后按原顺序补（不是从头再扫一遍库）；
 * - **没有客户端**（D24 门没确认 / 缺 key）：与「请求失败」区别对待——请求失败可以兜底，
 *   但**绝不能**因为暂时没有客户端就给主题取兜底标题：任务留在队首、零请求，
 *   等调用方 `wake()`；否则模型给的标题永远补不回来；
 * - **上限**：排队时刻数上限（默认 200，防暂停久了无界增长）。满了只收放得下的部分，
 *   其余如实返回 `dropped`，由调用方下一轮再试（不静默丢、也不无限重试同一条）。
 *
 * 本文件不写库、不建主题、不落归属（S6 接线在调用方做），也不记正文：
 * 日志与计数只有任务类型 / 条数 / 用量 / 错误名。
 */

import { LlmAbortError, type LlmClient, type LlmUsage } from './cloud/llm-client'
import type { RedactableMoment } from './cloud/redact'
import {
  CONFIRM_BATCH_MAX,
  confirmThemeAssignments,
  type ConfirmMoment,
  type ConfirmOutcome,
  type ConfirmTheme
} from './theme-confirm'
import { nameTheme, type ThemeNamingOutcome } from './theme-naming'

export const THEME_QUEUE_DEFAULTS = {
  /** 排队时刻上限（§9.1「队列上限」；按时刻数算，命名任务按代表时刻数算） */
  maxPendingMoments: 200
} as const

export type ThemeQueueLogLevel = 'info' | 'warn'

/** 命名调用（用例可注入假实现；缺省 `nameTheme`） */
export type NameThemeFn = (
  client: LlmClient,
  moments: readonly RedactableMoment[],
  options: { signal?: AbortSignal }
) => Promise<ThemeNamingOutcome>

/** 模糊确认调用（用例可注入假实现；缺省 `confirmThemeAssignments`） */
export type ConfirmAssignmentsFn = (
  client: LlmClient,
  moments: readonly ConfirmMoment[],
  themes: readonly ConfirmTheme[],
  options: { signal?: AbortSignal }
) => Promise<ConfirmOutcome>

export interface ThemeQueueDeps {
  /** 每次出队时现取：null = 未确认出网 / 缺 key（D24 门），任务留着、零请求 */
  resolveClient: () => LlmClient | null
  /** 命名结果（含本地兜底）；`themeId` 是调用方给的键，队列原样回传 */
  onNaming?: (themeId: number, outcome: ThemeNamingOutcome) => void
  /** 确认结果；`pendingMomentIds` 由调用方留到下一轮 */
  onConfirm?: (outcome: ConfirmOutcome) => void
  /** 用例注入点；缺省是真实的 `nameTheme` / `confirmThemeAssignments` */
  name?: NameThemeFn
  confirm?: ConfirmAssignmentsFn
  log?: (level: ThemeQueueLogLevel, msg: string, data?: Record<string, unknown>) => void
  /** 排队时刻上限（缺省 200） */
  maxPendingMoments?: number
}

export type EnqueueStatus = 'queued' | 'merged' | 'duplicate' | 'full' | 'disposed'

export interface EnqueueResult {
  status: EnqueueStatus
  /** 本次真正进队（或并进已有任务）的时刻数 */
  accepted: number
  /** 因为已经在队里 / 在途而被忽略的时刻数 */
  skipped: number
  /** 因为队列上限被拒的时刻数（调用方下一轮再试） */
  dropped: number
}

export interface ThemeQueueState {
  paused: boolean
  disposed: boolean
  /** true = 队首任务在等客户端（D24 门 / 缺 key），零请求 */
  waitingClient: boolean
  pendingJobs: number
  pendingMoments: number
  running: 'name' | 'confirm' | null
  /** 尝试过的请求数（含被暂停取消的那一次） */
  calls: number
  promptTokens: number
  completionTokens: number
  /** 因重复 / 已在途被忽略的时刻数 */
  skippedMoments: number
  /** 因上限被拒的时刻数 */
  droppedMoments: number
  mergedJobs: number
  /** 结果不可用（请求失败 / 输出非法）的次数；取消不算 */
  failures: number
  abortedCalls: number
}

export interface ThemeQueue {
  enqueueNaming(themeId: number, moments: readonly RedactableMoment[]): EnqueueResult
  enqueueConfirm(moments: readonly ConfirmMoment[], themes: readonly ConfirmTheme[]): EnqueueResult
  /** 暂停（D18）：abort 在途、结果丢弃，排队任务留住、零出网 */
  pause(): void
  /** 恢复：按原顺序继续补发 */
  resume(): void
  /** 客户端重新可用（确认出网 / 补了 key）时叫一下；暂停中不生效 */
  wake(): void
  /** 等到队列跑不动为止（空 / 暂停 / 等客户端 / 已销毁）；用例与优雅退出用 */
  drain(): Promise<void>
  getState(): ThemeQueueState
  dispose(): void
}

interface NamingJob {
  kind: 'name'
  themeId: number
  moments: RedactableMoment[]
}

interface ConfirmingJob {
  kind: 'confirm'
  moments: ConfirmMoment[]
  themes: ConfirmTheme[]
}

type QueueJob = NamingJob | ConfirmingJob

/** 候选主题按 id 去重（并批时两批可能给同一主题）；保留先出现的标题 / 摘要 */
function mergeThemes(themes: readonly ConfirmTheme[]): ConfirmTheme[] {
  const byId = new Map<number, ConfirmTheme>()
  for (const theme of themes) {
    if (byId.has(theme.themeId)) continue
    byId.set(theme.themeId, { themeId: theme.themeId, title: theme.title, summary: theme.summary })
  }
  return [...byId.values()]
}

export function createThemeQueue(deps: ThemeQueueDeps): ThemeQueue {
  const maxPending = Math.max(
    1,
    Math.floor(deps.maxPendingMoments ?? THEME_QUEUE_DEFAULTS.maxPendingMoments)
  )
  const nameFn: NameThemeFn = deps.name ?? nameTheme
  const confirmFn: ConfirmAssignmentsFn = deps.confirm ?? confirmThemeAssignments
  const log = deps.log

  const queue: QueueJob[] = []
  let running: QueueJob | null = null
  let controller: AbortController | null = null
  /** 当前在途任务（含 finally 收尾）；串行靠它挡住第二个任务 */
  let active: Promise<void> | null = null
  let paused = false
  let disposed = false
  let waitingClient = false

  let calls = 0
  let promptTokens = 0
  let completionTokens = 0
  let skippedMoments = 0
  let droppedMoments = 0
  let mergedJobs = 0
  let failures = 0
  let abortedCalls = 0

  /** 排队 + 在途的时刻数（上限按这个算，在途的还没落库，也算占用） */
  const pendingMoments = (): number => {
    let total = running ? running.moments.length : 0
    for (const job of queue) total += job.moments.length
    return total
  }

  const recordUsage = (usage: LlmUsage | undefined): void => {
    if (!usage) return
    promptTokens += usage.promptTokens
    completionTokens += usage.completionTokens
  }

  /** 回调抛错只记日志：一次写库失败不该把后面排队的任务一起打死 */
  const notify = (fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      log?.('warn', 'theme queue callback failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  /**
   * 跑一个任务。两条调用自己会兜住模型 / 网络 / 校验失败（返回兜底结果或 pending），
   * 所以这里只处理两种：**取消**（放回队首、恢复后重做）与**接线错误**（记一次、丢掉任务——
   * 原地重试只会无限循环）。
   */
  async function runJob(job: QueueJob, client: LlmClient, signal: AbortSignal): Promise<void> {
    calls += 1
    try {
      if (job.kind === 'name') {
        const outcome = await nameFn(client, job.moments, { signal })
        // 暂停时可能「请求成功但结果作废」（D18）：回调前再确认一次没被取消
        if (signal.aborted) throw new LlmAbortError()
        recordUsage(outcome.usage)
        if (outcome.source === 'fallback' && outcome.reason !== 'no-context') failures += 1
        notify(() => deps.onNaming?.(job.themeId, outcome))
        return
      }
      const outcome = await confirmFn(client, job.moments, job.themes, { signal })
      if (signal.aborted) throw new LlmAbortError()
      recordUsage(outcome.usage)
      if (outcome.failed) failures += 1
      notify(() => deps.onConfirm?.(outcome))
    } catch (error) {
      if (error instanceof LlmAbortError) {
        abortedCalls += 1
        // 结果丢弃、任务回到队首：resume 之后按原顺序重做，不跳过也不重复落库
        if (!disposed) queue.unshift(job)
        return
      }
      failures += 1
      log?.('warn', 'theme queue job failed', {
        kind: job.kind,
        error: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  /** 取下一个任务执行；暂停 / 销毁 / 没有客户端 / 队列空时什么都不做 */
  function start(): void {
    if (active || paused || disposed || queue.length === 0) return
    let client: LlmClient | null = null
    try {
      client = deps.resolveClient()
    } catch (error) {
      log?.('warn', 'theme queue resolve client failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }
    if (!client) {
      // D24 门 / 缺 key：留住任务、零请求（不能兜底——兜底标题一旦写库就补不回来）
      waitingClient = true
      return
    }
    waitingClient = false
    const job = queue.shift() as QueueJob
    const abort = new AbortController()
    running = job
    controller = abort
    active = runJob(job, client, abort.signal).finally(() => {
      active = null
      running = null
      controller = null
      start()
    })
  }

  function enqueueNaming(themeId: number, moments: readonly RedactableMoment[]): EnqueueResult {
    if (disposed) return { status: 'disposed', accepted: 0, skipped: 0, dropped: 0 }
    if (!Number.isInteger(themeId)) throw new TypeError('themeId 必须是整数')

    // 同一个主题还在排队：覆盖代表时刻（调用方每次传「当前」代表时刻，最后一份最准）
    const queued = queue.find(
      (job): job is NamingJob => job.kind === 'name' && job.themeId === themeId
    )
    if (queued) {
      queued.moments = [...moments]
      mergedJobs += 1
      return { status: 'merged', accepted: moments.length, skipped: 0, dropped: 0 }
    }
    // 同一个主题正在命名：这次在途的响应会覆盖主题标题，再排一次没有意义
    if (running?.kind === 'name' && running.themeId === themeId) {
      skippedMoments += moments.length
      return { status: 'duplicate', accepted: 0, skipped: moments.length, dropped: 0 }
    }
    if (pendingMoments() + moments.length > maxPending) {
      droppedMoments += moments.length
      return { status: 'full', accepted: 0, skipped: 0, dropped: moments.length }
    }

    queue.push({ kind: 'name', themeId, moments: [...moments] })
    start()
    return { status: 'queued', accepted: moments.length, skipped: 0, dropped: 0 }
  }

  function enqueueConfirm(
    moments: readonly ConfirmMoment[],
    themes: readonly ConfirmTheme[]
  ): EnqueueResult {
    if (disposed) return { status: 'disposed', accepted: 0, skipped: 0, dropped: 0 }

    // 已经在排队 / 在途确认的时刻不再排一次：同一个时刻被两份响应写库会互相覆盖
    const pendingIds = new Set<number>()
    for (const job of queue) {
      if (job.kind !== 'confirm') continue
      for (const moment of job.moments) pendingIds.add(moment.momentId)
    }
    if (running?.kind === 'confirm') {
      for (const moment of running.moments) pendingIds.add(moment.momentId)
    }

    const fresh: ConfirmMoment[] = []
    const seen = new Set<number>()
    let skipped = 0
    for (const moment of moments) {
      if (pendingIds.has(moment.momentId) || seen.has(moment.momentId)) {
        skipped += 1
        continue
      }
      seen.add(moment.momentId)
      fresh.push({ ...moment, candidateThemeIds: [...moment.candidateThemeIds] })
    }
    skippedMoments += skipped
    if (fresh.length === 0) {
      return { status: 'duplicate', accepted: 0, skipped, dropped: 0 }
    }

    const room = Math.max(0, maxPending - pendingMoments())
    const accepted = fresh.slice(0, room)
    const dropped = fresh.length - accepted.length
    droppedMoments += dropped
    if (accepted.length === 0) {
      return { status: 'full', accepted: 0, skipped, dropped }
    }

    const themeViews = mergeThemes(themes)
    let rest = accepted
    let status: EnqueueStatus = 'queued'
    // 并进还没发出的最后一批（≤20 条）：同一轮连续入队的模糊时刻合成一次请求
    const lastConfirm = [...queue]
      .reverse()
      .find((job): job is ConfirmingJob => job.kind === 'confirm')
    if (lastConfirm) {
      const capacity = CONFIRM_BATCH_MAX - lastConfirm.moments.length
      if (capacity > 0) {
        const take = rest.slice(0, capacity)
        lastConfirm.moments.push(...take)
        lastConfirm.themes = mergeThemes([...lastConfirm.themes, ...themeViews])
        rest = rest.slice(take.length)
        status = 'merged'
        mergedJobs += 1
      }
    }
    for (let index = 0; index < rest.length; index += CONFIRM_BATCH_MAX) {
      queue.push({
        kind: 'confirm',
        moments: rest.slice(index, index + CONFIRM_BATCH_MAX),
        themes: themeViews
      })
    }

    start()
    return { status, accepted: accepted.length, skipped, dropped }
  }

  async function drain(): Promise<void> {
    for (;;) {
      const current = active
      if (current) {
        await current.catch(() => undefined)
        continue
      }
      if (paused || disposed || waitingClient || queue.length === 0) return
      start()
      if (!active) return
    }
  }

  function getState(): ThemeQueueState {
    return {
      paused,
      disposed,
      waitingClient,
      pendingJobs: queue.length,
      pendingMoments: pendingMoments(),
      running: running?.kind ?? null,
      calls,
      promptTokens,
      completionTokens,
      skippedMoments,
      droppedMoments,
      mergedJobs,
      failures,
      abortedCalls
    }
  }

  return {
    enqueueNaming,
    enqueueConfirm,
    pause(): void {
      if (disposed) return
      paused = true
      // D18：在途请求立刻 abort；runJob 会把任务放回队首、丢弃结果
      controller?.abort()
    },
    resume(): void {
      if (disposed) return
      paused = false
      start()
    },
    wake(): void {
      if (disposed) return
      waitingClient = false
      if (!paused) start()
    },
    drain,
    getState,
    dispose(): void {
      if (disposed) return
      disposed = true
      controller?.abort()
      queue.length = 0
    }
  }
}
