import { describe, expect, it } from 'vitest'
import { executableName, isBlacklisted } from '../../src/capture/window-meta'

describe('window-meta · 黑名单（只记元数据）', () => {
  it('取路径末段并小写', () => {
    expect(executableName('C:\\Program Files\\Firefox\\firefox.exe')).toBe('firefox.exe')
    expect(executableName('/opt/app')).toBe('app')
  })

  it('默认黑名单命中密码管理器', () => {
    for (const exe of ['1password.exe', 'KeePass.exe', 'bitwarden.exe', 'LastPass.exe']) {
      expect(isBlacklisted(exe), exe).toBe(true)
    }
    expect(isBlacklisted('notepad.exe')).toBe(false)
    expect(isBlacklisted('firefox.exe')).toBe(false)
  })

  it('接受无 .exe 写法与自定义名单', () => {
    expect(isBlacklisted('keepass')).toBe(true)
    expect(isBlacklisted('banking.exe', ['banking'])).toBe(true)
    expect(isBlacklisted('banking.exe', ['other.exe'])).toBe(false)
  })
})
