/**
 * 信息链 · 段与采集决策（纯状态机，不碰 Windows API、不碰数据库）
 *
 * 把拍板的口径落成可测的逻辑（契约 v0.3 / D39）：
 * - 段 = 同一窗口（pid + hwnd）的焦点占用；标题变化算换一件事；
 * - 空闲 = `idleMs`（默认 60s）没有任何输入 → 停采，只留空闲标记；
 * - 走开又回来（同一窗口、`mergeIdleCapMs` 内）→ 接续成同一段，空闲不计入占用时长；
 * - 标题抖动：`titleFlapMs`（默认 3s）内变回原值就不切段；
 * - 采集只由事件驱动：入场 / 点击 / 滚轮 / 移动后暂停；
 * - 键盘：任何输入都重置「打字停顿」计时，停顿满 `typingSettleMs`（默认 3s）补采一张。
 *
 * 动作契约：**事件一律上报**（它是段内的时间锚点，不是可选项），冷却只决定
 * `capture` 为不为真（要不要顺手截一张）。这样「切过来 1 秒内点了一下」不会连锚点都丢。
 *
 * `activity` 输入表示「系统有输入但拿不到是什么」（键盘），来自 `GetLastInputInfo`——
 * 因此不需要键盘钩子。
 */
import type { ChainEventKind } from './schema'

export interface SegmenterOptions {
  /** 空闲判定：这么久没有任何输入就算走了 */
  idleMs: number
  /** 走开回来还能接续的上限 */
  mergeIdleCapMs: number
  /** 标题抖动抑制窗口 */
  titleFlapMs: number
  /** 打字停顿多久补采一张 */
  typingSettleMs: number
  /** 两次截图的最小间隔 */
  captureCooldownMs: number
  /** 指针停下多久算「移动后暂停」 */
  movePauseMs: number
  /** 停下前至少移动多少像素 */
  movePauseDistPx: number
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  idleMs: 60_000,
  mergeIdleCapMs: 30 * 60_000,
  titleFlapMs: 3_000,
  typingSettleMs: 3_000,
  captureCooldownMs: 2_000,
  movePauseMs: 400,
  movePauseDistPx: 40
}

export type ChainInput =
  | { kind: 'focus'; ts: number; pid: number; exe: string; title: string; hwnd: number; app?: string | null }
  | { kind: 'click'; ts: number; button: 'left' | 'right' | 'middle'; x: number; y: number }
  | { kind: 'wheel'; ts: number; delta: number; x: number; y: number }
  | { kind: 'move'; ts: number; x: number; y: number }
  /** 有输入但不知道是什么（键盘）；不含内容 */
  | { kind: 'activity'; ts: number }
  /** 时钟推进：只用来判空闲与打字停顿，不产生事件 */
  | { kind: 'tick'; ts: number }

/** 开段时已知的信息（段行此时就要落库，子行才能拿到 segment_id） */
export interface SegmentOpenDraft {
  startTs: number
  pid: number
  exe: string
  app: string | null
  hwnd: number
  title: string
}

export interface SegmentDraft {
  startTs: number
  endTs: number
  activeMs: number
  idleMs: number
  pid: number
  exe: string
  app: string | null
  hwnd: number
  titleFirst: string
  titleLast: string
}

export type ChainAction =
  | { type: 'segment-opened'; at: number; segment: SegmentOpenDraft }
  | {
      type: 'event'
      at: number
      kind: ChainEventKind
      x: number | null
      y: number | null
      delta: number | null
      /** 冷却允许的话，顺手截一张（截图只是证据，事件本身照记） */
      capture: boolean
    }
  | { type: 'segment-closed'; segment: SegmentDraft; reason: 'switch' | 'idle' | 'stop' }
  | { type: 'idle-start'; at: number }
  | { type: 'idle-end'; from: number; to: number }

interface IdleRange {
  from: number
  to: number
}

interface OpenSegment {
  startTs: number
  lastInputTs: number
  pid: number
  exe: string
  app: string | null
  hwnd: number
  titleFirst: string
  title: string
  /** 已经结束的空闲区间（接续造成的洞） */
  idleRanges: IdleRange[]
}

export class ChainSegmenter {
  private readonly options: SegmenterOptions
  private open: OpenSegment | null = null
  private lastInputTs = Number.NEGATIVE_INFINITY
  private lastCaptureTs = Number.NEGATIVE_INFINITY
  /** 当前这段空闲的起点；非空表示「人可能已经走了」 */
  private idleFrom: number | null = null
  private idleClosed: { from: number; to: number } | null = null
  private typingDueAt: number | null = null
  private pendingTitle: { from: string; to: string; at: number } | null = null
  private lastMove: { ts: number; x: number; y: number; moved: number } | null = null

  constructor(options: Partial<SegmenterOptions> = {}) {
    this.options = { ...DEFAULT_SEGMENTER_OPTIONS, ...options }
  }

  /** 当前打开的段（调试 / 测试用） */
  get openSegment(): SegmentDraft | null {
    return this.open ? this.draft(this.open, this.open.lastInputTs) : null
  }

