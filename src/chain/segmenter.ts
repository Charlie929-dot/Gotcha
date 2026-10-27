/**
 * 信息链 · 段与采集决策（纯状态机，不碰 Windows API、不碰数据库）
 *
 * 把拍板的口径落成可测的逻辑（契约 v0.3 / D39）：
 * - 段 = 同一窗口（pid + hwnd）的焦点占用；标题变化算换一件事；
 * - 空闲 = `idleMs`（默认 60s）没有任何输入 → 停采，只留空闲标记；
 * - 走开又回来（同一窗口、`mergeIdleCapMs` 内）→ 接续成同一段，空闲不计入占用时长；
 * - 标题抖动：`titleFlapMs`（默认 3s）内变回原值就不切段；
 * - **焦点抖动确认窗**（`focusFlapMs`，默认 1.5s，v0.14）：焦点切到新窗口先挂起，只有
 *   该窗口收到动作（点击 / 滚轮 / 打字）或停留满窗口才真正切段；否则当噪声丢掉
 *   （真机 2026-10-27：今日 295 段里 173 段 <2s，其中 156 段零动作——窗口被瞬间抢个焦点）；
 * - **采集（截图）只由三类时刻驱动**（契约 v0.11，2026-10-27 拍板）：
 *   ① 左 / 右键**从 ≥`captureCooldownMs` 的静默里**发起 → 立刻拍；
 *   ② 打字被点击 / 滚轮**打断** → 立刻拍（保住刚敲进去的内容）；
 *   ③ 滚轮手势停下 `wheelCaptureDelayMs`（2s）→ 拍滚动结果；
 *   鼠标移动永不拍；打字自己停顿不拍。
 * - 键盘：任何输入都重置「打字停顿」计时，停顿满 `typingSettleMs`（默认 3s）补一条 typing **事件**
 *   （只是锚点，不截图）。
 *
 * 动作契约：**事件一律上报**（它是段内的时间锚点，不是可选项），触发规则只决定
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
  /**
   * 焦点抖动确认窗（v0.14）：焦点落到新窗口后，这么久之内没收到任何动作、
   * 也没停住这么久，就当「被瞬间抢焦点」，不建段。
   */
  focusFlapMs: number
  /** 打字停顿多久补一条 typing 事件（不截图） */
  typingSettleMs: number
  /** 两张截图的最小间隔；也是「点击要从多久的静默里发起才算一次采集」 */
  captureCooldownMs: number
  /** 滚轮手势停下多久拍一张（滚动结果） */
  wheelCaptureDelayMs: number
  /** 指针停下多久算「移动后暂停」 */
  movePauseMs: number
  /** 停下前至少移动多少像素 */
  movePauseDistPx: number
  /**
   * 幽灵前台窗的判据（v0.12）：窗口矩形与屏幕的交集小于这个面积（px²）就不当一段。
   * 0×0 的辅助窗、被最小化到屏幕外的窗都落在这条；32×32 是「小到没有可读内容」的量级。
   */
  phantomMinOnScreenPx: number
  /** 系统覆盖层窗口类名：前台落在它们身上不算切段（Alt-Tab / 任务视图 / 前台交接气泡） */
  phantomWindowClasses: readonly string[]
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  idleMs: 60_000,
  mergeIdleCapMs: 30 * 60_000,
  titleFlapMs: 3_000,
  focusFlapMs: 1_500,
  typingSettleMs: 3_000,
  captureCooldownMs: 2_000,
  wheelCaptureDelayMs: 2_000,
  movePauseMs: 400,
  movePauseDistPx: 40,
  phantomMinOnScreenPx: 32 * 32,
  phantomWindowClasses: [
    // Win11 的 Alt-Tab / 任务视图 / 焦点交接（UWP 启动时）各有一个覆盖层窗抢前台
    'TaskSwitcherWnd',
    'MultitaskingViewFrame',
    'ForegroundStaging',
    // 桌面外壳：点一下任务栏 / 桌面不该切出一段（v0.13 起「点哪算哪」，必须排除外壳）
    'Shell_TrayWnd',
    'Shell_SecondaryTrayWnd',
    'Progman',
    'WorkerW'
  ]
}

