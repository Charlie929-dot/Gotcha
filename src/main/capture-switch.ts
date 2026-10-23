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
 * 暂停顺序（F01）：先写 0/0 再关闸——中途崩溃不会残留「已授权恢复」；但写库失败
 * **绝不阻断关闸**（用户按下暂停，采集就必须停），失败由 `pauseCapture` 回报给界面。
 *
 * 本文件保持 Electron-free：单测直接跑倒计时、持久化与暂停编排，不依赖 app / BrowserWindow。
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

/**
 * 显式开启 / 暂停：两键同值写入（D13）。
 *
 * 单事务写入：第二键失败时第一键回滚，避免出现「enabled=0 但 resume_on_start=1」
 * 这类半套状态；失败向上抛，由调用方决定是否仍执行停止（F01）。
 */
export function persistSwitch(db: Db, running: boolean): void {
  const value = running ? '1' : '0'
  db.transaction(() => {
    setSetting(db, SWITCH_ENABLED_KEY, value)
    setSetting(db, SWITCH_RESUME_ON_START_KEY, value)
  })()
}

/** 暂停编排的依赖（可注入，单测不碰 Electron / 真实库） */
export interface PauseDeps {
  /** 写 0/0；省略 = 本次不需要落盘（`--capture` / `GOTCHA_CAPTURE=1` 直开） */
  persist?: () => void
  /** 真正关闸（调用方接 `controller.stop()`） */
  stop: () => Promise<void>
}

export interface PauseResult {
  /** 两键已确认落 0/0（persist 省略时为 true） */
  saved: boolean
  /** 关闸正常完成 */
  stopped: boolean
  persistError?: unknown
  stopError?: unknown
}

/**
 * 暂停编排（F01，decisions D13）：
 *
 * 1. 先写 0/0（顺序反了会在退出 / 崩溃中途残留「已授权恢复」）；
 * 2. **无论写库成功与否都必须关闸**——隐私暂停不能依赖磁盘写入；
 * 3. 两个失败都回报给调用方做可见提示，本函数自身不抛错。
 */
export async function pauseCapture(deps: PauseDeps): Promise<PauseResult> {
  const result: PauseResult = { saved: true, stopped: true }
  if (deps.persist) {
    try {
      deps.persist()
    } catch (error) {
      result.saved = false
      result.persistError = error
    }
  }
  try {
    await deps.stop()
  } catch (error) {
    result.stopped = false
    result.stopError = error
  }
  return result
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
 * 到点只代表进入“正在启动”，在调用方明确 `complete()` 前仍保持可取消：真实屏幕流
 * 启动可能阻塞主进程，期间到达的点球 / Alt+P 不能被误判为“倒计时已结束”。
 * 任何交互调用 `cancel()`：返回是否取消了倒计时或在途启动；取消后不再触发 onDue。
 */
export class StartupResumeCountdown {
  private timer: unknown = null
  private startedAt = 0
  private activeFlag = false
  private dueFlag = false
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
    this.dueFlag = false
    this.startedAt = this.now()
    this.deps.onTick?.(this.secondsLeft())
    this.timer = this.setTimer(() => this.tick(), this.tickMs)
  }

  /** 到点启动完成（成功或失败）后由调用方收口；之后 cancel 返回 false。 */
  complete(): void {
    this.activeFlag = false
    this.dueFlag = false
    this.clearTickTimer()
  }

  /** 返回是否取消了倒计时或到点后的在途启动（未启动 / 已完成时返回 false） */
  cancel(): boolean {
    if (!this.activeFlag) return false
    this.activeFlag = false
    this.dueFlag = false
    this.clearTickTimer()
    return true
  }

  private clearTickTimer(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private tick(): void {
    if (!this.activeFlag || this.dueFlag) return
    const remaining = this.delayMs - (this.now() - this.startedAt)
    if (remaining <= 0) {
      this.dueFlag = true
      this.clearTickTimer()
      this.deps.onDue()
      return
    }
    this.deps.onTick?.(Math.ceil(remaining / 1000))
  }
}
