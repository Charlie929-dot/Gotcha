import { describe, expect, it, vi } from 'vitest'
import {
  ensureStartupRegistration,
  setStartupEnabled,
  startupMarkerPath,
  STARTUP_MARKER_FILE,
  type StartupDeps
} from '../../src/main/startup'

function deps(overrides: Partial<StartupDeps> = {}): StartupDeps {
  return {
    packaged: true,
    userDataDir: 'C:\\Users\\HP\\AppData\\Roaming\\gotcha',
    getLoginItem: vi.fn(() => ({ openAtLogin: false })),
    setLoginItem: vi.fn(),
    exists: vi.fn(() => false),
    writeMarker: vi.fn(),
    log: vi.fn(),
    ...overrides
  }
}

describe('ensureStartupRegistration：首次打包启动注册开机自启', () => {
  it('开发态直接跳过：不写启动项、不落标记', () => {
    const d = deps({ packaged: false })
    expect(ensureStartupRegistration(d)).toBe('skip-dev')
    expect(d.setLoginItem).not.toHaveBeenCalled()
    expect(d.writeMarker).not.toHaveBeenCalled()
    expect(d.log).not.toHaveBeenCalled()
  })

  it('首次启动（无标记、系统里也没开）→ 写启动项 + 落标记', () => {
    const d = deps()
    expect(ensureStartupRegistration(d)).toBe('registered')
    expect(d.setLoginItem).toHaveBeenCalledWith(true)
    expect(d.writeMarker).toHaveBeenCalledWith(startupMarkerPath(d.userDataDir))
    expect(d.log).toHaveBeenCalledWith('startup registration ensured', expect.anything())
  })

  it('标记已在：不碰启动项（用户可能已在系统里关掉）', () => {
    const d = deps({ exists: vi.fn(() => true) })
    expect(ensureStartupRegistration(d)).toBe('already')
    expect(d.setLoginItem).not.toHaveBeenCalled()
    expect(d.writeMarker).not.toHaveBeenCalled()
  })

  it('无标记但系统里已开着：仍重写一次启动项把路径校正到当前 exe，再补标记', () => {
    const d = deps({ getLoginItem: vi.fn(() => ({ openAtLogin: true })) })
    expect(ensureStartupRegistration(d)).toBe('registered')
    expect(d.setLoginItem).toHaveBeenCalledWith(true)
    expect(d.writeMarker).toHaveBeenCalledTimes(1)
  })

  it('标记文件固定在 userData 下', () => {
    expect(STARTUP_MARKER_FILE).toBe('.startup-registered')
    expect(startupMarkerPath('C:\\data')).toBe('C:\\data\\.startup-registered')
  })
})

describe('setStartupEnabled：托盘勾选改系统启动项', () => {
  it('打开：写启动项并确保标记在（下次启动不被 ensure 改回）', () => {
    const d = deps()
    setStartupEnabled(d, true)
    expect(d.setLoginItem).toHaveBeenCalledWith(true)
    expect(d.writeMarker).toHaveBeenCalledTimes(1)
  })

  it('关闭：照写系统启动项；标记已在就不再落盘', () => {
    const d = deps({ exists: vi.fn(() => true) })
    setStartupEnabled(d, false)
    expect(d.setLoginItem).toHaveBeenCalledWith(false)
    expect(d.writeMarker).not.toHaveBeenCalled()
  })

  it('开发态不写系统启动项', () => {
    const d = deps({ packaged: false })
    setStartupEnabled(d, true)
    expect(d.setLoginItem).not.toHaveBeenCalled()
  })
})
