import { describe, expect, it, vi } from 'vitest'
import {
  registerToggleHotkey,
  TOGGLE_ACCELERATOR,
  type GlobalShortcutLike
} from '../../src/main/hotkeys'
import type { CaptureLog } from '../../src/main/capture-controller'

function fakeShortcuts(behavior: boolean | Error): {
  shortcuts: GlobalShortcutLike
  register: ReturnType<typeof vi.fn>
  unregisterAll: ReturnType<typeof vi.fn>
} {
  const register = vi.fn((_accelerator: string, _callback: () => void) => {
    if (behavior instanceof Error) throw behavior
    return behavior
  })
  const unregisterAll = vi.fn(() => {})
  return {
    shortcuts: { register, unregisterAll },
    register,
    unregisterAll
  }
}

function logSpy(): CaptureLog & ReturnType<typeof vi.fn> {
  return vi.fn() as unknown as CaptureLog & ReturnType<typeof vi.fn>
}

describe('registerToggleHotkey（Alt+P，B4）', () => {
  it('注册成功：绑定 Alt+P 并把回调接到 toggle；dispose 释放全局热键', () => {
    const { shortcuts, register, unregisterAll } = fakeShortcuts(true)
    const toggle = vi.fn()
    const log = logSpy()

    const handle = registerToggleHotkey(shortcuts, toggle, log)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(TOGGLE_ACCELERATOR, toggle)
    expect(handle.registered).toBe(true)

    const callback = register.mock.calls[0][1] as () => void
    callback()
    expect(toggle).toHaveBeenCalledTimes(1)

    handle.dispose()
    expect(unregisterAll).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('info', 'global hotkey registered', {
      accelerator: 'Alt+P'
    })
  })

  it('注册被占用（register 返回 false）：registered=false、记 warn、不抛错', () => {
    const { shortcuts } = fakeShortcuts(false)
    const log = logSpy()

    const handle = registerToggleHotkey(shortcuts, vi.fn(), log)

    expect(handle.registered).toBe(false)
    expect(log).toHaveBeenCalledWith('warn', 'global hotkey unavailable (occupied)', {
      accelerator: 'Alt+P'
    })
    // 失败也要能安全 dispose（退出路径统一调用）
    expect(() => handle.dispose()).not.toThrow()
  })

  it('register 抛错：按失败处理并记录错因，不打断启动', () => {
    const { shortcuts } = fakeShortcuts(new Error('boom'))
    const log = logSpy()

    const handle = registerToggleHotkey(shortcuts, vi.fn(), log)

    expect(handle.registered).toBe(false)
    expect(log).toHaveBeenCalledWith('warn', 'global hotkey register threw', {
      accelerator: 'Alt+P',
      error: 'Error: boom'
    })
  })
})
