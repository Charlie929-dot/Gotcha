/**
 * 全局热键注册表（m1b-plan §3 Phase 2 / M2 Phase 2 D20）
 *
 * - 两个动作：切换记录（默认 `Alt+P`）/ 打开图谱（默认 `Alt+Space`），绑定存 settings
 *   （`hotkey.toggle_capture` / `hotkey.open_graph`），设置抽屉可改；
 * - 注册失败（被占用 / 抛错 / 两键相同 / 语法不支持）不抛到启动链路，逐键返回原因；
 * - 设置保存后 `reregister()`：先注销旧键再注册新键，不做 `unregisterAll`（避免误伤后续扩展）；
 * - 退出 `dispose()` 兜底 `unregisterAll`。
 *
 * 不引 keyspy / iohook 类全局键鼠钩子（security.md），只用 Electron `globalShortcut`；
 * 注入 `GlobalShortcutLike` 便于单测覆盖冲突分支。
 */

import type { CaptureLog } from './capture-controller'

export const DEFAULT_HOTKEYS = {
  toggleCapture: 'Alt+P',
  openGraph: 'Alt+Space'
} as const

export const HOTKEY_SETTING_KEYS = {
  toggleCapture: 'hotkey.toggle_capture',
  openGraph: 'hotkey.open_graph'
} as const

export interface HotkeyBindings {
  toggleCapture: string
  openGraph: string
}

export type HotkeyAction = keyof HotkeyBindings

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered?(accelerator: string): boolean
  unregisterAll(): void
}

export type HotkeyFailureReason = 'occupied' | 'duplicate' | 'invalid'

export interface HotkeyRegisterResult {
  action: HotkeyAction
  accelerator: string
  ok: boolean
  reason?: HotkeyFailureReason
}

export interface HotkeyHandle {
  /** 逐键注册结果（球角标 / 设置抽屉标红用） */
  readonly results: readonly HotkeyRegisterResult[]
  /** false = 该动作没注册上（冲突 / 语法不支持） */
  isRegistered(action: HotkeyAction): boolean
  /** 设置保存后重绑：先注销旧键，再注册新键 */
  reregister(bindings: HotkeyBindings): void
  /** 退出时释放全部全局热键 */
  dispose(): void
}

const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'shift',
  'super',
  'meta'
])

const NAMED_KEYS = new Set([
  'space',
  'tab',
  'enter',
  'return',
  'escape',
  'esc',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'plus',
  'numdec',
  'numadd',
  'numsub',
  'nummult',
  'numdiv',
  'printscreen',
  'screenshot',
  'scrolllock',
  'capslock',
  'numlock',
  'clear',
  'volumemute',
  'volumeup',
  'volumedown',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause'
])

function isNamedKey(token: string): boolean {
  const lower = token.toLowerCase()
  if (NAMED_KEYS.has(lower)) return true
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(lower)) return true
  if (/^num[0-9]$/.test(lower)) return true
  return false
}

/**
 * Electron accelerator 的最小校验：至少一个键，修饰键只允许常见集合，不允许空 token。
 * 不做完整语义校验（Electron 自己会拒绝非法键），只把明显非法的设置挡在保存前。
 */
export function isSupportedAccelerator(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '' || text.length > 64) return false
  const tokens = text.split('+')
  if (tokens.some((token) => token.trim() === '')) return false
  const key = tokens[tokens.length - 1].trim()
  if (key.length === 1) {
    if (!/[a-z0-9]/i.test(key)) return false
  } else if (!isNamedKey(key)) {
    return false
  }
  const modifiers = tokens.slice(0, -1).map((token) => token.trim().toLowerCase())
  const seen = new Set<string>()
  for (const modifier of modifiers) {
    if (!MODIFIERS.has(modifier) || seen.has(modifier)) return false
    seen.add(modifier)
  }
  return true
}

function sameAccelerator(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function registerHotkeys(
  shortcuts: GlobalShortcutLike,
  actions: Record<HotkeyAction, () => void>,
  bindings: HotkeyBindings = DEFAULT_HOTKEYS,
  log?: CaptureLog
): HotkeyHandle {
  let current: HotkeyBindings = { ...bindings }
  let results: HotkeyRegisterResult[] = []

  const unregister = (accelerator: string): void => {
    try {
      shortcuts.unregister(accelerator)
    } catch (error) {
      log?.('warn', 'global hotkey unregister failed', {
        accelerator,
        error: String(error)
      })
    }
  }

  const registerOne = (action: HotkeyAction, accelerator: string): HotkeyRegisterResult => {
    const value = typeof accelerator === 'string' ? accelerator.trim() : ''
    if (!isSupportedAccelerator(value)) {
      log?.('warn', 'global hotkey invalid accelerator', { action, accelerator: String(accelerator) })
      return { action, accelerator: value, ok: false, reason: 'invalid' }
    }
    let registered = false
    try {
      registered = shortcuts.register(value, actions[action]) === true
    } catch (error) {
      log?.('warn', 'global hotkey register threw', { accelerator: value, error: String(error) })
      return { action, accelerator: value, ok: false, reason: 'occupied' }
    }
    if (!registered) {
      log?.('warn', 'global hotkey unavailable (occupied)', { accelerator: value })
      return { action, accelerator: value, ok: false, reason: 'occupied' }
    }
    log?.('info', 'global hotkey registered', { accelerator: value })
    return { action, accelerator: value, ok: true }
  }

  const apply = (next: HotkeyBindings): void => {
    current = {
      toggleCapture: typeof next.toggleCapture === 'string' ? next.toggleCapture.trim() : '',
      openGraph: typeof next.openGraph === 'string' ? next.openGraph.trim() : ''
    }
    if (sameAccelerator(current.toggleCapture, current.openGraph)) {
      const reason = '两键相同，无法同时注册'
      log?.('warn', 'global hotkey duplicate binding', {
        toggleCapture: current.toggleCapture,
        openGraph: current.openGraph,
        reason
      })
      results = [
        { action: 'toggleCapture', accelerator: current.toggleCapture, ok: false, reason: 'duplicate' },
        { action: 'openGraph', accelerator: current.openGraph, ok: false, reason: 'duplicate' }
      ]
      return
    }
    results = [
      registerOne('toggleCapture', current.toggleCapture),
      registerOne('openGraph', current.openGraph)
    ]
  }

  apply(current)

  return {
    get results(): readonly HotkeyRegisterResult[] {
      return results
    },
    isRegistered(action: HotkeyAction): boolean {
      return results.some((result) => result.action === action && result.ok)
    },
    reregister(next: HotkeyBindings): void {
      unregister(current.toggleCapture)
      unregister(current.openGraph)
      apply(next)
    },
    dispose(): void {
      try {
        shortcuts.unregisterAll()
      } catch (error) {
        log?.('warn', 'global hotkey unregister failed', { error: String(error) })
      }
    }
  }
}
