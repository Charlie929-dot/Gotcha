import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/db'
import {
  persistSwitch,
  readSwitchSettings,
  STARTUP_RESUME_DELAY_MS,
  StartupResumeCountdown,
  SWITCH_ENABLED_KEY,
  SWITCH_RESUME_ON_START_KEY
} from '../../src/main/capture-switch'

describe('两键持久化（D13）：capture.enabled / capture.resume_on_start', () => {
  it('无库（空 userData）一律暂停、无授权，且不建库', () => {
    expect(readSwitchSettings(null)).toEqual({ enabled: false, resumeOnStart: false })
  })

  it('空 settings 表缺省为 0/0（A3：首次启动暂停）', () => {
    const db = openDatabase(':memory:')
    try {
      expect(readSwitchSettings(db)).toEqual({ enabled: false, resumeOnStart: false })
    } finally {
      db.close()
    }
  })

  it('显式开启写 1/1，显式暂停写 0/0；读回一致', () => {
    const db = openDatabase(':memory:')
    try {
      persistSwitch(db, true)
      expect(readSwitchSettings(db)).toEqual({ enabled: true, resumeOnStart: true })
      expect(
        db.prepare('SELECT key, value FROM settings ORDER BY key').all()
      ).toEqual([
        { key: SWITCH_ENABLED_KEY, value: '1' },
        { key: SWITCH_RESUME_ON_START_KEY, value: '1' }
      ])

      persistSwitch(db, false)
      expect(readSwitchSettings(db)).toEqual({ enabled: false, resumeOnStart: false })
    } finally {
      db.close()
    }
  })

  it('只有 resume_on_start=1（enabled=0，异常/手改残留）仍视为授权恢复', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        SWITCH_RESUME_ON_START_KEY,
        '1'
      )
      expect(readSwitchSettings(db)).toEqual({ enabled: false, resumeOnStart: true })
    } finally {
      db.close()
    }
  })
})

describe('StartupResumeCountdown（启动 3s 自动恢复，Q1=B）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('默认 3s：立即报 3，随后 2 → 1 → 到点触发一次 onDue，自动结束', () => {
    vi.useFakeTimers()
    const ticks: number[] = []
    const due = vi.fn()
    const countdown = new StartupResumeCountdown({
      onTick: (seconds) => ticks.push(seconds),
      onDue: due
    })

    countdown.start()
    expect(countdown.active).toBe(true)
    expect(ticks).toEqual([3])
    expect(STARTUP_RESUME_DELAY_MS).toBe(3000)

    vi.advanceTimersByTime(1000)
    expect(ticks).toEqual([3, 2])
    vi.advanceTimersByTime(1000)
    expect(ticks).toEqual([3, 2, 1])
    vi.advanceTimersByTime(1000)
    expect(ticks).toEqual([3, 2, 1])
    expect(due).toHaveBeenCalledTimes(1)
    expect(countdown.active).toBe(false)

    // 到点后继续走时间：不得重复触发，cancel 返回 false
    vi.advanceTimersByTime(5000)
    expect(due).toHaveBeenCalledTimes(1)
    expect(countdown.cancel()).toBe(false)
  })

  it('取消：不再到点；重复取消返回 false；未启动时取消也返回 false', () => {
    vi.useFakeTimers()
    const due = vi.fn()
    const countdown = new StartupResumeCountdown({ onDue: due })

    expect(countdown.cancel()).toBe(false)

    countdown.start()
    vi.advanceTimersByTime(1000)
    expect(countdown.secondsLeft()).toBe(2)
    expect(countdown.cancel()).toBe(true)
    expect(countdown.active).toBe(false)
    expect(countdown.secondsLeft()).toBe(0)

    vi.advanceTimersByTime(10_000)
    expect(due).not.toHaveBeenCalled()
    expect(countdown.cancel()).toBe(false)
  })

  it('重复 start 不会叠第二个计时器', () => {
    vi.useFakeTimers()
    const due = vi.fn()
    const ticks: number[] = []
    const countdown = new StartupResumeCountdown({
      onTick: (seconds) => ticks.push(seconds),
      onDue: due
    })

    countdown.start()
    countdown.start()
    vi.advanceTimersByTime(3000)

    expect(ticks).toEqual([3, 2, 1])
    expect(due).toHaveBeenCalledTimes(1)
  })

  it('自定义延迟（测试用短窗口）：秒数向上取整', () => {
    vi.useFakeTimers()
    const ticks: number[] = []
    const countdown = new StartupResumeCountdown({
      delayMs: 1500,
      tickMs: 500,
      onTick: (seconds) => ticks.push(seconds),
      onDue: () => {}
    })

    countdown.start()
    expect(ticks).toEqual([2])
    vi.advanceTimersByTime(500)
    expect(ticks).toEqual([2, 1])
    vi.advanceTimersByTime(500)
    expect(ticks).toEqual([2, 1, 1])
    vi.advanceTimersByTime(500)
    expect(ticks).toEqual([2, 1, 1])
  })
})