  /** 是否处在空闲中（采集器据此停采） */
  get isIdle(): boolean {
    return this.idleFrom !== null
  }

  feed(input: ChainInput): ChainAction[] {
    if (input.kind === 'tick') return this.advance(input.ts)

    const actions = this.advance(input.ts)
    this.resumeFromIdle(input.ts, actions)

    this.lastInputTs = input.ts
    // 只有「键盘活动」才启动打字停顿计时：焦点切换、点击、滚轮各自有采集路径，
    // 把它们也算进来会凭空多出一张「停顿补采」
    if (input.kind === 'activity') this.typingDueAt = input.ts + this.options.typingSettleMs
    if (this.open) this.open.lastInputTs = input.ts

    switch (input.kind) {
      case 'focus':
        actions.push(...this.onFocus(input))
        break
      case 'click':
      case 'wheel': {
        actions.push(...this.settleMovePause(input.ts))
        const event =
          input.kind === 'click'
            ? this.recordEvent(input.ts, clickKind(input.button), Math.round(input.x), Math.round(input.y))
            : this.recordEvent(input.ts, 'wheel', Math.round(input.x), Math.round(input.y), input.delta)
        if (event) actions.push(event)
        break
      }
      case 'move':
        this.trackMove(input)
        break
      case 'activity':
        // 键盘：只重置计时，等停顿满 typingSettleMs 再拍一张
        break
    }
    return actions
  }

  /** 停止采集：把开着的段收口 */
  flush(now: number): ChainAction[] {
    const actions = this.advance(now)
    if (this.pendingTitle) actions.push(...this.commitTitleSplit())
    if (this.open) {
      const endTs = this.idleFrom ?? now
      actions.push(this.closeSegment(endTs, 'stop'))
      this.idleFrom = null
    }
    return actions
  }

  /* ---------------------------------------------------------------- */

  /** 推进时间：标题抖动、打字停顿、移动后暂停、空闲检测 */
  private advance(now: number): ChainAction[] {
    const actions: ChainAction[] = []

    if (this.pendingTitle && now - this.pendingTitle.at >= this.options.titleFlapMs) {
      actions.push(...this.commitTitleSplit())
    }

    if (this.typingDueAt !== null && now >= this.typingDueAt) {
      // 停顿点若正好撞上截图冷却，就等到冷却结束再拍——「停顿满 3s 一定有一张」比守时更重要
      const due = Math.max(this.typingDueAt, this.lastCaptureTs + this.options.captureCooldownMs)
      if (now >= due) {
        const event = this.recordEvent(due, 'typing')
        if (event) actions.push(event)
        this.typingDueAt = null
      }
    }

    actions.push(...this.settleMovePause(now))

    if (this.open && this.idleFrom === null) {
      const idleAt = this.lastInputTs + this.options.idleMs
      if (now >= idleAt) {
        this.idleFrom = idleAt
        actions.push({ type: 'idle-start', at: idleAt })
      }
    }

    // 走开太久：段在空闲开始处收口，不再等接续
    if (this.open && this.idleFrom !== null && now >= this.idleFrom + this.options.mergeIdleCapMs) {
      const endTs = this.idleFrom
      actions.push(this.closeSegment(endTs, 'idle'))
      actions.push({ type: 'idle-end', from: endTs, to: now })
      this.idleFrom = null
    }

    return actions
  }

  /** 有输入就说明人回来了：结束空闲，把这段空闲如实报出去 */
  private resumeFromIdle(now: number, actions: ChainAction[]): void {
    if (this.idleFrom === null) return
    const from = this.idleFrom
    this.idleFrom = null
    this.idleClosed = { from, to: now }
    if (this.open) this.open.idleRanges.push({ from, to: now })
    actions.push({ type: 'idle-end', from, to: now })
  }

  private settleMovePause(now: number): ChainAction[] {
    const move = this.lastMove
    if (!move) return []
    if (now - move.ts < this.options.movePauseMs) return []
    this.lastMove = null
    if (move.moved < this.options.movePauseDistPx) return []
    const event = this.recordEvent(move.ts + this.options.movePauseMs, 'move_pause', Math.round(move.x), Math.round(move.y))
    return event ? [event] : []
  }

  private trackMove(input: Extract<ChainInput, { kind: 'move' }>): void {
    if (!this.lastMove) {
      this.lastMove = { ts: input.ts, x: input.x, y: input.y, moved: 0 }
      return
    }
    this.lastMove.moved += Math.hypot(input.x - this.lastMove.x, input.y - this.lastMove.y)
    this.lastMove.x = input.x
    this.lastMove.y = input.y
    this.lastMove.ts = input.ts
  }

