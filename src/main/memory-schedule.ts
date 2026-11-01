/**
 * 记忆仓的定时器（D90）：定时 commit / 定时 push，间隔按分钟配，0 = 关。
 *
 * 只做计时，不认识 git：到点了就调注入进来的 `commit()` / `push()`，
 * 由组合根决定「先写家谱快照再提交」这些副作用。
 *
 * 三条纪律：
 * - 重配 = 先清旧定时器再挂新的（改间隔不会留下两份）；
 * - 上一次还没跑完就跳过这一次（网络慢的时候不排队堆积）；
 * - 出错只记日志，不打断下一次（定时任务不该因为一次失败就停摆）。
 */

/** 间隔下限（分钟）：1 分钟以内没有意义，只会把仓刷爆 */
export const MEMORY_SCHEDULE_MIN_MINUTES = 1
/** 间隔上限（分钟）：一天 */
export const MEMORY_SCHEDULE_MAX_MINUTES = 24 * 60

export const MEMORY_SCHEDULE_DEFAULTS = {
  commitMinutes: 10,
  pushMinutes: 30
} as const

export interface MemoryScheduleConfig {
  commitMinutes: number
  pushMinutes: number
}

/**
 * 把界面来的值钳成合法分钟数：非数字 → fallback；≤0 → 0（关）；
 * 其余钳在 [下限, 上限]。
 */
export function parseScheduleMinutes(raw: unknown, fallback: number): number {
  const value =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) return fallback
  const minutes = Math.trunc(value)
  if (minutes <= 0) return 0
  return Math.min(MEMORY_SCHEDULE_MAX_MINUTES, Math.max(MEMORY_SCHEDULE_MIN_MINUTES, minutes))
}

/** 分钟 → 毫秒；0（关）返回 null */
export function scheduleIntervalMs(minutes: number): number | null {
  const safe = parseScheduleMinutes(minutes, 0)
  return safe === 0 ? null : safe * 60_000
}

export interface MemoryScheduleTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

export type MemoryScheduleLog = (
  level: 'info' | 'warn',
  message: string,
  data?: Record<string, unknown>
) => void

export interface MemorySchedulerDeps {
  /** 定时 commit（调用方负责写快照、决定提交信息） */
  commit: () => Promise<void> | void
  /** 定时 push */
  push: () => Promise<void> | void
  log?: MemoryScheduleLog
  /** 注入计时器（单测用手动触发的假计时器；默认用全局 setInterval） */
  timers?: MemoryScheduleTimers
}

export type MemoryScheduleTask = 'commit' | 'push'

export interface MemoryScheduler {
  /** 按配置（重）挂定时器；先清旧的 */
  apply(config: MemoryScheduleConfig): void
  /** 全部停掉（退出 / 关这个功能时） */
  stop(): void
  /** 当前生效的配置（都经过钳制） */
  current(): MemoryScheduleConfig
}

const GLOBAL_TIMERS: MemoryScheduleTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

export function createMemoryScheduler(deps: MemorySchedulerDeps): MemoryScheduler {
  const timers = deps.timers ?? GLOBAL_TIMERS
  let commitTimer: unknown = null
  let pushTimer: unknown = null
  let config: MemoryScheduleConfig = { ...MEMORY_SCHEDULE_DEFAULTS }
  /** 上一次还没跑完就跳过（慢网络不堆积） */
  const running: Record<MemoryScheduleTask, boolean> = { commit: false, push: false }

  const tick = async (task: MemoryScheduleTask): Promise<void> => {
    if (running[task]) return
    running[task] = true
    try {
      if (task === 'commit') await deps.commit()
      else await deps.push()
    } catch (error) {
      deps.log?.('warn', `memory schedule ${task} failed`, { error: String(error) })
    } finally {
      running[task] = false
    }
  }

  const clear = (handle: unknown): null => {
    if (handle !== null) timers.clearInterval(handle)
    return null
  }

  return {
    apply(next) {
      config = {
        commitMinutes: parseScheduleMinutes(next.commitMinutes, MEMORY_SCHEDULE_DEFAULTS.commitMinutes),
        pushMinutes: parseScheduleMinutes(next.pushMinutes, MEMORY_SCHEDULE_DEFAULTS.pushMinutes)
      }
      commitTimer = clear(commitTimer)
      pushTimer = clear(pushTimer)
      const commitMs = scheduleIntervalMs(config.commitMinutes)
      const pushMs = scheduleIntervalMs(config.pushMinutes)
      if (commitMs !== null) commitTimer = timers.setInterval(() => void tick('commit'), commitMs)
      if (pushMs !== null) pushTimer = timers.setInterval(() => void tick('push'), pushMs)
    },
    stop() {
      commitTimer = clear(commitTimer)
      pushTimer = clear(pushTimer)
    },
    current: () => ({ ...config })
  }
}
