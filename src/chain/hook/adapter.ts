/**
 * 信息链 · 原始事件 → 段机输入（适配层，纯逻辑、可测）
 *
 * 三件只有传输层知道的事，都在这里收口：
 * 1. **滚轮手势合并**：钩子按格吐 `wheel`，一次滑动能吐几十条。同一手势（间隔 ≤ `wheelGestureMs`）
 *    累加成一条，`ts` 取手势起点、`delta` 取总和（契约 §2.2：合并是传输层的活，段机不做）。
 * 2. **键盘活动**：`GetLastInputInfo` 只说「刚才有输入」。若某个窗口里 tick 前进了、但这段时间
 *    **一条鼠标事件都没收到**，那就是键盘——于是补一条 `activity`（不含内容），段机据此起打字停顿计时。
 *    反过来，鼠标输入一定伴随 click/wheel/move，所以「没有鼠标事件」这个判据是自洽的，不用猜阈值。
 * 3. **时钟推进**：段机判空闲、判打字停顿都要 `tick`。没有事件时也要按时喂，否则人走了它不知道。
 */
import type { ChainInput } from '../segmenter'
import type { DesktopEventSource, RawDesktopEvent } from './types'

export interface AdapterOptions {
  /** 同一手势内两条滚轮事件的最大间隔；超过就算新手势 */
  wheelGestureMs: number
  /** 心跳间隔：没有事件也按这个节奏喂 tick */
  tickIntervalMs: number
  now: () => number
}

export const DEFAULT_ADAPTER_OPTIONS: AdapterOptions = {
  wheelGestureMs: 500,
  tickIntervalMs: 1_000,
  now: () => Date.now()
}

interface PendingWheel {
  firstTs: number
  lastTs: number
  delta: number
  x: number
  y: number
}

export class DesktopEventAdapter {
  private readonly source: DesktopEventSource
  private readonly options: AdapterOptions
  private pendingWheel: PendingWheel | null = null
  private lastInputTick: number | null = null
  private lastTickAt: number | null = null
  /** 两次心跳之间有没有收到过鼠标事件（用来把键盘从「有输入」里分出来） */
  private sawMouse = false

  constructor(source: DesktopEventSource, options: Partial<AdapterOptions> = {}) {
    this.source = source
    this.options = { ...DEFAULT_ADAPTER_OPTIONS, ...options }
  }

  /** 一条原始事件 → 0..n 条段机输入（顺序即时间顺序） */
  handle(raw: RawDesktopEvent): ChainInput[] {
    switch (raw.type) {
      case 'foreground': {
        const inputs = this.flushWheel()
        this.sawMouse = true
        const focus: Extract<ChainInput, { kind: 'focus' }> = {
          kind: 'focus',
          ts: raw.ts,
          pid: raw.pid,
          hwnd: raw.hwnd,
          exe: raw.exe,
          title: raw.title,
          app: raw.app
        }
        // 窗口事实原样透传（v0.12）：源不报就不写这个键，段机才能分清「不知道」和「不可见」
        if (raw.visible !== undefined) focus.visible = raw.visible
        if (raw.minimized !== undefined) focus.minimized = raw.minimized
        if (raw.onScreenArea !== undefined) focus.onScreenArea = raw.onScreenArea
        if (raw.className !== undefined) focus.className = raw.className
        inputs.push(focus)
        return inputs
      }
      case 'click': {
        const inputs = this.flushWheel()
        this.sawMouse = true
        inputs.push({ kind: 'click', ts: raw.ts, button: raw.button, x: raw.x, y: raw.y })
        return inputs
      }
      case 'move':
        this.sawMouse = true
        return [{ kind: 'move', ts: raw.ts, x: raw.x, y: raw.y }]
      case 'wheel':
        return this.addWheel(raw)
    }
  }

  /**
   * 心跳：滚轮手势收尾 → 键盘活动 → 时钟推进。
   * 由 `runtime.ts` 定时调用；测试里直接调。
   */
  pulse(now: number = this.options.now()): ChainInput[] {
    const inputs: ChainInput[] = []

    // 手势停了就把它交出去（ts 仍是手势起点，位置不错位）
    const wheel = this.settleWheel(now)
    inputs.push(...wheel)

    const tick = this.source.lastInputTickMs()
    if (this.lastInputTick !== null && tick !== this.lastInputTick && !this.sawMouse) {
      // tick 前进了，但这段窗口里没有鼠标动作 → 是键盘
      inputs.push({ kind: 'activity', ts: now })
    }
    this.lastInputTick = tick
    this.sawMouse = false

    if (this.lastTickAt === null || now - this.lastTickAt >= this.options.tickIntervalMs) {
      inputs.push({ kind: 'tick', ts: now })
      this.lastTickAt = now
    }

    return inputs
  }

  /** 停采时把手里的手势交出去 */
  flush(): ChainInput[] {
    return this.flushWheel()
  }

  /* ---------------------------------------------------------------- */

  private addWheel(raw: Extract<RawDesktopEvent, { type: 'wheel' }>): ChainInput[] {
    this.sawMouse = true
    if (this.pendingWheel && raw.ts - this.pendingWheel.lastTs <= this.options.wheelGestureMs) {
      this.pendingWheel.delta += raw.delta
      this.pendingWheel.lastTs = raw.ts
      this.pendingWheel.x = raw.x
      this.pendingWheel.y = raw.y
      return []
    }
    const inputs = this.flushWheel()
    this.pendingWheel = { firstTs: raw.ts, lastTs: raw.ts, delta: raw.delta, x: raw.x, y: raw.y }
    return inputs
  }

  /** 强制交出挂起的滚轮（点击 / 切窗口 / 停采时，顺序不能反） */
  private flushWheel(): ChainInput[] {
    const pending = this.pendingWheel
    if (!pending) return []
    this.pendingWheel = null
    return [{ kind: 'wheel', ts: pending.firstTs, delta: pending.delta, x: pending.x, y: pending.y }]
  }

  /** 手势已经停了才交出（心跳用，避免把手势从中间切断） */
  private settleWheel(now: number): ChainInput[] {
    if (!this.pendingWheel) return []
    if (now - this.pendingWheel.lastTs <= this.options.wheelGestureMs) return []
    return this.flushWheel()
  }
}
