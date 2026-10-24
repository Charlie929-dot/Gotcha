/**
 * 归纳调度（M2 Phase 1；m2-plan §3 Phase 1「调度」/ D18）
 *
 * - 采集 running 后 5s 首次，之后每 `graph.interval_minutes`（默认 10）分钟一次；
 * - 同一时刻只允许一个作业在途；暂停 = 停定时器 + abort 在途 + 结果丢弃；
 *   暂停期间 `runOnce()` 直接跳过（含「立即归纳」），保证零出网；
 * - 失败退避 `graph.retry_backoff_minutes`（默认 1,5,15，上限 30），成功复位；
 * - 每日 token 超 `graph.budget_tokens_per_day`（默认 1M）停自动归纳；
 * - 按本地日取批（D28）：自动只跑今天，手动只跑图谱当前查看日；节点 `source_events`
 *   已覆盖的事件跳过，重复点击幂等；旧游标只保留兼容，不再驱动归纳；
 * - 空 content / 非法 JSON 与校验失败都各走 1 次修复重试（错误摘要为固定文案）；
 * - 失败 / 取消也把已消耗的 token 记账，避免失败循环绕过预算；
 * - 未配置供应商（getClient 返回 null）时跳过、不抛到采集链路。
 *
 * 可观测性（2026-10-24 补）：
 * - 失败按类型分类写进 `lastFailure`（http 带状态码 / timeout / network / parse / config），
 *   文案只来自客户端的类型化错误，不含 prompt 与响应正文；UI 据此显示「为什么在退避」；
 * - 连续失败达 `graph.max_consecutive_failures`（默认 5）时停自动归纳（`halted`），
 *   不再无限 1/5/15 分钟循环；手动「立即归纳」成功一次即恢复；
 * - 每次跑完回调 `onRunFinished`（自动 / 手动都触发），供结构化日志与快照使用。
 *
 * 说明：Phase 1 只提供可注入时钟/客户端的调度核心；主进程接线（采集 running 联动、
 * 图谱窗口的「立即归纳」）在 Phase 2 与 IPC 一起接。
 */

import type { Db } from '../db'
import { getNumberSetting, getSetting } from '../db/settings'
import { nextLocalDayStart, readDayBatch, startOfLocalDay } from './cloud/batch'
import { LLM_DEFAULTS } from './cloud/constants'
import {
  LlmAbortError,
  LlmError,
  LlmHttpError,
  LlmNetworkError,
  LlmParseError,
  LlmTimeoutError,
  type LlmClient,
  type LlmJsonResult
} from './cloud/llm-client'
import { buildCloudMomentPayload } from './cloud/redact'
import { persistInduction, readUsage, recordUsage, type InductionUsage } from './induction'
import { validateInduction, type InductionResult, type InductionValidation } from './structure/schema'

export type InductionStatus =
  | 'idle'
  | 'running'
  | 'backoff'
  | 'error'
  | 'budget-exhausted'
  | 'stopped'

export type RunOutcome =
  | {
      status: 'ok'
      nodes: number
      edges: number
      placeholders: number
      consumed: number
      /** 本批已满，可能还有未归纳事件；手动入口据此继续拉取（自动不追） */
      more?: boolean
      /** 本次调用消耗（含修复重试）；日志 / 快照用，不含正文 */
      usage?: InductionUsage
    }
  | { status: 'empty' }
  | { status: 'skipped'; reason: 'auto-off' | 'in-flight' | 'not-configured' | 'budget' | 'paused' }
  | { status: 'aborted' }
  | { status: 'error'; error: Error }

/** 失败分类：UI 只需知道「哪一类」，不需要原始错误栈 */
export type InductionFailureCode = 'http' | 'timeout' | 'network' | 'parse' | 'config' | 'unknown'

export interface InductionFailure {
  code: InductionFailureCode
  /** `code='http'` 时的状态码（429 / 5xx / 400…） */
  status?: number
  /** 固定文案：来自客户端的类型化错误信息，不含 prompt / 响应正文 */
  message: string
  /** 失败发生时间 */
  at: number
  /** 连续失败次数（本次为第几次） */
  streak: number
}

