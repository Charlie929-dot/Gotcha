/**
 * 设置抽屉「记忆仓」（D90）
 *
 * 守四件事：
 * 1. 地址只认 https / ssh，且不收带凭据的 URL（令牌不进设置、不进仓配置）；
 * 2. patch 的间隔经过钳制（0 = 关，上限一天）；
 * 3. 绑定失败时**不动**间隔设置（避免「地址没绑上、定时器已经在推」）；
 * 4. 仓不可用时界面仍能回显间隔（只是 available=false）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openDatabase, type Db } from '../../src/db'
import { getSetting } from '../../src/db/settings'
import { validateRemoteUrl } from '../../src/main/memory-repo'
import {
  MEMORY_COMMIT_MINUTES_KEY,
  MEMORY_PUSH_MINUTES_KEY,
  applyMemoryRepoPatch,
  buildMemoryRepoSettingsView,
  parseMemoryRepoPatch,
  readMemorySchedule
} from '../../src/main/memory-repo-settings'

describe('远端地址校验', () => {
  it('https / ssh 都认，.git 后缀可有可无', () => {
    expect(validateRemoteUrl('https://github.com/someone/gotcha-memory.git')).toEqual({
      ok: true,
      url: 'https://github.com/someone/gotcha-memory.git'
    })
    expect(validateRemoteUrl('  https://gitee.com/someone/mem  ')).toEqual({
      ok: true,
      url: 'https://gitee.com/someone/mem'
    })
    expect(validateRemoteUrl('git@github.com:someone/gotcha-memory.git').ok).toBe(true)
    expect(validateRemoteUrl('ssh://git@example.com/someone/mem.git').ok).toBe(true)
  })

  it('空 / 明文 http / 带凭据 / 带空白或控制字符 一律拒', () => {
    expect(validateRemoteUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateRemoteUrl('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(validateRemoteUrl('http://github.com/a/b.git')).toEqual({ ok: false, reason: 'invalid' })
    // 地址里夹令牌 = 把密钥写进仓配置，必须拒
    expect(validateRemoteUrl('https://user:ghp_xxx@github.com/a/b.git')).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(validateRemoteUrl('https://github.com/a/b.git\n--upload-pack=calc')).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(validateRemoteUrl('-u origin')).toEqual({ ok: false, reason: 'invalid' })
    expect(validateRemoteUrl(`https://github.com/a/${'x'.repeat(500)}`)).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })
})

describe('patch 解析与钳制', () => {
  it('合法 patch 原样落地', () => {
    expect(parseMemoryRepoPatch({ commitMinutes: 5, pushMinutes: 0 })).toEqual({
      ok: true,
      value: { commitMinutes: 5, pushMinutes: 0 }
    })
  })

  it('空地址 / 非数字间隔 直接报错，不静默丢', () => {
    expect(parseMemoryRepoPatch({ remote: '' }).ok).toBe(false)
    expect(parseMemoryRepoPatch({ remote: 'http://x/y' }).ok).toBe(false)
    expect(parseMemoryRepoPatch({ commitMinutes: 'ten' }).ok).toBe(false)
    expect(parseMemoryRepoPatch(null).ok).toBe(false)
  })

  it('间隔按上限钳住', () => {
    const parsed = parseMemoryRepoPatch({ commitMinutes: 99_999 })
    expect(parsed).toEqual({ ok: true, value: { commitMinutes: 24 * 60 } })
  })
})

describe('读写设置表', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('缺省 = 10 / 30；存过就以存的为准', () => {
    expect(readMemorySchedule(db)).toEqual({ commitMinutes: 10, pushMinutes: 30 })
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      MEMORY_COMMIT_MINUTES_KEY,
      '0'
    )
    expect(readMemorySchedule(db)).toEqual({ commitMinutes: 0, pushMinutes: 30 })
  })

  it('绑定成功才写间隔；绑定失败时设置一个都不动', async () => {
    const setRemote = vi.fn(async () => ({ ok: true as const, url: 'https://github.com/a/b.git' }))
    const saved = await applyMemoryRepoPatch(
      { db, setRemote },
      { remote: 'https://github.com/a/b.git', commitMinutes: 15, pushMinutes: 45 }
    )
    expect(saved.ok).toBe(true)
    expect(setRemote).toHaveBeenCalledWith('https://github.com/a/b.git')
    expect(getSetting(db, MEMORY_COMMIT_MINUTES_KEY)).toBe('15')
    expect(getSetting(db, MEMORY_PUSH_MINUTES_KEY)).toBe('45')

    const failing = vi.fn(async () => ({ ok: false as const, reason: 'failed' as const, detail: 'denied' }))
    const failed = await applyMemoryRepoPatch(
      { db, setRemote: failing },
      { remote: 'https://github.com/a/c.git', commitMinutes: 1, pushMinutes: 2 }
    )
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('denied')
    expect(getSetting(db, MEMORY_COMMIT_MINUTES_KEY)).toBe('15')
    expect(getSetting(db, MEMORY_PUSH_MINUTES_KEY)).toBe('45')
  })

  it('仓不可用：available=false，但间隔照常回显', async () => {
    const view = await buildMemoryRepoSettingsView({
      db,
      pushState: async () => ({ ok: false, reason: 'unavailable' })
    })
    expect(view.available).toBe(false)
    expect(view.commitMinutes).toBe(10)
    expect(view.pushMinutes).toBe(30)
  })

  it('仓可用：远端 / 分支 / 未推送 / 上次推送都带出来', async () => {
    const view = await buildMemoryRepoSettingsView({
      db,
      pushState: async () => ({
        ok: true,
        remote: 'https://github.com/a/b.git',
        branch: 'default',
        dirty: true,
        ahead: 3,
        lastPush: { ok: false, reason: 'failed', at: 1 }
      })
    })
    expect(view).toMatchObject({
      available: true,
      remote: 'https://github.com/a/b.git',
      branch: 'default',
      dirty: true,
      ahead: 3,
      lastPush: { ok: false, reason: 'failed' }
    })
  })
})
