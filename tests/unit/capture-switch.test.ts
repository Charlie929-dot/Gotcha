import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/db'
import {
  pauseCapture,
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

describe('persistSwitch · 两键单事务（F01）', () => {
  it('升级路径第二键写失败：第一键回滚，不出现半套状态', () => {
    const db = openDatabase(':memory:')
    try {
      persistSwitch(db, true)
      db.exec(
        `CREATE TRIGGER fail_resume_update BEFORE UPDATE ON settings
         WHEN NEW.key = '${SWITCH_RESUME_ON_START_KEY}'
         BEGIN SELECT RAISE(ABORT, 'injected io error'); END;`
      )

      expect(() => persistSwitch(db, false)).toThrow(/injected io error/)
      expect(readSwitchSettings(db)).toEqual({ enabled: true, resumeOnStart: true })
    } finally {
      db.close()
    }
  })

  it('首次写入（INSERT 路径）第二键失败：两键都不落库', () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(
        `CREATE TRIGGER fail_resume_insert BEFORE INSERT ON settings
         WHEN NEW.key = '${SWITCH_RESUME_ON_START_KEY}'
         BEGIN SELECT RAISE(ABORT, 'injected insert error'); END;`
      )

      expect(() => persistSwitch(db, true)).toThrow(/injected insert error/)
      expect(readSwitchSettings(db)).toEqual({ enabled: false, resumeOnStart: false })
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n
      ).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('pauseCapture · 写库失败不得阻断关闸（F01）', () => {
  it('persist 抛错仍调用 stop，错误回报给调用方', async () => {
    const order: string[] = []
    const persistError = new Error('SQLITE_BUSY')
    const result = await pauseCapture({
      persist: () => {
        order.push('persist')
        throw persistError
      },
      stop: async () => {
        order.push('stop')
      }
    })

    expect(order).toEqual(['persist', 'stop'])
    expect(result).toEqual({ saved: false, stopped: true, persistError })
  })

  it('persist 省略（--capture 直开）视为无需落盘，直接关闸', async () => {
    const stop = vi.fn(async () => {})
    const result = await pauseCapture({ stop })

    expect(result).toEqual({ saved: true, stopped: true })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stop 抛错：不向上抛，回报 stopped=false 供界面提示', async () => {
    const stopError = new Error('halt failed')
    const result = await pauseCapture({
      persist: () => {},
      stop: async () => {
        throw stopError
      }
    })

    expect(result).toEqual({ saved: true, stopped: false, stopError })
  })
})

describe('StartupResumeCountdown（启动 3s 自动恢复，Q1=B）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('默认 3s：立即报 3，随后 2 → 1；到点启动期间仍可取消，complete 后结束', () => {
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
    expect(countdown.active).toBe(true)
    expect(countdown.secondsLeft()).toBe(0)

    // 到点后的真实起流阶段仍可取消；不得重复触发 onDue
    vi.advanceTimersByTime(5000)
    expect(due).toHaveBeenCalledTimes(1)
    expect(countdown.cancel()).toBe(true)
    expect(countdown.active).toBe(false)
    expect(countdown.cancel()).toBe(false)
  })

  it('到点启动完成后 complete 收口，之后不再可取消', () => {
    vi.useFakeTimers()
    const due = vi.fn()
    const countdown = new StartupResumeCountdown({ onDue: due })

    countdown.start()
    vi.advanceTimersByTime(3000)
    expect(due).toHaveBeenCalledTimes(1)
    expect(countdown.active).toBe(true)

    countdown.complete()
    expect(countdown.active).toBe(false)
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
