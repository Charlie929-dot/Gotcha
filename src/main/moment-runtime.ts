/**
 * 时刻在线补跑（M2 P2 · S1，docs/m2-graph-redesign.md §9.1 第 1 步）
 *
 * 目标：采集在跑的时候把新事件**本地**补成时刻，不再等「打开图谱」那次回填。
 * 全程零出网、零模型依赖（只读 events / 写 moments），所以不受 D24 出网门约束。
 *
 * 为什么要有水位（watermark）：
 * - `groupMoments` 用「同 app+标题、相邻 ≤90s」合并，一批事件还在长个子的那 90 秒里，
 *   同一个组的 `event_ids` 会变；而 `backfillMomentsForDay` 的幂等键是
 *   `(day_key, start_ts, event_ids)` 全等，提前处理会插出「半成品时刻」并留下一堆重复。
 * - 双保险：① 只处理 `ts < now - watermarkMs`（默认 3 分钟）的事件；
 *   ② 再对每个窗口传 `settleMs = 90s`，让「结束时间贴到窗口末尾」的组留到下一轮
 *   （`backfillMomentsForDay` 的 `settleMs` 选项）。两条一起保证落库的组已经彻底收口：
 *   组结束后 90 秒内不会再长个子，而那时它早已被下一轮包含进来。
 * - 水位只在**一轮成功跑完**之后才推进：失败（库忙 / 磁盘满 / 被关掉）下一轮重试，不丢数据。
 *
 * 已知边界：采集迟到（事件在 `ts + watermark` 之后才落库）时，仍可能出现
 * 「同一组被拆成两个时刻」——这与打开图谱时的全量回填是同一性质的问题，今天已存在，
 * 本模块不引入新的清理逻辑（不做删除，避免误删已有 `theme_moments` 归属）。
 */

import type { Db } from '../db'
import { nextLocalDayStart, startOfLocalDay } from '../understand/cloud/batch'
import {
  backfillMomentsForDay,
  MOMENT_MERGE_GAP_MS,
  type MomentDayBackfillResult
} from '../understand/moments'

export type MomentLogLevel = 'info' | 'warn' | 'error'

export const MOMENT_RUNTIME_DEFAULTS = {
  /** 采集运行中每 60s 补一轮 */
  intervalMs: 60_000,
  /** 事件至少要静止 3 分钟才成时刻（> 90s 合并窗口 + 60s tick） */
  watermarkMs: 180_000,
  /** 启动时最多往回补 2 天；更早的交由打开图谱时的全量回填（`MOMENT_BACKFILL_MAX_DAYS`） */
  maxCatchUpDays: 2
} as const

export type MomentBackfillFn = (
  db: Db,
  dayStart: number,
  nextDayStart: number,
  options: { now: number; settleMs?: number }
) => MomentDayBackfillResult