  private onFocus(input: Extract<ChainInput, { kind: 'focus' }>): ChainAction[] {
    const actions: ChainAction[] = []
    const justResumed = this.idleClosed !== null && this.idleClosed.to === input.ts
    this.idleClosed = null

    if (!this.open) {
      this.beginSegment(input, input.ts, actions)
      return actions
    }

    const sameWindow = this.open.pid === input.pid && this.open.hwnd === input.hwnd

    // 刚结束空闲就回到同一窗口：接续，只是段内多了一个空闲洞
    if (justResumed && sameWindow && input.title === this.open.title) {
      this.pushEnter(input.ts, actions)
      return actions
    }

    if (sameWindow && input.title !== this.open.title) {
      if (this.pendingTitle) {
        if (input.title === this.pendingTitle.from) {
          this.pendingTitle = null
          return actions
        }
        this.pendingTitle = { from: this.pendingTitle.from, to: input.title, at: input.ts }
      } else {
        this.pendingTitle = { from: this.open.title, to: input.title, at: input.ts }
      }
      return actions
    }

    if (sameWindow) {
      this.pendingTitle = null
      return actions
    }

    if (this.pendingTitle) actions.push(...this.commitTitleSplit())
    if (this.open) actions.push(this.closeSegment(input.ts, 'switch'))
    this.beginSegment(input, input.ts, actions)
    return actions
  }

  /** 开段：先上报开段（行要落库），再上报入场事件 */
  private beginSegment(input: Extract<ChainInput, { kind: 'focus' }>, ts: number, actions: ChainAction[]): void {
    this.open = this.startSegment(input, ts)
    actions.push({
      type: 'segment-opened',
      at: ts,
      segment: {
        startTs: ts,
        pid: input.pid,
        exe: input.exe,
        app: input.app ?? null,
        hwnd: input.hwnd,
        title: input.title
      }
    })
    this.pushEnter(ts, actions)
  }

  private pushEnter(ts: number, actions: ChainAction[]): void {
    const event = this.recordEvent(ts, 'enter')
    if (event) actions.push(event)
  }

  /** 标题抖动窗口过去了：段在标题变化那一刻收口，新段从那一刻开始 */
  private commitTitleSplit(): ChainAction[] {
    const pending = this.pendingTitle
    if (!pending || !this.open) return []
    this.pendingTitle = null
    const actions: ChainAction[] = []
    const segment = this.open
    actions.push(this.closeSegment(pending.at, 'switch'))
    this.open = {
      startTs: pending.at,
      lastInputTs: segment.lastInputTs,
      pid: segment.pid,
      exe: segment.exe,
      app: segment.app,
      hwnd: segment.hwnd,
      titleFirst: pending.to,
      title: pending.to,
      idleRanges: []
    }
    actions.push({
      type: 'segment-opened',
      at: pending.at,
      segment: {
        startTs: pending.at,
        pid: segment.pid,
        exe: segment.exe,
        app: segment.app,
        hwnd: segment.hwnd,
        title: pending.to
      }
    })
    this.pushEnter(pending.at, actions)
    return actions
  }

  private startSegment(input: Extract<ChainInput, { kind: 'focus' }>, ts: number): OpenSegment {
    return {
      startTs: ts,
      lastInputTs: ts,
      pid: input.pid,
      exe: input.exe,
      app: input.app ?? null,
      hwnd: input.hwnd,
      titleFirst: input.title,
      title: input.title,
      idleRanges: []
    }
  }

  private closeSegment(endTs: number, reason: 'switch' | 'idle' | 'stop'): ChainAction {
    const segment = this.open as OpenSegment
    const draft = this.draft(segment, endTs)
    this.open = null
    this.lastMove = null
    this.typingDueAt = null
    return { type: 'segment-closed', segment: draft, reason }
  }

  /** 有效时长 = 跨度 − 已结束的空闲区间 */
  private draft(segment: OpenSegment, endTs: number): SegmentDraft {
    const span = Math.max(0, endTs - segment.startTs)
    const idle = segment.idleRanges.reduce(
      (sum, range) => sum + Math.max(0, Math.min(range.to, endTs) - range.from),
      0
    )
    const idleMs = Math.min(idle, span)
    return {
      startTs: segment.startTs,
      endTs,
      activeMs: span - idleMs,
      idleMs,
      pid: segment.pid,
      exe: segment.exe,
      app: segment.app,
      hwnd: segment.hwnd,
      titleFirst: segment.titleFirst,
      titleLast: segment.title
    }
  }

  /**
   * 上报一个事件。**事件本身不受冷却影响**（它是锚点，丢了就补不回来），
   * 冷却只决定 `capture`——要不要顺便截一张。
   */
  private recordEvent(
    at: number,
    kind: ChainEventKind,
    x: number | null = null,
    y: number | null = null,
    delta: number | null = null
  ): ChainAction | null {
    if (!this.open) return null
    const capture = at - this.lastCaptureTs >= this.options.captureCooldownMs
    if (capture) this.lastCaptureTs = at
    return { type: 'event', at, kind, x, y, delta, capture }
  }
}

function clickKind(button: 'left' | 'right' | 'middle'): ChainEventKind {
  if (button === 'right') return 'click_right'
  if (button === 'middle') return 'click_middle'
  return 'click_left'
}
