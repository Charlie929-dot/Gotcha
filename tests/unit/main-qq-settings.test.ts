/**
 * QQ 通道 · 设置（D63）
 *
 * 守三件事：
 * 1. 默认只听本机（`127.0.0.1`），「允许局域网」是显式布尔，不让渲染层写任意地址；
 * 2. 旧值 / 手改库里的非法 host 一律回落到回环，不放宽；
 * 3. token / 白名单 / 端口的校验是 fail-closed。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SETTINGS_DDL } from '../../src/db/schema'
import type { Db } from '../../src/db'
import {
  applyQqPatch,
  buildQqSettingsView,
  parseQqPatch,
  QQ_DEFAULT_HOST,
  QQ_DEFAULT_PORT,
  QQ_LAN_HOST,
  readQqConfig
} from '../../src/main/qq/qq-settings'

let db: Db

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SETTINGS_DDL)
})

afterEach(() => {
  db.close()
})

describe('qq 设置', () => {
  it('默认：关、只听 127.0.0.1、端口 8643、白名单空', () => {
    const config = readQqConfig(db)
    expect(config).toMatchObject({
      enabled: false,
      host: QQ_DEFAULT_HOST,
      port: QQ_DEFAULT_PORT,
      accessToken: '',
      allowUsers: [],
      replyMaxChars: 1_800
    })
    expect(buildQqSettingsView(db).allowLan).toBe(false)
  })

  it('allowLan 只收布尔：true → 0.0.0.0，false → 127.0.0.1', () => {
    const on = parseQqPatch({ allowLan: true })
    expect(on).toEqual({ ok: true, patch: { allowLan: true } })
    if (on.ok) applyQqPatch(db, on.patch)
    expect(readQqConfig(db).host).toBe(QQ_LAN_HOST)
    expect(buildQqSettingsView(db).allowLan).toBe(true)

    const off = parseQqPatch({ allowLan: false })
    if (off.ok) applyQqPatch(db, off.patch)
    expect(readQqConfig(db).host).toBe(QQ_DEFAULT_HOST)

    expect(parseQqPatch({ allowLan: 'yes' })).toEqual({ ok: false, error: '局域网开关必须是布尔值' })
  })

  it('库里存了别的 host（手改 / 旧版本）→ 回落到回环', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('qq.host', '0.0.0.1')").run()
    expect(readQqConfig(db).host).toBe(QQ_DEFAULT_HOST)
    expect(buildQqSettingsView(db).allowLan).toBe(false)
  })

  it('token / 端口 / 白名单 / 单条上限的校验', () => {
    expect(parseQqPatch({ accessToken: 'short' })).toEqual({
      ok: false,
      error: 'token 长度要在 8–128 之间'
    })
    expect(parseQqPatch({ accessToken: 'has space' })).toEqual({
      ok: false,
      error: 'token 不能包含空白'
    })
    expect(parseQqPatch({ port: 80 })).toEqual({ ok: false, error: '端口要在 1024–65535 之间' })
    expect(parseQqPatch({ allowUsers: 'abc' })).toEqual({
      ok: false,
      error: '白名单里只能是 5–12 位 QQ 号'
    })
    expect(parseQqPatch({ allowUsers: '123456789, 123456789' })).toEqual({
      ok: true,
      patch: { allowUsers: ['123456789'] }
    })
    expect(parseQqPatch({ replyMaxChars: 10 })).toEqual({
      ok: false,
      error: '单条长度要在 200–4500 之间'
    })
    expect(parseQqPatch({})).toEqual({ ok: false, error: '没有要保存的改动' })
    expect(parseQqPatch(null)).toEqual({ ok: false, error: '设置格式不对' })
  })
})
