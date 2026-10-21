import { describe, expect, it, vi } from 'vitest'
import { startScheduler } from '../../src/capture/scheduler'

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('startScheduler · 注入时钟与 pause 语义', () => {
  it('按注入时钟传 now，stop 后不再触发', async () => {
    let fire: (() => void) | null = null
    let cleared = false
    const onTick = vi.fn()
    const handle = startScheduler({
      intervalMs: 2000,
      now: () => 1_000,
      onTick,
      setTimer: (fn) => {
        fire = fn
        return 'timer'
      },
      clearTimer: () => {
        cleared = true
      }
    })

    fire!()
    await flushMicrotasks()
    expect(onTick).toHaveBeenCalledWith(1_000)

    handle.stop()
    expect(cleared).toBe(true)
    fire!()
    await flushMicrotasks()
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('上一次 tick 未完成时跳过本次（不堆叠）', async () => {
    let fire: (() => void) | null = null
    let resolveTick: (() => void) | null = null
    const onTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve
        })
    )
    startScheduler({
      intervalMs: 2000,
      now: () => 5,
      onTick,
      setTimer: (fn) => {
        fire = fn
        return 0
      },
      clearTimer: () => {}
    })

    fire!()
    await flushMicrotasks()
    fire!()
    await flushMicrotasks()
    expect(onTick).toHaveBeenCalledTimes(1)

    resolveTick!()
    await flushMicrotasks()
    fire!()
    await flushMicrotasks()
    expect(onTick).toHaveBeenCalledTimes(2)
  })
})
