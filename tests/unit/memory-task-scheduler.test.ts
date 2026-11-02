/**
 * 任务调度器：睡到最近一条 / 没有活动任务不留定时器 / 单飞 / 过期先收 / 失败重试
 *
 * 这里全部用假钟 + 假计时器：真实实现是 `setTimeout(最近到点 - now)`，
 * 用例只关心「什么时候醒、醒几次、跑几条、结算成什么」，不关心墙钟。
 */

import { describe, expect, it, vi } from 'vitest'

import { MAX_SLEEP_MS, RETRY_MS, createTaskScheduler } from '../../src/memory/agent/scheduler'
import type { TaskOutcome, TaskRow } from '../../src/memory/agent/tasks'

function task(id: number, nextDueAt: number | null): TaskRow {
  return {
    id,
    instruction: `任务 ${id}`,
    next_due_at: nextDueAt,
    repeat: '',
    origin: 'agent',
    delivery: 'auto',
    valid_until: null,
    state: 'active',
    last_run_at: null,
    run_key: null,
    obsidian_state: '',
    obsidian_path: null,
    obsidian_note: null,
    created_at: 0,
    updated_at: 0
  }
}

interface HarnessOptions {
  tasks?: TaskRow[]
  now?: number
  nextDueAt?: number | null
  run?: (row: TaskRow) => TaskOutcome | undefined
}

/** 一整套假件：钟、计时器、队列、结算记录 */
function harness(options: HarnessOptions = {}) {
  let now = options.now ?? 1_000_000
  const timers: { fn: () => void; ms: number }[] = []
  const cleared: unknown[] = []
  const settled: { id: number; outcome: TaskOutcome }[] = []
  const ran: number[] = []
  const claimed = new Set<string>()
  const queue = [...(options.tasks ?? [])]
  const errors: unknown[] = []

  const scheduler = createTaskScheduler({
    now: () => now,
    nextDueAt: () =>
      options.nextDueAt !== undefined ? options.nextDueAt : (queue[0]?.next_due_at ?? null),
    dueTasks: (at) => queue.filter((row) => row.next_due_at !== null && row.next_due_at <= at),
    claim: (id) => {
      const row = queue.find((item) => item.id === id)
      if (row === undefined) return null
      const key = `${row.id}:${row.next_due_at}`
      if (claimed.has(key)) return null
      claimed.add(key)
      return row
    },
    run: async (row) => {
      ran.push(row.id)
      return options.run ? options.run(row) : undefined
    },
    settle: (id, outcome) => {
      settled.push({ id, outcome })
      const index = queue.findIndex((item) => item.id === id)
      if (index !== -1) queue.splice(index, 1)
    },
    setTimer: (fn, ms) => {
      const handle = { fn, ms }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      cleared.push(handle)
    },
    onError: (error) => errors.push(error)
  })

  return {
    scheduler,
    timers,
    cleared,
    settled,
    ran,
    errors,
    queue,
    /** 手工标记「这条 occurrence 已经跑过」（模拟上一次运行 / 别的轮次抢到了租约） */
    preclaim: (key: string) => claimed.add(key),
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
    /** 触发最近注册的那个定时器（模拟「睡到点了」） */
    fire: (index = timers.length - 1): void => {
      timers[index]?.fn()
    }
  }
}

