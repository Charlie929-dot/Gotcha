import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HOTKEYS,
  isSupportedAccelerator,
  registerHotkeys,
  type GlobalShortcutLike,
  type HotkeyAction
} from '../../src/main/hotkeys'
import type { CaptureLog } from '../../src/main/capture-controller'

interface FakeShortcuts {
  shortcuts: GlobalShortcutLike
  register: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
  unregisterAll: ReturnType<typeof vi.fn>
}

function fakeShortcuts(
  behavior: (accelerator: string) => boolean | Error = () => true
): FakeShortcuts {
  const register = vi.fn((accelerator: string, _callback: () => void) => {
    const result = behavior(accelerator)
    if (result instanceof Error) throw result
    return result
  })
  const unregister = vi.fn((_accelerator: string) => {})
  const unregisterAll = vi.fn(() => {})
  return {
    shortcuts: { register, unregister, unregisterAll },
    register,
    unregister,
    unregisterAll
  }
}

function actions(): Record<HotkeyAction, () => void> {
  return { toggleCapture: vi.fn(), openGraph: vi.fn() }
}

function logSpy(): CaptureLog & ReturnType<typeof vi.fn> {
  return vi.fn() as unknown as CaptureLog & ReturnType<typeof vi.fn>
}

describe('isSupportedAccelerator', () => {
  it('接受常见组合键与单键，拒绝空 / 未知键 / 重复修饰键', () => {
    expect(isSupportedAccelerator('Alt+P')).toBe(true)
    expect(isSupportedAccelerator('Alt+Space')).toBe(true)
    expect(isSupportedAccelerator('CommandOrControl+Shift+F12')).toBe(true)
    expect(isSupportedAccelerator('F5')).toBe(true)
    expect(isSupportedAccelerator('  Alt+P  ')).toBe(true)

    expect(isSupportedAccelerator('')).toBe(false)
    expect(isSupportedAccelerator('Alt+')).toBe(false)
    expect(isSupportedAccelerator('+P')).toBe(false)
    expect(isSupportedAccelerator('Alt+Alt+P')).toBe(false)
    expect(isSupportedAccelerator('Hyper+P')).toBe(false)
    expect(isSupportedAccelerator('Alt+NotAKey')).toBe(false)
    expect(isSupportedAccelerator(123)).toBe(false)
  })
})

describe('registerHotkeys（D20：两键注册 / 冲突检测 / 重绑 / 收口）', () => {
  it('默认注册 Alt+P 切记录 + Alt+Space 开图谱，回调分别接到对应动作', () => {
    const fake = fakeShortcuts()
    const handlers = actions()
    const handle = registerHotkeys(fake.shortcuts, handlers, DEFAULT_HOTKEYS, logSpy())

    expect(fake.register.mock.calls.map((call) => call[0])).toEqual(['Alt+P', 'Alt+Space'])
    expect(handle.results).toEqual([
      { action: 'toggleCapture', accelerator: 'Alt+P', ok: true },
      { action: 'openGraph', accelerator: 'Alt+Space', ok: true }
    ])
    expect(handle.isRegistered('toggleCapture')).toBe(true)
    expect(handle.isRegistered('openGraph')).toBe(true)

    const toggle = fake.register.mock.calls[0][1] as () => void
    const graph = fake.register.mock.calls[1][1] as () => void
    toggle()
    graph()
    expect(handlers.toggleCapture).toHaveBeenCalledTimes(1)
    expect(handlers.openGraph).toHaveBeenCalledTimes(1)

    handle.dispose()
    expect(fake.unregisterAll).toHaveBeenCalledTimes(1)
  })

  it('单个键被占用：只有该键 registered=false，另一个照常生效', () => {
    const fake = fakeShortcuts((accelerator) => accelerator !== 'Alt+Space')
    const log = logSpy()
    const handle = registerHotkeys(fake.shortcuts, actions(), DEFAULT_HOTKEYS, log)

    expect(handle.isRegistered('toggleCapture')).toBe(true)
    expect(handle.isRegistered('openGraph')).toBe(false)
    expect(handle.results.find((result) => result.action === 'openGraph')).toMatchObject({
      reason: 'occupied'
    })
    expect(log).toHaveBeenCalledWith('warn', 'global hotkey unavailable (occupied)', {
      accelerator: 'Alt+Space'
    })
  })

  it('register 抛错按占用处理并记录错因，不打断启动', () => {
    const fake = fakeShortcuts(() => new Error('boom'))
    const log = logSpy()
    const handle = registerHotkeys(fake.shortcuts, actions(), DEFAULT_HOTKEYS, log)

    expect(handle.isRegistered('toggleCapture')).toBe(false)
    expect(handle.isRegistered('openGraph')).toBe(false)
    expect(log).toHaveBeenCalledWith('warn', 'global hotkey register threw', {
      accelerator: 'Alt+P',
      error: 'Error: boom'
    })
  })

  it('两键相同：都标 duplicate 且一个都不注册', () => {
    const fake = fakeShortcuts()
    const handle = registerHotkeys(
      fake.shortcuts,
      actions(),
      { toggleCapture: 'Alt+P', openGraph: 'alt+p' },
      logSpy()
    )

    expect(fake.register).not.toHaveBeenCalled()
    expect(handle.results.map((result) => result.reason)).toEqual(['duplicate', 'duplicate'])
    expect(handle.isRegistered('toggleCapture')).toBe(false)
    expect(handle.isRegistered('openGraph')).toBe(false)
  })

  it('非法键：不注册、标 invalid，另一个键不受影响', () => {
    const fake = fakeShortcuts()
    const handle = registerHotkeys(
      fake.shortcuts,
      actions(),
      { toggleCapture: 'Alt+P', openGraph: 'Alt+' },
      logSpy()
    )

    expect(fake.register).toHaveBeenCalledTimes(1)
    expect(fake.register).toHaveBeenCalledWith('Alt+P', expect.any(Function))
    expect(handle.results).toEqual([
      { action: 'toggleCapture', accelerator: 'Alt+P', ok: true },
      { action: 'openGraph', accelerator: 'Alt+', ok: false, reason: 'invalid' }
    ])
  })

  it('reregister：先注销旧两键再注册新两键；dispose 只 unregisterAll 一次', () => {
    const fake = fakeShortcuts()
    const handle = registerHotkeys(fake.shortcuts, actions(), DEFAULT_HOTKEYS, logSpy())
    fake.register.mockClear()

    handle.reregister({ toggleCapture: 'Ctrl+Shift+P', openGraph: 'Ctrl+Shift+G' })

    expect(fake.unregister.mock.calls.map((call) => call[0])).toEqual(['Alt+P', 'Alt+Space'])
    expect(fake.register.mock.calls.map((call) => call[0])).toEqual([
      'Ctrl+Shift+P',
      'Ctrl+Shift+G'
    ])
    expect(handle.isRegistered('toggleCapture')).toBe(true)
    expect(handle.isRegistered('openGraph')).toBe(true)
    expect(fake.unregisterAll).not.toHaveBeenCalled()

    handle.dispose()
    expect(fake.unregisterAll).toHaveBeenCalledTimes(1)
  })
})
