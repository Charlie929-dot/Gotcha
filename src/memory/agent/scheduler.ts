/**
 * 任务调度器（自调用方案 v0.2 §9）
 *
 * 只做「到点叫醒」，不替 ta 决定说什么：
 *
 * - **睡到最近一条** `next_due_at`：没有活动任务就干脆不留定时器，也不永久轮询；
 * - **单飞**：同一时刻只跑一条任务；跑到一半又来一个，等这一轮结束再取；
 * - **去重**：`claim` 用库里的 `run_key` 抢租约，重启后同一次 occurrence 不会再跑；
 * - **过期不补发**：每次醒来先收掉过期的（`expire`），避免过期任务永远排在队首空转；
 * - **失败不丢**：执行抛错就把它推到 1 分钟后重试，而不是当成已完成。
 *
 * 本模块不 import 数据库、不 import 模型：库读写与「真的执行」都由调用方注入，
 * 所以能用假钟、假定时器在单测里精确验证「什么时候醒、醒几次、跑几条」。
 */

import type { TaskOutcome, TaskRow } from './tasks'

/** 一次睡眠最长 6 小时：系统休眠 / 时钟跳变后至少会醒来重算一次 */
export const MAX_SLEEP_MS = 6 * 60 * 60 * 1000
/** 执行失败后的重试间隔（不丢任务，也不空转） */
export const RETRY_MS = 60 * 1000
/** 一次醒来最多处理多少条：防御「settle 没推进」造成的死循环 */
export const PUMP_LIMIT = 50

export interface TaskSchedulerDeps {
  /** 固定钟（测试注入）；主进程传 `() => Date.now()` */
  now: () => number
  /** 最近的到点时间；没有活动任务返回 null（= 不保留定时器） */
  nextDueAt: () => number | null
  /** 取出此刻该跑的任务（调用方已排除过期） */
  dueTasks: (now: number) => TaskRow[]
  /** 抢执行租约；返回 null = 这条不归本次跑（已被跑过 / 中途改了时间） */
  claim: (id: number, now: number) => TaskRow | null
  /** 真的执行；返回值交给 `settle` 结算 */
  run: (task: TaskRow) => Promise<TaskOutcome | undefined> | TaskOutcome | undefined
  /** 结算（推进重复 / 完成 / 延后） */
  settle: (id: number, outcome: TaskOutcome, now: number) => void
  /** 收掉过期任务（在取下一次到点之前） */
  expire?: (now: number) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  maxSleepMs?: number
  onError?: (error: unknown) => void
}

export interface TaskScheduler {
  /** 启动（幂等）：按当前库里的最近到点安排第一次叫醒 */
  start(): void
  /** 停止：清掉定时器，不再叫醒 */
  stop(): void
  /** 任务增删改之后重算叫醒（不改变启动 / 停止状态） */
  reschedule(): void
  /** 立刻打一轮（启动恢复 / 手动触发）；单飞，重入直接返回 */
  pump(): Promise<void>
  /** 是否正在跑任务 */
  busy(): boolean
  /** 是否已启动 */
  active(): boolean
}

export function createTaskScheduler(deps: TaskSchedulerDeps): TaskScheduler {
  const maxSleep = deps.maxSleepMs ?? MAX_SLEEP_MS
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms) as unknown)
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let started = false
  let handle: unknown = null
  let pending = false
  /** 每次重算 +1：旧定时器回调看到自己的代号过期就自觉退出 */
  let generation = 0

  function clearScheduled(): void {
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
  }

  function schedule(): void {
    clearScheduled()
    if (!started) return
    const now = deps.now()
    deps.expire?.(now)
    const next = deps.nextDueAt()
    if (next === null) return
    const delay = Math.max(0, Math.min(maxSleep, next - now))
    const mine = (generation += 1)
    handle = setTimer(() => {
      if (!started || mine !== generation) return
      handle = null
      void pump()
    }, delay)
  }

  async function pump(): Promise<void> {
    if (!started || pending) return
    pending = true
    try {
      /** 这一轮里已经试过的任务：抢不到租约的要跳过，不能一直卡在队首 */
      const attempted = new Set<number>()
      for (let step = 0; step < PUMP_LIMIT; step += 1) {
        if (!started) return
        const now = deps.now()
        deps.expire?.(now)
        const due = deps.dueTasks(now).filter((row) => !attempted.has(row.id))
        if (due.length === 0) return
        const task = due[0]
        attempted.add(task.id)
        const claimed = deps.claim(task.id, now)
        if (claimed === null) continue // 已被跑过 / 中途改时间：跳过这一条，取下一批
        let outcome: TaskOutcome = {}
        try {
          outcome = (await deps.run(claimed)) ?? {}
        } catch (error) {
          deps.onError?.(error)
          outcome = { nextDueAt: now + RETRY_MS }
        }
        deps.settle(claimed.id, outcome, deps.now())
      }
    } finally {
      pending = false
      schedule()
    }
  }

  return {
    start(): void {
      if (started) return
      started = true
      schedule()
    },
    stop(): void {
      started = false
      generation += 1
      clearScheduled()
    },
    reschedule(): void {
      schedule()
    },
    pump(): Promise<void> {
      return pump()
    },
    busy(): boolean {
      return pending
    },
    active(): boolean {
      return started
    }
  }
}
