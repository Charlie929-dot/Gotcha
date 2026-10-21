/**
 * 采样调度（m1a-plan §3 Phase 2c）
 *
 * 2s tick，时钟注入（测试可用固定时钟 / 手动触发 timer）；
 * 上一次 tick 未结束则跳过本次，避免 OCR 慢时任务堆叠。
 */

export interface SchedulerOptions {
  intervalMs: number
  now(): number
  onTick(now: number): Promise<void> | void
  /** 测试注入：默认 setInterval */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** 测试注入：默认 clearInterval */
  clearTimer?: (handle: unknown) => void
}

export interface SchedulerHandle {
  stop(): void
}

export function startScheduler(options: SchedulerOptions): SchedulerHandle {
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown)
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))

  let running = false
  let stopped = false
  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      await options.onTick(options.now())
    } finally {
      running = false
    }
  }

  const handle = setTimer(() => {
    void tick()
  }, options.intervalMs)

  return {
    stop(): void {
      stopped = true
      clearTimer(handle)
    }
  }
}
