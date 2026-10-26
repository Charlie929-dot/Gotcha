/**
 * 信息链 · 系统事件源的边界（传输层接口）
 *
 * 传输方式（原生 N-API addon / 常驻桥 / 假源）是可换项，所以这里只声明**最小契约**：
 * 谁能把「系统上发生了什么」按时间线吐出来，谁就能接进信息链（AGENTS 常驻指令 11）。
 *
 * 这一层刻意不做任何策略判断：不切段、不决定截图、不判空闲。策略全在
 * `segmenter.ts`（纯状态机，可测），适配在 `adapter.ts`，落库在 `recorder.ts`。
 *
 * 隐私边界：原始事件**只描述动作与位置**，不含任何按键内容、不含屏幕像素。
 */

/** 一条原始桌面事件（时间戳一律毫秒 epoch） */
export type RawDesktopEvent =
  | {
      type: 'foreground'
      ts: number
      pid: number
      hwnd: number
      /** 进程名，小写（如 `firefox`） */
      exe: string
      /** 窗口标题（可能为空串） */
      title: string
      /** 应用显示名（active-win 的 owner.name），拿不到就给 null */
      app: string | null
    }
  | { type: 'move'; ts: number; x: number; y: number }
  | { type: 'click'; ts: number; x: number; y: number; button: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; ts: number; delta: number; x: number; y: number }

export interface DesktopEventSource {
  /** 开始投递原始事件；重复调用应当是安全的（实现自己保证幂等） */
  start(onEvent: (event: RawDesktopEvent) => void): void
  stop(): void
  /**
   * 最近一次系统输入的 tick（`GetLastInputInfo` 的 `dwTime`，毫秒）。
   * 它**分辨不出**是键盘还是鼠标——所以适配层还要结合「这段时间有没有收到鼠标事件」来判断（见 `adapter.ts`）。
   */
  lastInputTickMs(): number
  /** 可选自述：这条源到底跑的哪条路（写进日志，便于确认没有静默降级） */
  readonly sourceInfo?: SourceInfo
}

/** 传输实现的自述信息（写进日志与状态栏，便于确认当前跑的是哪条路） */
export interface SourceInfo {
  kind: 'native' | 'powershell' | 'fake'
  detail?: string
}
