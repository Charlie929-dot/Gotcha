/**
 * 全局热键（m1b-plan §3 Phase 2 / B4）
 *
 * 只注册 `Alt+P` 一个总开关（Q5：`Alt+Space` M1b 不注册）。不引 keyspy / iohook
 * 类全局键鼠钩子（security.md），只用 Electron 内置 `globalShortcut`；注入
 * `GlobalShortcutLike` 便于单测覆盖「注册被占用」分支。
 *
 * 已知副作用：全局注册会抢占其他应用的 `Alt+P` 助记键（Q5 已告知）。
 * 注册失败不抛错：返回 `registered=false`，由调用方在球上挂角标 + 写日志。
 */

import type { CaptureLog } from './capture-controller'

export const TOGGLE_ACCELERATOR = 'Alt+P'

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregisterAll(): void
}

export interface HotkeyHandle {
  /** false = 被系统 / 其他应用占用，热键不生效 */
  readonly registered: boolean
  /** 退出时调用：释放全局热键（unregisterAll，M1b 只有 Alt+P 一个） */
  dispose(): void
}

/**
 * 注册 `Alt+P` → toggle。
 *
 * - `register` 返回 false（被占用）或抛错：记 warn 日志，`registered=false`；
 * - `dispose` 调 `unregisterAll`，进程退出前必须调用，否则热键可能残留到重启。
 */
export function registerToggleHotkey(
  shortcuts: GlobalShortcutLike,
  toggle: () => void,
  log?: CaptureLog
): HotkeyHandle {
  let registered = false
  try {
    registered = shortcuts.register(TOGGLE_ACCELERATOR, toggle) === true
  } catch (error) {
    registered = false
    log?.('warn', 'global hotkey register threw', { accelerator: TOGGLE_ACCELERATOR, error: String(error) })
  }

  if (registered) {
    log?.('info', 'global hotkey registered', { accelerator: TOGGLE_ACCELERATOR })
  } else {
    log?.('warn', 'global hotkey unavailable (occupied)', { accelerator: TOGGLE_ACCELERATOR })
  }

  return {
    registered,
    dispose: () => {
      try {
        shortcuts.unregisterAll()
        registered = false
      } catch (error) {
        log?.('warn', 'global hotkey unregister failed', { error: String(error) })
      }
    }
  }
}