export interface InductionState {
  status: InductionStatus
  lastError?: string
  /** 最近一次失败的分类信息（UI 显示「为什么在退避」） */
  lastFailure?: InductionFailure
  nextRunAt?: number
  /** 连续失败达上限后自动归纳已停（手动 runOnce 仍可跑，成功即恢复） */
  halted: boolean
  lastSuccessAt?: number
}

export interface InductionRunMeta {
  /** 是否手动触发（「立即归纳」/ 确认出网后的首批） */
  manual: boolean
}


export interface InductionServiceOptions {
  db: Db
  /** 返回 null = 未配置（缺 key / 未允许出网）：跳过，不报错 */
  getClient: () => LlmClient | null
  now?: () => number
  firstDelayMs?: number
  /** settings 读取失败时的兜底间隔（正常走 graph.interval_minutes） */
  intervalMs?: number
  onStateChange?: (state: InductionState) => void
  /** 每次跑完（自动 / 手动 / 跳过）回调；回调抛错不外抛，避免拖垮调度 */
  onRunFinished?: (outcome: RunOutcome, state: InductionState, meta: InductionRunMeta) => void
}

export interface InductionService {
  start(): void
  stop(): void
  runOnce(options?: { manual?: boolean; dayStart?: number }): Promise<RunOutcome>
  getState(): InductionState
  isActive(): boolean
}

const DEFAULT_FIRST_DELAY_MS = 5_000
const DEFAULT_INTERVAL_MS = 10 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
/** 连续失败达到这个次数就停自动归纳（settings `graph.max_consecutive_failures` 可改） */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5

/** 解析层失败的修复提示（固定文案，不含模型输出） */
const PARSE_REPAIR_ERROR = '上一次输出不是合法 json（可能为空 content 或截断），请只输出完整 json 并覆盖全部输入 id'

function parseBackoffMinutes(raw: string): number[] {
  const minutes = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  return minutes.length > 0 ? minutes : [1, 5, 15]
}

/**
 * 错误 → 失败分类（UI 显示「为什么在退避」用）。
 * 只取类型化信息：消息全部来自客户端的固定文案，不含 prompt / 响应正文 / 密钥。
 */
export function classifyFailure(error: Error, at: number, streak: number): InductionFailure {
  if (error instanceof LlmHttpError) {
    return { code: 'http', status: error.status, message: error.message, at, streak }
  }
  if (error instanceof LlmTimeoutError) return { code: 'timeout', message: error.message, at, streak }
  if (error instanceof LlmNetworkError) return { code: 'network', message: error.message, at, streak }
  if (error instanceof LlmParseError) return { code: 'parse', message: error.message, at, streak }
  if (error instanceof LlmError && error.code === 'config') {
    return { code: 'config', message: error.message, at, streak }
  }
  return { code: 'unknown', message: error.message, at, streak }
}