export interface MomentRuntimeDeps {
  db: Db
  log: (level: MomentLogLevel, msg: string, data?: Record<string, unknown>) => void
  now?: () => number
  intervalMs?: number
  watermarkMs?: number
  maxCatchUpDays?: number
  /** 用例注入假实现；缺省是真实的 `backfillMomentsForDay` */
  backfill?: MomentBackfillFn
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export interface MomentRuntimeResult {
  status: 'done' | 'skipped'
  /** 本轮处理区间 `[from, to)`（毫秒时间戳） */
  from: number
  to: number
  days: number
  events: number
  created: number
  existing: number
  /** 还没收口、留到下一轮的组数 */
  deferred: number
  reason?: 'no-new-events' | 'busy' | 'error'
}

export interface MomentRuntime {
  start(): void
  stop(): void
  runOnce(): MomentRuntimeResult
  /** 当前水位（毫秒时间戳；还没跑过为 null）——供用例断言 */
  watermark(): number | null
}

export function createMomentRuntime(deps: MomentRuntimeDeps): MomentRuntime {
  const now = (): number => deps.now?.() ?? Date.now()
  const intervalMs = Math.max(1_000, deps.intervalMs ?? MOMENT_RUNTIME_DEFAULTS.intervalMs)
  const watermarkMs = Math.max(0, deps.watermarkMs ?? MOMENT_RUNTIME_DEFAULTS.watermarkMs)
  const maxCatchUpMs =
    Math.max(1, deps.maxCatchUpDays ?? MOMENT_RUNTIME_DEFAULTS.maxCatchUpDays) * 86_400_000
  const backfill = deps.backfill ?? backfillMomentsForDay
  const schedule = deps.setInterval ?? setInterval
  const unschedule = deps.clearInterval ?? clearInterval

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  /** 已经成功处理到的时间点（毫秒）；失败不动，下一轮从这里重试 */
  let processedUpTo: number | null = null
  /** 首次运行的起点（取库里最后一个时刻 / 最多往回 maxCatchUpDays 天） */
  let startFrom: number | null = null

  /**
   * 首次运行的水位：从库里最后一个时刻的结束时间接着走（重启后不重扫），
   * 但最多往回 `maxCatchUpDays` 天，避免长时间没开时一轮扫太多天。
   */
  function initialWatermark(current: number): number {
    const floor = current - maxCatchUpMs
    try {
      const row = deps.db.prepare('SELECT MAX(end_ts) AS maxEnd FROM moments').get() as
        | { maxEnd: number | null }
        | undefined
      const latest = typeof row?.maxEnd === 'number' ? row.maxEnd : null
      if (latest === null) return floor
      return Math.max(latest, floor)
    } catch (error) {
      deps.log('warn', 'moment runtime: read watermark failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
      return floor
    }
  }

  function skipped(from: number, to: number, reason: MomentRuntimeResult['reason']): MomentRuntimeResult {
    return {
      status: 'skipped',
      from,
      to,
      days: 0,
      events: 0,
      created: 0,
      existing: 0,
      deferred: 0,
      reason
    }
  }

  function runOnce(): MomentRuntimeResult {
    const current = now()
    const to = current - watermarkMs
    if (startFrom === null) startFrom = initialWatermark(current)

    const floor = to - maxCatchUpMs
    const from = Math.max(processedUpTo ?? startFrom, floor)
    if (from >= to) return skipped(from, to, 'no-new-events')
    if (running) return skipped(from, to, 'busy')

    running = true
    try {
      let dayStart = startOfLocalDay(from)
      let days = 0
      let events = 0
      let created = 0
      let existing = 0
      let deferred = 0
      while (dayStart < to) {
        const nextDayStart = nextLocalDayStart(dayStart)
        const end = Math.min(nextDayStart, to)
        // settleMs：结束时间贴到窗口末尾的组留到下一轮，避免半成品时刻（见文件头注释）
        const result = backfill(deps.db, dayStart, end, {
          now: current,
          settleMs: MOMENT_MERGE_GAP_MS
        })
        days += 1
        events += result.events
        created += result.created
        existing += result.existing
        deferred += result.deferred
        dayStart = nextDayStart
      }
      // 成功才推进水位；但留出 settleMs 的重叠：贴边未收口的组必须能被下一轮再看到，
      // 否则「推迟了一轮」会变成「永远丢掉」
      processedUpTo = to - MOMENT_MERGE_GAP_MS
      if (created > 0) {
        deps.log('info', 'moments created', { created, events, days, existing, deferred })
      }
      return { status: 'done', from, to, days, events, created, existing, deferred }
    } catch (error) {
      // 水位不动 → 下一轮重试；只记错误名，不记事件内容
      deps.log('warn', 'moment runtime failed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
      return skipped(from, to, 'error')
    } finally {
      running = false
    }
  }

  function tick(): void {
    // runOnce 自己兜住异常，这里再包一层只防「没人想到的同步抛错」把定时器打死
    try {
      runOnce()
    } catch (error) {
      deps.log('warn', 'moment runtime tick crashed', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  return {
    start(): void {
      if (timer) return
      tick()
      timer = schedule(tick, intervalMs)
      // 别让定时器拦住进程退出（Electron 主进程里也省得 before-quit 再等）
      ;(timer as unknown as { unref?: () => void }).unref?.()
    },
    stop(): void {
      if (!timer) return
      unschedule(timer)
      timer = null
    },
    runOnce,
    watermark(): number | null {
      return processedUpTo
    }
  }
}