export type ChainInput =
  | {
      kind: 'focus'
      ts: number
      pid: number
      exe: string
      title: string
      hwnd: number
      app?: string | null
      /** 窗口事实（v0.12，可选）：不报就按「未知」放行，见 `isPhantomFocus` */
      visible?: boolean
      minimized?: boolean
      onScreenArea?: number
      className?: string
    }
  | { kind: 'click'; ts: number; button: 'left' | 'right' | 'middle'; x: number; y: number }
  | { kind: 'wheel'; ts: number; delta: number; x: number; y: number }
  | { kind: 'move'; ts: number; x: number; y: number }
  /** 有输入但不知道是什么（键盘）；不含内容 */
  | { kind: 'activity'; ts: number }
  /** 时钟推进：只用来判空闲与打字停顿，不产生事件 */
  | { kind: 'tick'; ts: number }

type FocusInput = Extract<ChainInput, { kind: 'focus' }>

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
  /** 是否处在「打字中」：最近一次输入是键盘、还没被鼠标打断 */
  private typingActive = false
  /** 滚轮手势：停下 `wheelCaptureDelayMs` 后才作为「滚动结果」上报并截图 */
  private pendingWheel: { fromTs: number; lastTs: number; delta: number; x: number; y: number } | null = null
  private pendingTitle: { from: string; to: string; at: number } | null = null
  /**
   * 挂起的焦点切换（v0.14）：切过去的窗口还没证明「人在用它」。
   * 收到动作即确认，或等满 `focusFlapMs`；期间不切段、不开段、不落事件。
   */
  private pendingSwitch: { at: number; to: FocusInput } | null = null
  /** 被确认窗丢掉的闪段数（观测：真机上它应该稳定大于 0，否则判据没生效） */
  private flashSegmentsDropped = 0
  private lastMove: { ts: number; x: number; y: number; moved: number } | null = null
  /** 被丢掉的幽灵前台事件数（只做观测：真机上它应该稳定大于 0，否则判据没生效） */
  private phantomFocusDropped = 0
  /**
   * 已上报过的最后一条子行时刻（事件 / 滚轮）。
   * 收口边界不能早于它，否则存储层「子行晚于段结束」校验会抛错。
   */
  private lastChildTs = Number.NEGATIVE_INFINITY

  constructor(options: Partial<SegmenterOptions> = {}) {
    this.options = { ...DEFAULT_SEGMENTER_OPTIONS, ...options }
  }

  /** 丢掉过多少次幽灵前台（调试 / 测试 / 诊断用） */
  get phantomDropped(): number {
    return this.phantomFocusDropped
  }

  /** 被焦点确认窗丢掉的闪段数（v0.14，观测用） */
  get flashDropped(): number {
    return this.flashSegmentsDropped
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

    const previousInputTs = this.lastInputTs
    const actions = this.advance(input.ts)
    this.resumeFromIdle(input.ts, actions)

    this.lastInputTs = input.ts
    // 只有「键盘活动」才启动打字停顿计时：焦点切换、点击、滚轮各自有采集路径，
    // 把它们也算进来会凭空多出一条「停顿」事件
    if (input.kind === 'activity') this.typingDueAt = input.ts + this.options.typingSettleMs
    if (this.open) this.open.lastInputTs = input.ts

    switch (input.kind) {
      case 'focus':
        actions.push(...this.flushWheel(false))
        this.typingActive = false
        actions.push(...this.onFocus(input))
        break
      case 'click': {
        // v0.14：切过去的那扇窗收到点击，就等于「人在用它」——先确认切段，事件才落得对
        actions.push(...this.confirmPendingSwitch(input.ts))
        actions.push(...this.flushWheel(false))
        actions.push(...this.settleMovePause(input.ts))
        // 采集口径（契约 v0.11）：打断打字 → 立刻拍（保住刚敲进去的内容）；
        // 否则这一下点击必须从 ≥ cooldown 的静默里发起——连续点击不产生图。
        const capture =
          this.canCapture(input.ts) &&
          (this.typingActive || input.ts - previousInputTs >= this.options.captureCooldownMs)
        this.typingActive = false
        const event = this.recordEvent(
          input.ts,
          clickKind(input.button),
          Math.round(input.x),
          Math.round(input.y),
          null,
          capture
        )
        if (event) actions.push(event)
        break
      }
      case 'wheel': {
        actions.push(...this.confirmPendingSwitch(input.ts))
        // 滚轮不立刻拍：等手势停下 wheelCaptureDelayMs，拍的是「滚动结果」
        const wheel = this.pendingWheel
        this.pendingWheel = wheel
          ? {
              fromTs: wheel.fromTs,
              lastTs: input.ts,
              delta: wheel.delta + input.delta,
              x: Math.round(input.x),
              y: Math.round(input.y)
            }
          : {
              fromTs: input.ts,
              lastTs: input.ts,
              delta: input.delta,
              x: Math.round(input.x),
              y: Math.round(input.y)
            }
        this.typingActive = false
        break
      }
      case 'move':
        this.trackMove(input)
        break
      case 'activity':
        // 键盘**不**确认切段（真机 14:04 复测的口子）：`activity` 来自 `GetLastInputInfo`，
        // 分不清「在新窗口里打字」和「Alt-Tab 那几下按键」——977ms 的 cmd 闪段就是这么被认领的。
        // 键盘只重置打字计时，切段仍由点击 / 滚轮或时间确认。
        this.typingActive = true
        break
    }
    return actions
  }

  /** 停止采集：把开着的段收口 */
  flush(now: number): ChainAction[] {
    const actions = this.advance(now)
    // 还挂着的切换从没被确认过：直接作废，不补段；旧段也只记到切换那一刻
    const pendingAt = this.pendingSwitch?.at ?? null
    this.pendingSwitch = null
    actions.push(...this.flushWheel(false))
    // 停止时也没活过确认窗的标题抖动不该切成空段（同 settlePendingTitleForSwitch）
    this.settlePendingTitleForSwitch(now, actions)
    if (this.open) {
      const endTs =
        this.idleFrom ?? (pendingAt === null ? now : Math.max(pendingAt, this.lastChildTs))
      actions.push(this.closeSegment(endTs, 'stop'))
      this.idleFrom = null
    }
    return actions
  }

  /* ---------------------------------------------------------------- */

  /** 推进时间：标题抖动、打字停顿、移动后暂停、空闲检测 */
  private advance(now: number): ChainAction[] {
    const actions: ChainAction[] = []

    // 焦点确认窗（v0.14）：挂起的切换停满 focusFlapMs 就落实
    if (this.pendingSwitch && now - this.pendingSwitch.at >= this.options.focusFlapMs) {
      actions.push(...this.confirmPendingSwitch(now))
    }

    if (this.pendingTitle && now - this.pendingTitle.at >= this.options.titleFlapMs) {
      actions.push(...this.commitTitleSplit())
    }

    if (this.typingDueAt !== null && now >= this.typingDueAt) {
      // typing 只是锚点事件（「这段打过字」），**不截图**：截图只由点击 / 滚轮 / 打断触发
      const event = this.recordEvent(this.typingDueAt, 'typing')
      if (event) actions.push(event)
      this.typingDueAt = null
    }

    // 滚轮手势停下 wheelCaptureDelayMs：这时才上报 wheel 事件并拍「滚动结果」
    if (this.pendingWheel && now - this.pendingWheel.lastTs >= this.options.wheelCaptureDelayMs) {
      actions.push(...this.flushWheel(this.canCapture(now), now))
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
    // 移动后暂停只是锚点事件：**鼠标移动永不截图**（契约 v0.11）
    const event = this.recordEvent(move.ts + this.options.movePauseMs, 'move_pause', Math.round(move.x), Math.round(move.y))
    return event ? [event] : []
  }

  /** 把挂起的滚轮手势交出去；`capture` 由调用方按「滚动结果」口径决定 */
  private flushWheel(capture: boolean, captureAt?: number): ChainAction[] {
    const wheel = this.pendingWheel
    if (!wheel) return []
    this.pendingWheel = null
    if (!this.open) return []
    if (capture) this.lastCaptureTs = captureAt ?? wheel.lastTs
    // 这条事件也进了库：标题抖动的收口边界不能早于它
    if (wheel.lastTs > this.lastChildTs) this.lastChildTs = wheel.lastTs
    return [
      {
        type: 'event',
        at: wheel.lastTs,
        kind: 'wheel',
        x: wheel.x,
        y: wheel.y,
        delta: wheel.delta,
        capture
      }
    ]
  }

  private canCapture(at: number): boolean {
    return at - this.lastCaptureTs >= this.options.captureCooldownMs
  }

  private trackMove(input: Extract<ChainInput, { kind: 'move' }>): void {
    // 挂起的切换期间不跟踪移动：它的 ts 早于新段起点，落库会违反「子行不早于段开始」
    if (this.pendingSwitch) return
    if (!this.lastMove) {
      this.lastMove = { ts: input.ts, x: input.x, y: input.y, moved: 0 }
      return
    }
    this.lastMove.moved += Math.hypot(input.x - this.lastMove.x, input.y - this.lastMove.y)
    this.lastMove.x = input.x
    this.lastMove.y = input.y
    this.lastMove.ts = input.ts
  }

  /**
   * 幽灵前台窗（v0.12）：拿到前台、却不是「人在用的那扇窗」。
   *
   * 真机踩到过三个来源：火绒升级器的 0×0 隐藏窗（抢前台 52s，用户的 46 条点击 / 打字全记到它头上）、
   * explorer 的一堆 0×0 辅助窗、被最小化到 (-31992,-32000) 的窗；还有 Alt-Tab 的任务切换覆盖层。
   * 判据只用事实字段，缺字段一律**不知道**（放行）——宁可多记一段，也不误杀真窗口。
   */
  private isPhantomFocus(input: Extract<ChainInput, { kind: 'focus' }>): boolean {
    if (input.visible === false) return true
    if (input.minimized === true) return true
    if (input.onScreenArea !== undefined && input.onScreenArea < this.options.phantomMinOnScreenPx) return true
    if (input.className !== undefined && this.options.phantomWindowClasses.includes(input.className)) return true
    return false
  }

  private onFocus(input: FocusInput): ChainAction[] {
    const actions: ChainAction[] = []
    // 幽灵窗不配当一段：不切段、不收口、不动标题抖动窗口——它的输入继续算在当前这一段上
    // （当前没段就什么都不开，时间轴留空总比记错强）。
    if (this.isPhantomFocus(input)) {
      this.phantomFocusDropped += 1
      return actions
    }
    const justResumed = this.idleClosed !== null && this.idleClosed.to === input.ts
    this.idleClosed = null

    // 已经挂着一个待确认的切换（v0.14）：先判这次焦点是「回到原地 / 还是这个候选 / 换成第三个窗」
    const pending = this.pendingSwitch
    if (pending) {
      if (this.open && sameWindow(this.open, input)) {
        // 回到原来那扇窗：刚才那一下就是抢焦点，什么都没发生
        this.pendingSwitch = null
        this.flashSegmentsDropped += 1
      } else if (sameWindow(pending.to, input)) {
        // 还是同一个候选窗（标题可能变了）：只换候选，计时不动
        this.pendingSwitch = { at: pending.at, to: input }
        return actions
      } else {
        // 又切到第三个窗：前一个候选从没被用过，作废
        this.flashSegmentsDropped += 1
        this.pendingSwitch = { at: input.ts, to: input }
        return actions
      }
    }

    if (!this.open) {
      // 第一段也走确认窗：应用刚起来时的焦点抖动不该落成一段
      this.deferSwitch(input, input.ts, actions)
      return actions
    }

    const sameWindowNow = sameWindow(this.open, input)

    // 刚结束空闲就回到同一窗口：接续，只是段内多了一个空闲洞
    if (justResumed && sameWindowNow && input.title === this.open.title) {
      this.pushEnter(input.ts, actions)
      return actions
    }

    if (sameWindowNow && input.title !== this.open.title) {
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

    if (sameWindowNow) {
      this.pendingTitle = null
      return actions
    }

    // 换窗口：先挂起，等「动作」或「停满 focusFlapMs」（v0.14）
    this.deferSwitch(input, input.ts, actions)
    return actions
  }

  /**
   * 挂起一次焦点切换（v0.14）：**不切段、不开段、不落事件**，等
   * `confirmPendingSwitch` 被动作触发或被 `advance` 按时间确认。
   * 挂起前把在途手势清掉——它们属于「刚刚那一下」，不该记到新段里。
   */
  private deferSwitch(input: FocusInput, at: number, actions: ChainAction[]): void {
    // 标题抖动还没到期就切走：标题记到旧段上，不切（见 settlePendingTitleForSwitch）
    this.settlePendingTitleForSwitch(at, actions)
    this.lastMove = null
    this.typingDueAt = null
    this.typingActive = false
    this.pendingSwitch = { at, to: input }
  }

  /**
   * 确认挂起的切换。边界照标题抖动的教训取 `max(切换时刻, 已落库的最后一条子行)`：
   * 挂起期间可能已经上报过事件（确认窗里点了鼠标），段结束不能早于它们。
   */
  private confirmPendingSwitch(now: number): ChainAction[] {
    const pending = this.pendingSwitch
    if (!pending) return []
    this.pendingSwitch = null
    const actions: ChainAction[] = []
    const boundary = Math.max(pending.at, this.lastChildTs)
    this.settlePendingTitleForSwitch(now, actions)
    if (this.open) actions.push(this.closeSegment(boundary, 'switch'))
    this.beginSegment(pending.to, boundary, actions)
    return actions
  }

  /**
   * 切段撞上还没到期的标题抖动：**不另起一段**，把新标题记到旧段的 `title_last` 上。
   *
   * 真机 2026-10-27 14:06 复测：B 站标题抖了一下（还没过 3s 确认窗），人随即切走，
   * 若在这里 `commitTitleSplit()` 就会切出一个 **93ms 的空段**。标题变化没活过确认窗，
   * 本来就不算「换了一件事」；过了确认窗的（`now` 已超时）才照旧切。
   */
  private settlePendingTitleForSwitch(now: number, actions: ChainAction[]): void {
    const pending = this.pendingTitle
    if (!pending) return
    if (now - pending.at >= this.options.titleFlapMs) {
      actions.push(...this.commitTitleSplit())
      return
    }
    if (this.open) this.open.title = pending.to
    this.pendingTitle = null
  }

  /** 开段：先上报开段（行要落库），再上报入场事件 */
  private beginSegment(input: FocusInput, ts: number, actions: ChainAction[]): void {
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
    // 入场帧：每段一张，但仍守最小间隔（瞬时段连发时不至于一口气拍一串）
    const event = this.recordEvent(ts, 'enter', null, null, null, this.canCapture(ts))
    if (event) actions.push(event)
  }

  /**
   * 标题抖动窗口过去了：段在标题变化那一刻收口，新段从那一刻开始。
   *
   * 边界要夹到「已经上报过的最后一条子行」之后：确认窗（`titleFlapMs`）里用户仍然在点，
   * 那些事件已经按更晚的时刻落库了；再把段收回标题变化那一刻，存储层校验「子行晚于段结束」
   * 就会抛错（真机 2026-10-27：段 237 的结束时间比子行早 2.126 秒，弹了个 Electron 错误窗）。
   */
  private commitTitleSplit(): ChainAction[] {
    const pending = this.pendingTitle
    if (!pending || !this.open) return []
    this.pendingTitle = null
    const actions: ChainAction[] = []
    const segment = this.open
    const boundary = Math.max(pending.at, this.lastChildTs)
    actions.push(this.closeSegment(boundary, 'switch'))
    this.open = {
      startTs: boundary,
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
      at: boundary,
      segment: {
        startTs: boundary,
        pid: segment.pid,
        exe: segment.exe,
        app: segment.app,
        hwnd: segment.hwnd,
        title: pending.to
      }
    })
    this.pushEnter(boundary, actions)
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
    this.typingActive = false
    this.pendingWheel = null
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
    delta: number | null = null,
    capture = false
  ): ChainAction | null {
    if (!this.open) return null
    if (capture) this.lastCaptureTs = at
    if (at > this.lastChildTs) this.lastChildTs = at
    return { type: 'event', at, kind, x, y, delta, capture }
  }
}

function clickKind(button: 'left' | 'right' | 'middle'): ChainEventKind {
  if (button === 'right') return 'click_right'
  if (button === 'middle') return 'click_middle'
  return 'click_left'
}

/** 是不是同一扇窗（段身份 = 动作目标窗，v0.13） */
function sameWindow(
  a: { pid: number; hwnd: number },
  b: { pid: number; hwnd: number }
): boolean {
  return a.pid === b.pid && a.hwnd === b.hwnd
}
