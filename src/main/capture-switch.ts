/**
 * 采集总开关的持久化与启动恢复（m1b-plan §3 Phase 2 / B5 / D13）
 *
 * 两键分工（§4.7，Q1=B）：
 * - `capture.enabled`：当前运行态（1 运行 / 0 暂停）；
 * - `capture.resume_on_start`：下次启动的显式授权（缺省 0）。
 * 显式开启 → 两键 1/1；显式暂停 → 0/0；`--capture` / `GOTCHA_CAPTURE=1` 不写任何键。
 *
 * 启动恢复：`resume_on_start=1` 时先显示暂停视觉 + 3s 倒计时角标，期间任意交互即取消
 * （两键置 0），超时才真正 `start()`；`start()` 失败仍保持暂停并提示。
 *
 * 本文件保持 Electron-free：单测直接跑倒计时与持久化，不依赖 app / BrowserWindow。
 */

import type { Db } from '../db'
import { getNumberSetting, setSetting } from '../db/settings'

export const SWITCH_ENABLED_KEY = 'capture.enabled'
export const SWITCH_RESUME_ON_START_KEY = 'capture.resume_on_start'

/** 重启后自动恢复前的提示窗口（D13 / Q1=B） */
export const STARTUP_RESUME_DELAY_MS = 3_000
/** 倒计时角标刷新间隔：每秒掉一个数字（3 → 2 → 1） */
export const STARTUP_RESUME_TICK_MS = 1_000

export interface SwitchSettings {
  /** 当前是否处于运行态 */
  enabled: boolean
  /** 是否授权下次启动自动恢复 */
  resumeOnStart: boolean
}

/** 读两键；db 为 null（无库，A3 空 userData）时一律视为暂停、无授权 */
export function readSwitchSettings(db: Db | null): SwitchSettings {
  if (!db) return { enabled: false, resumeOnStart: false }
  return {
    enabled: getNumberSetting(db, SWITCH_ENABLED_KEY, 0) === 1,
    resumeOnStart: getNumberSetting(db, SWITCH_RESUME_ON_START_KEY, 0) === 1
  }
}

/** 显式开启 / 暂停：两键同值写入（D13） */
export function persistSwitch(db: Db, running: boolean): void {
  const value = running ? '1' : '0'
  setSetting(db, SWITCH_ENABLED_KEY, value)
  setSetting(db, SWITCH_RESUME_ON_START_KEY, value)
}

export interface StartupResumeDeps {
  /** 默认 STARTUP_RESUME_DELAY_MS（测试可缩短） */
  delayMs?: number
  /** 默认 STARTUP_RESUME_TICK_MS */
  tickMs?: number
  now?(): number
  setInterval?(fn: () => void, ms: number): unknown
  clearInterval?(handle: unknown): void
  /** 每秒回报剩余秒数（3 → 2 → 1），供球上角标 */
  onTick?(secondsLeft: number): void
  /** 倒计时到点：调用方在这里 `await controller.start()` */
  onDue(): void
}

/**
 * 启动自动恢复倒计时（可取消）。
 *
 * `start()` 立即回报剩余秒数（3），随后每秒回落；到点调用一次 `onDue()`。
 * 任何交互调用 `cancel()`：返回是否真的取消了在途倒计时；取消后不再触发 onDue。
 * 到点后自动进入非活跃态，重复 `cancel()` 返回 false。
 */
export class StartupResumeCountdown {
  private timer: unknown = null
  private startedAt = 0
  private activeFlag = false
  private readonly delayMs: number
  private readonly tickMs: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: StartupResumeDeps) {
    this.delayMs = deps.delayMs ?? STARTUP_RESUME_DELAY_MS
    this.tickMs = deps.tickMs ?? STARTUP_RESUME_TICK_MS
    this.now = deps.now ?? (() => Date.now())
    this.setTimer =
      deps.setInterval ??
      ((fn: () => void, ms: number): unknown => setInterval(fn, ms) as unknown)
    this.clearTimer =
      deps.clearInterval ??
      ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>))
  }

  get active(): boolean {
    return this.activeFlag
  }

  /** 当前剩余秒数（向上取整；暂停时也给出完整窗口，供 UI 直接展示） */
  secondsLeft(): number {
    if (!this.activeFlag) return 0
    const remaining = this.delayMs - (this.now() - this.startedAt)
    return remaining <= 0 ? 0 : Math.ceil(remaining / 1000)
  }

  start(): void {
    if (this.activeFlag) return
    this.activeFlag = true
    this.startedAt = this.now()
    this.deps.onTick?.(this.secondsLeft())
    this.timer = this.setTimer(() => this.tick(), this.tickMs)
  }

  /** 返回是否取消了在途倒计时（已到点 / 未启动时返回 false） */
  cancel(): boolean {
    if (!this.activeFlag) return false
    this.activeFlag = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    return true
  }

  private tick(): void {
    if (!this.activeFlag) return
    const remaining = this.delayMs - (this.now() - this.startedAt)
    if (remaining <= 0) {
      this.activeFlag = false
      if (this.timer !== null) {
        this.clearTimer(this.timer)
        this.timer = null
      }
      this.deps.onDue()
      return
    }
    this.deps.onTick?.(Math.ceil(remaining / 1000))
  }
}