export function createInductionService(options: InductionServiceOptions): InductionService {
  const { db, getClient } = options
  const now = options.now ?? (() => Date.now())
  const intervalMs = (): number => {
    const minutes = getNumberSetting(db, 'graph.interval_minutes', 0)
    return minutes > 0 ? minutes * 60_000 : (options.intervalMs ?? DEFAULT_INTERVAL_MS)
  }
  const budgetTokens = (): number => getNumberSetting(db, 'graph.budget_tokens_per_day', 1_000_000)
  const maxMoments = (): number =>
    Math.max(1, getNumberSetting(db, 'graph.batch_max_moments', LLM_DEFAULTS.maxMoments))
  const maxTokens = (): number => Math.max(256, getNumberSetting(db, 'graph.max_tokens', LLM_DEFAULTS.maxTokens))
  const maxConsecutiveFailures = (): number =>
    Math.max(1, getNumberSetting(db, 'graph.max_consecutive_failures', DEFAULT_MAX_CONSECUTIVE_FAILURES))
  const backoffMs = (attempt: number): number => {
    const minutes = parseBackoffMinutes(getSetting(db, 'graph.retry_backoff_minutes'))
    return Math.min(minutes[Math.min(attempt, minutes.length - 1)] * 60_000, MAX_BACKOFF_MS)
  }

  let state: InductionState = { status: 'idle', halted: false }
  let timer: ReturnType<typeof setTimeout> | null = null
  let activeController: AbortController | null = null
  let busy = false
  /** true = 已暂停（stop 之后）；暂停期间任何跑批都跳过，保证零出网 */
  let paused = false
  let stopped = true
  let backoffAttempt = 0
  /** 连续失败次数；成功 / start 复位 */
  let failureStreak = 0
  /** 连续失败到上限后停自动（手动 runOnce 成功即恢复） */
  let halted = false

  const setState = (patch: Omit<Partial<InductionState>, 'status'> & { status?: InductionStatus }): void => {
    state = { ...state, ...patch, halted }
    if (patch.status) state.status = patch.status
    options.onStateChange?.({ ...state })
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const schedule = (delayMs: number): void => {
    clearTimer()
    if (stopped) return
    setState({ nextRunAt: now() + delayMs })
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, delayMs)
  }

  async function runOnceCore(runOptions: { manual?: boolean; dayStart?: number } = {}): Promise<RunOutcome> {
    if (busy) return { status: 'skipped', reason: 'in-flight' }
    if (paused) return { status: 'skipped', reason: 'paused' }
    busy = true
    const controller = new AbortController()
    activeController = controller
    setState({ status: 'running', lastError: undefined, lastFailure: undefined })
    let currentNow = now()
    let callsMade = 0
    const spent = { promptTokens: 0, completionTokens: 0 }

    try {
      if (!runOptions.manual && getSetting(db, 'graph.auto') !== '1') {
        setState({ status: 'idle' })
        return { status: 'skipped', reason: 'auto-off' }
      }

      currentNow = now()
      const usage = readUsage(db, currentNow)
      if (usage.promptTokens + usage.completionTokens >= budgetTokens()) {
        setState({ status: 'budget-exhausted' })
        return { status: 'skipped', reason: 'budget' }
      }

      const client = getClient()
      if (!client) {
        setState({ status: 'idle' })
        return { status: 'skipped', reason: 'not-configured' }
      }

      const targetDay = startOfLocalDay(runOptions.dayStart ?? currentNow)
      // 自动 / 手动都按本地日取批：自动默认今天；手动传图谱当前查看日（D28）。
      // 今天保留 5 分钟合并窗口；历史日取到当天 23:59:59.999。
      const dayEnd = Math.min(nextLocalDayStart(targetDay) - 1, currentNow - LLM_DEFAULTS.batchLagMs)
      if (dayEnd < targetDay) {
        setState({ status: 'idle' })
        return { status: 'empty' }
      }
      const batch = readDayBatch(db, targetDay, dayEnd, { maxMoments: maxMoments() })
      if (batch.moments.length === 0) {
        setState({ status: 'idle' })
        return { status: 'empty' }
      }

      const built = buildCloudMomentPayload(batch.moments)
      const allowedEventIds = new Set<number>(built.payload.events.flatMap((event) => event.eventIds))

      let result: InductionResult = { nodes: [], edges: [] }
      let usageTotals: InductionUsage | undefined

      if (built.payload.events.length > 0) {
        const call = async (repair?: { errors: readonly string[] }): Promise<LlmJsonResult> => {
          callsMade += 1
          try {
            const response = await client.completeJson(built.payload, {
              signal: controller.signal,
              maxTokens: maxTokens(),
              repair
            })
            spent.promptTokens += response.usage.promptTokens
            spent.completionTokens += response.usage.completionTokens
            return response
          } catch (error) {
            // 解析层失败（空 content / 非法 JSON）也可能已消耗 token：照实累计，失败循环才绕不过预算（F03）
            if (error instanceof LlmParseError && error.usage) {
              spent.promptTokens += error.usage.promptTokens
              spent.completionTokens += error.usage.completionTokens
            }
            throw error
          }
        }

        let validation: InductionValidation | undefined
        let firstCallFailed = false
        try {
          const first = await call()
          validation = validateInduction(first.json, allowedEventIds)
        } catch (error) {
          if (!(error instanceof LlmParseError)) throw error
          firstCallFailed = true
        }

        if (firstCallFailed) {
          // 空 content / 非法 JSON：同样给 1 次修复重试（m2-plan §4.2 / §6）
          const repaired = await call({ errors: [PARSE_REPAIR_ERROR] })
          validation = validateInduction(repaired.json, allowedEventIds)
          if (!validation.ok) throw new LlmParseError('LLM 输出未通过校验')
        } else if (validation && !validation.ok) {
          // 首轮结构非法 → 用错误摘要做 1 次修复重试（错误文案不含事件原文）
          const repaired = await call({ errors: validation.errors })
          validation = validateInduction(repaired.json, allowedEventIds)
          if (!validation.ok) throw new LlmParseError('LLM 输出未通过校验')
        }
        if (!validation) throw new LlmParseError('LLM 输出未通过校验')
        result = validation.result
        usageTotals = { calls: callsMade, promptTokens: spent.promptTokens, completionTokens: spent.completionTokens }
      }

      // 暂停期间返回的结果一律丢弃（D18）：落库前再确认一次未取消
      if (controller.signal.aborted) throw new LlmAbortError()

      const stats = persistInduction(db, {
        result,
        moments: batch.moments,
        excludedEventIds: built.excludedIds,
        usage: usageTotals,
        now: currentNow
      })
      failureStreak = 0
      const wasHalted = halted
      halted = false
      setState({ status: 'idle', lastSuccessAt: currentNow })
      // 连续失败停自动后，手动成功一次就恢复排程（否则要等采集重启才回到自动）
      if (wasHalted && !stopped) schedule(intervalMs())
      return {
        status: 'ok',
        nodes: stats.nodesCreated,
        edges: stats.edgesInserted,
        placeholders: stats.placeholders,
        consumed: batch.consumed.length,
        more: batch.moments.length >= maxMoments(),
        usage: usageTotals
      }
    } catch (error) {
      // 失败 / 取消也已经消耗了 token：照实记账，否则失败循环永远绕得过每日预算
      if (spent.promptTokens + spent.completionTokens > 0) {
        try {
          recordUsage(db, currentNow, {
            calls: callsMade,
            promptTokens: spent.promptTokens,
            completionTokens: spent.completionTokens
          })
        } catch {
          // 记账失败不影响主错误
        }
      }
      if (error instanceof LlmAbortError) {
        setState({ status: paused ? 'stopped' : 'idle' })
        return { status: 'aborted' }
      }
      const normalized = error instanceof Error ? error : new Error(String(error))
      failureStreak = Math.min(failureStreak + 1, 1_000)
      const failure = classifyFailure(normalized, now(), failureStreak)
      // 连续失败达上限：停自动（不再 1/5/15 分钟无限循环），手动「立即归纳」仍可跑
      if (failureStreak >= maxConsecutiveFailures()) halted = true
      setState({ status: 'error', lastError: normalized.message, lastFailure: failure })
      return { status: 'error', error: normalized }
    } finally {
      busy = false
      activeController = null
    }
  }

  /** 每次跑完都通知上层（自动 / 手动 / 跳过都算），用于结构化日志与快照 */
  async function runOnce(runOptions: { manual?: boolean; dayStart?: number } = {}): Promise<RunOutcome> {
    const outcome = await runOnceCore(runOptions)
    try {
      options.onRunFinished?.(outcome, { ...state }, { manual: runOptions.manual === true })
    } catch {
      // 回调失败不影响调度
    }
    return outcome
  }

  async function tick(): Promise<void> {
    if (stopped || halted) return
    const outcome = await runOnce()
    if (stopped) return
    if (outcome.status === 'aborted') return
    if (outcome.status === 'error') {
      backoffAttempt = Math.min(backoffAttempt + 1, 10)
      if (halted) {
        setState({ status: 'error', nextRunAt: undefined })
        return
      }
      setState({ status: 'backoff' })
      schedule(backoffMs(backoffAttempt - 1))
      return
    }
    backoffAttempt = 0
    schedule(intervalMs())
  }

  return {
    start(): void {
      if (!stopped) return
      stopped = false
      paused = false
      backoffAttempt = 0
      failureStreak = 0
      halted = false
      setState({ status: 'idle', lastFailure: undefined, lastError: undefined })
      schedule(options.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS)
    },
    stop(): void {
      paused = true
      stopped = true
      clearTimer()
      activeController?.abort()
      setState({ status: 'stopped', nextRunAt: undefined })
    },
    runOnce,
    getState(): InductionState {
      return { ...state }
    },
    isActive(): boolean {
      return !stopped && !paused
    }
  }
}
