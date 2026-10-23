/**
 * 归纳调度（M2 Phase 1；m2-plan §3 Phase 1「调度」/ D18）
 *
 * - 采集 running 后 5s 首次，之后每 `graph.interval_minutes`（默认 10）分钟一次；
 * - 同一时刻只允许一个作业在途；暂停 = 停定时器 + abort 在途 + 结果丢弃；
 * - 失败退避 `graph.retry_backoff_minutes`（默认 1,5,15，上限 30），成功复位；
 * - 每日 token 超 `graph.budget_tokens_per_day`（默认 1M）停自动归纳；
 * - 未配置供应商（getClient 返回 null）时跳过、不抛到采集链路。
 *
 * 说明：Phase 1 只提供可注入时钟/客户端的调度核心；主进程接线（采集 running 联动、
 * 图谱窗口的「立即归纳」）在 Phase 2 与 IPC 一起接。
 */

import type { Db } from '../db'
import { getNumberSetting, getSetting } from '../db/settings'
import { readBatch, readCursor } from './cloud/batch'
import { LlmAbortError, LlmParseError, type LlmClient } from './cloud/llm-client'
import { buildCloudMomentPayload } from './cloud/redact'
import { persistInduction, readUsage } from './induction'
import { validateInduction, type InductionResult } from './structure/schema'

export type InductionStatus = 'idle' | 'running' | 'backoff' | 'error' | 'budget-exhausted' | 'stopped'

export type RunOutcome =
  | { status: 'ok'; nodes: number; edges: number; placeholders: number; consumed: number }
  | { status: 'empty' }
  | { status: 'skipped'; reason: 'auto-off' | 'in-flight' | 'not-configured' | 'budget' }
  | { status: 'aborted' }
  | { status: 'error'; error: Error }

export interface InductionState {
  status: InductionStatus
  lastError?: string
  nextRunAt?: number
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
}

export interface InductionService {
  start(): void
  stop(): void
  runOnce(options?: { manual?: boolean }): Promise<RunOutcome>
  getState(): InductionState
  isActive(): boolean
}

const DEFAULT_FIRST_DELAY_MS = 5_000
const DEFAULT_INTERVAL_MS = 10 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000

function parseBackoffMinutes(raw: string): number[] {
  const minutes = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  return minutes.length > 0 ? minutes : [1, 5, 15]
}

export function createInductionService(options: InductionServiceOptions): InductionService {
  const { db, getClient } = options
  const now = options.now ?? (() => Date.now())
  const intervalMs = (): number => {
    const minutes = getNumberSetting(db, 'graph.interval_minutes', 0)
    return minutes > 0 ? minutes * 60_000 : (options.intervalMs ?? DEFAULT_INTERVAL_MS)
  }
  const budgetTokens = (): number =>
    getNumberSetting(db, 'graph.budget_tokens_per_day', 1_000_000)
  const backoffMs = (attempt: number): number => {
    const minutes = parseBackoffMinutes(getSetting(db, 'graph.retry_backoff_minutes'))
    return Math.min(minutes[Math.min(attempt, minutes.length - 1)] * 60_000, MAX_BACKOFF_MS)
  }

  let state: InductionState = { status: 'idle' }
  let timer: ReturnType<typeof setTimeout> | null = null
  let activeController: AbortController | null = null
  let busy = false
  let stopped = true
  let backoffAttempt = 0

  const setState = (patch: Omit<Partial<InductionState>, 'status'> & { status?: InductionStatus }): void => {
    state = { ...state, ...patch }
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

  async function runOnce(runOptions: { manual?: boolean } = {}): Promise<RunOutcome> {
    if (busy) return { status: 'skipped', reason: 'in-flight' }
    busy = true
    const controller = new AbortController()
    activeController = controller
    setState({ status: 'running', lastError: undefined })

    try {
      if (!runOptions.manual && getSetting(db, 'graph.auto') !== '1') {
        setState({ status: 'idle' })
        return { status: 'skipped', reason: 'auto-off' }
      }

      const currentNow = now()
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

      const cursorBefore = readCursor(db)
      const batch = readBatch(db, currentNow)
      if (batch.moments.length === 0) {
        setState({ status: 'idle' })
        return { status: 'empty' }
      }

      const built = buildCloudMomentPayload(batch.moments)
      const allowedEventIds = new Set<number>(built.payload.events.flatMap((event) => event.eventIds))
      const lastConsumed = batch.consumed[batch.consumed.length - 1]
      const cursorAfter = lastConsumed ? { ts: lastConsumed.ts, id: lastConsumed.id } : cursorBefore

      let result: InductionResult = { nodes: [], edges: [] }
      let usageTotals: { calls: number; promptTokens: number; completionTokens: number } | undefined

      if (built.payload.events.length > 0) {
        let response = await client.completeJson(built.payload, { signal: controller.signal })
        let validation = validateInduction(response.json, allowedEventIds)
        let calls = 1
        if (!validation.ok) {
          // 首轮非法 → 用错误摘要做 1 次修复重试（错误文案不含事件原文）
          response = await client.completeJson(built.payload, {
            signal: controller.signal,
            repairHint: validation.errors.join('；')
          })
          calls = 2
          validation = validateInduction(response.json, allowedEventIds)
          if (!validation.ok) throw new LlmParseError('LLM 输出未通过校验')
        }
        result = validation.result
        usageTotals = {
          calls,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens
        }
      }

      // 暂停期间返回的结果一律丢弃（D18）：落库前再确认一次未取消
      if (controller.signal.aborted) throw new LlmAbortError()

      const stats = persistInduction(db, {
        result,
        moments: batch.moments,
        excludedEventIds: built.excludedIds,
        cursor: cursorAfter,
        usage: usageTotals,
        now: currentNow
      })
      setState({ status: 'idle' })
      return {
        status: 'ok',
        nodes: stats.nodesCreated,
        edges: stats.edgesInserted,
        placeholders: stats.placeholders,
        consumed: batch.consumed.length
      }
    } catch (error) {
      if (error instanceof LlmAbortError) {
        setState({ status: 'idle' })
        return { status: 'aborted' }
      }
      const normalized = error instanceof Error ? error : new Error(String(error))
      setState({ status: 'error', lastError: normalized.message })
      return { status: 'error', error: normalized }
    } finally {
      busy = false
      activeController = null
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return
    const outcome = await runOnce()
    if (stopped) return
    if (outcome.status === 'aborted') return
    if (outcome.status === 'error') {
      backoffAttempt = Math.min(backoffAttempt + 1, 10)
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
      backoffAttempt = 0
      schedule(options.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS)
    },
    stop(): void {
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
      return !stopped
    }
  }
}
