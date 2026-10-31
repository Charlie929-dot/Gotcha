/**
 * 记忆仓定时器（D90）：分钟钳制 / 0 = 关 / 重配不叠加 / 上一次没跑完就跳过
 */

import { describe, expect, it, vi } from 'vitest'

import {
  MEMORY_SCHEDULE_MAX_MINUTES,
  createMemoryScheduler,
  parseScheduleMinutes,
  scheduleIntervalMs
} from '../../src/main/memory-schedule'

/** 手动触发的假计时器：按注册顺序记下每个定时器，测试自己决定什么时候「到点」 */
function fakeTimers() {
  const created: { fn: () => void; ms: number }[] = []
  const cleared: unknown[] = []
  const timers = {
    setInterval: (fn: () => void, ms: number): unknown => {
      const handle = { fn, ms }
      created.push(handle)
      return handle
    },
    clearInterval: (handle: unknown): void => {
      cleared.push(handle)
    }
  }
  return { timers, created, cleared }
}

describe('定时间隔', () => {
  it('非数字回默认；0 与负数 = 关；越界钳到上限', () => {
    expect(parseScheduleMinutes('abc', 10)).toBe(10)
    expect(parseScheduleMinutes(undefined, 30)).toBe(30)
    expect(parseScheduleMinutes('', 30)).toBe(30)
    expect(parseScheduleMinutes(0, 10)).toBe(0)
    expect(parseScheduleMinutes(-5, 10)).toBe(0)
    expect(parseScheduleMinutes(0.9, 10)).toBe(0)
    expect(parseScheduleMinutes(5.7, 10)).toBe(5)
    expect(parseScheduleMinutes(99_999, 10)).toBe(MEMORY_SCHEDULE_MAX_MINUTES)
    expect(parseScheduleMinutes('7', 10)).toBe(7)
  })

  it('毫秒换算：0 = 关（null），否则分钟 × 60s', () => {
    expect(scheduleIntervalMs(0)).toBeNull()
    expect(scheduleIntervalMs(10)).toBe(600_000)
  })
})

describe('定时器', () => {
  it('两个间隔都开后各挂一个定时器，到点各跑一次', async () => {
    const { timers, created } = fakeTimers()
    const commit = vi.fn(async () => undefined)
    const push = vi.fn(async () => undefined)
    const scheduler = createMemoryScheduler({ timers, commit, push })

    scheduler.apply({ commitMinutes: 10, pushMinutes: 30 })
    expect(created.map((item) => item.ms)).toEqual([600_000, 1_800_000])

    created[0]!.fn()
    created[1]!.fn()
    await Promise.resolve()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('重配先清旧的，不叠加', () => {
    const { timers, created, cleared } = fakeTimers()
    const scheduler = createMemoryScheduler({ timers, commit: vi.fn(), push: vi.fn() })

    scheduler.apply({ commitMinutes: 10, pushMinutes: 30 })
    scheduler.apply({ commitMinutes: 5, pushMinutes: 0 })
    expect(cleared).toHaveLength(2)
    expect(created).toHaveLength(3)
    expect(created[2]!.ms).toBe(300_000)
  })

  it('0 = 关：不挂定时器', () => {
    const { timers, created } = fakeTimers()
    const scheduler = createMemoryScheduler({ timers, commit: vi.fn(), push: vi.fn() })
    scheduler.apply({ commitMinutes: 0, pushMinutes: 0 })
    expect(created).toHaveLength(0)
    expect(scheduler.current()).toEqual({ commitMinutes: 0, pushMinutes: 0 })
  })

  it('上一次没跑完就跳过这一次（慢网络不堆积）', async () => {
    const { timers, created } = fakeTimers()
    let release: () => void = () => undefined
    const commit = vi.fn(
      () =>
        new Promise<void>((done) => {
          release = done
        })
    )
    const scheduler = createMemoryScheduler({ timers, commit, push: vi.fn() })
    scheduler.apply({ commitMinutes: 1, pushMinutes: 0 })

    created[0]!.fn()
    created[0]!.fn()
    expect(commit).toHaveBeenCalledTimes(1)
    release()
    await Promise.resolve()
    await Promise.resolve()
    created[0]!.fn()
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('出错只记日志，不打断下一次', async () => {
    const { timers, created } = fakeTimers()
    const log = vi.fn()
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const scheduler = createMemoryScheduler({ timers, commit, push: vi.fn(), log })
    scheduler.apply({ commitMinutes: 1, pushMinutes: 0 })

    created[0]!.fn()
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toHaveBeenCalledWith('warn', 'memory schedule commit failed', expect.any(Object))

    created[0]!.fn()
    await Promise.resolve()
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('stop 之后不再留着定时器', () => {
    const { timers, created, cleared } = fakeTimers()
    const scheduler = createMemoryScheduler({ timers, commit: vi.fn(), push: vi.fn() })
    scheduler.apply({ commitMinutes: 10, pushMinutes: 30 })
    scheduler.stop()
    expect(cleared).toHaveLength(2)
    expect(created).toHaveLength(2)
  })
})