describe('起床时机', () => {
  it('睡到最近一条 next_due_at（不是固定间隔）', () => {
    const h = harness({ nextDueAt: 1_000_000 + 90_000 })
    h.scheduler.start()
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0].ms).toBe(90_000)
    h.scheduler.stop()
  })

  it('没有活动任务：一个定时器都不留（也不轮询）', () => {
    const h = harness({ nextDueAt: null })
    h.scheduler.start()
    expect(h.timers).toHaveLength(0)
    expect(h.scheduler.active()).toBe(true)
    h.scheduler.stop()
  })

  it('已经过点：立刻醒（延迟 0），不等着下一次', () => {
    const h = harness({ nextDueAt: 999_000 })
    h.scheduler.start()
    expect(h.timers[0].ms).toBe(0)
    h.scheduler.stop()
  })

  it('单次睡眠有上限（系统休眠 / 时钟跳变后至少醒来重算）', () => {
    const h = harness({ nextDueAt: 1_000_000 + 30 * 24 * 60 * 60 * 1000 })
    h.scheduler.start()
    expect(h.timers[0].ms).toBe(MAX_SLEEP_MS)
    h.scheduler.stop()
  })

  it('重配不叠加：reschedule 前先把旧定时器清掉', () => {
    const h = harness({ nextDueAt: 1_000_000 + 60_000 })
    h.scheduler.start()
    const first = h.timers[0]
    h.advance(1_000)
    h.scheduler.reschedule()
    expect(h.cleared).toContain(first)
    expect(h.timers).toHaveLength(2)
    h.scheduler.stop()
  })

  it('stop 之后旧定时器回调不再跑（代号过期）', async () => {
    const tasks = [task(1, 1_000_000)]
    const h = harness({ tasks })
    h.scheduler.start()
    const timer = h.timers[0]
    h.scheduler.stop()
    timer.fn()
    await Promise.resolve()
    expect(h.ran).toHaveLength(0)
  })
})

describe('到点执行', () => {
  it('醒来把到点的都跑完，并逐条结算', async () => {
    const h = harness({
      tasks: [task(1, 1_000_000), task(2, 1_000_000)],
      now: 1_000_000
    })
    h.scheduler.start()
    await h.scheduler.pump()
    expect(h.ran).toEqual([1, 2])
    expect(h.settled.map((item) => item.id)).toEqual([1, 2])
    h.scheduler.stop()
  })

  it('同一条 occurrence 只跑一次（第二次 pump 什么都没跑）', async () => {
    const h = harness({ tasks: [task(1, 1_000_000)], now: 1_000_000 })
    h.scheduler.start()
    await h.scheduler.pump()
    await h.scheduler.pump()
    expect(h.ran).toEqual([1])
    h.scheduler.stop()
  })

  it('抢不到租约（已被别的轮次跑过）就跳过这一条，别的照跑', async () => {
    const h = harness({ tasks: [task(1, 1_000_000), task(2, 1_000_000)], now: 1_000_000 })
    h.preclaim('1:1000000')
    h.scheduler.start()
    await h.scheduler.pump()
    expect(h.ran).toEqual([2])
    // 队列里还剩 1：下一次 pump 仍然抢不到（租约还在），不会重复跑
    await h.scheduler.pump()
    expect(h.ran).toEqual([2])
    h.scheduler.stop()
  })

  it('单飞：跑着的时候再 pump 直接返回', async () => {
    const tasks = [task(1, 1_000_000)]
    const h = harness({ tasks, now: 1_000_000 })
    h.scheduler.start()
    const running = h.scheduler.pump()
    h.scheduler.pump() // 重入：应该直接返回（不 await，确认它不排队）
    await running
    await h.scheduler.pump()
    expect(h.ran).toEqual([1])
    expect(h.scheduler.busy()).toBe(false)
    h.scheduler.stop()
  })

  it('执行抛错：不丢任务，退避 RETRY_MS 后再试（不改到点锚点）', async () => {
    const h = harness({
      tasks: [task(1, 1_000_000)],
      now: 1_000_000,
      run: () => {
        throw new Error('模型抽风')
      }
    })
    h.scheduler.start()
    await h.scheduler.pump()
    expect(h.errors).toHaveLength(1)
    // 退避重试：给的是 retryIn，不再用 nextDueAt 把周期任务的钟点推走（2026-11-02 事故）
    expect(h.settled[0].outcome.retryIn).toBe(RETRY_MS)
    expect(h.settled[0].outcome.nextDueAt).toBeUndefined()
    h.scheduler.stop()
  })

  it('过期的先收掉（expire 在取下一次到点之前）', async () => {
    const expired: number[] = []
    const h = harness({ nextDueAt: 1_000_000 })
    const withExpire = createTaskScheduler({
      now: () => 1_000_000,
      nextDueAt: () => null,
      dueTasks: () => [],
      claim: () => null,
      run: () => undefined,
      settle: () => undefined,
      expire: () => expired.push(1),
      setTimer: () => null,
      clearTimer: () => undefined
    })
    withExpire.start()
    expect(expired.length).toBeGreaterThan(0)
    withExpire.stop()
    void h
  })
})
