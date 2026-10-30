/**
 * QQ 通道 · 设置（D63）
 *
 * 和 `memory-settings.ts` 同一个套路：渲染层只传 patch，这里校验成合法值；
 * 读写都走 settings 表（不建新表、不改 schema），视图现读不缓存。
 *
 * 安全口径：
 * - 默认**关闭**；开启必须同时有 access_token（≥8 位）与非空白名单；
 * - token 存在本机 settings 表里（用户自己的数据目录），只回给本地设置抽屉，
 *   **绝不写日志、不进错信息**。
 */

import type { Db } from '../../db'
import { getSetting, setSetting } from '../../db/settings'
import {
  QQ_REPLY_DEFAULT_CHARS,
  QQ_REPLY_MAX_CHARS,
  QQ_REPLY_MIN_CHARS,
  type QqChannelConfig,
  type QqChannelStatus
} from './channel'

export const QQ_SETTING_KEYS = {
  enabled: 'qq.enabled',
  host: 'qq.host',
  port: 'qq.port',
  accessToken: 'qq.access_token',
  allowUsers: 'qq.allow_users',
  replyMaxChars: 'qq.reply_max_chars'
} as const

export const QQ_DEFAULT_PORT = 8643
/** 默认只听本机回环；「允许局域网」= `0.0.0.0`（给 NapCat 在另一台机器时用） */
export const QQ_DEFAULT_HOST = '127.0.0.1'
export const QQ_LAN_HOST = '0.0.0.0'
/** 端口下限：1024 以下要管理员权限，别让用户在这里踩坑 */
export const QQ_MIN_PORT = 1024
export const QQ_MAX_PORT = 65_535
export const QQ_MIN_TOKEN_CHARS = 8
export const QQ_MAX_TOKEN_CHARS = 128
export const QQ_MAX_ALLOW_USERS = 20

export interface QqSettingsView {
  enabled: boolean
  /** 是否允许局域网访问（存的是 0.0.0.0；界面只给开关，不给任意地址） */
  allowLan: boolean
  port: number
  accessToken: string
  allowUsers: string[]
  replyMaxChars: number
  running: boolean
  connections: number
  lastError?: string
}

export interface QqSettingsPatch {
  enabled?: boolean
  /** 只接受布尔：false → 127.0.0.1，true → 0.0.0.0（不让渲染层直接写任意地址） */
  allowLan?: boolean
  port?: number
  accessToken?: string
  allowUsers?: string[]
  replyMaxChars?: number
}

export type QqSettingsSaveResult =
  | { ok: true; view: QqSettingsView }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** QQ 号：5–12 位数字（不校验是否真实存在） */
export function normalizeAllowUser(raw: string): string | null {
  const text = raw.trim()
  return /^\d{5,12}$/u.test(text) ? text : null
}

/** 逗号 / 空格 / 换行分隔的名单 → 去重后的字符串数组（**宽松**：读库用，非法项丢掉） */
export function parseAllowUsers(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[\s,，;；]+/u)) {
    const user = normalizeAllowUser(piece)
    if (user !== null && !out.includes(user)) out.push(user)
  }
  return out
}

/**
 * 保存设置用的**严格**解析：有一项不是 5–12 位 QQ 号就返回 'invalid'。
 * 宽松版会把「填错一个字」静默变成空名单，用户会以为存好了、实际通道不起——
 * 所以保存路径必须报错（2026-10-30 单测抓到的）。
 */
export function parseAllowUsersStrict(raw: string): string[] | 'invalid' {
  const out: string[] = []
  for (const piece of raw.split(/[\s,，;；]+/u)) {
    if (piece === '') continue
    const user = normalizeAllowUser(piece)
    if (user === null) return 'invalid'
    if (!out.includes(user)) out.push(user)
  }
  return out
}

export function parseQqPatch(raw: unknown): { ok: true; patch: QqSettingsPatch } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: '设置格式不对' }
  const patch: QqSettingsPatch = {}

  if ('enabled' in raw) {
    if (typeof raw['enabled'] !== 'boolean') return { ok: false, error: '开关必须是布尔值' }
    patch.enabled = raw['enabled']
  }
  if ('allowLan' in raw) {
    if (typeof raw['allowLan'] !== 'boolean') return { ok: false, error: '局域网开关必须是布尔值' }
    patch.allowLan = raw['allowLan']
  }
  if ('port' in raw) {
    const port = Number(raw['port'])
    if (!Number.isInteger(port) || port < QQ_MIN_PORT || port > QQ_MAX_PORT) {
      return { ok: false, error: `端口要在 ${QQ_MIN_PORT}–${QQ_MAX_PORT} 之间` }
    }
    patch.port = port
  }
  if ('accessToken' in raw) {
    if (typeof raw['accessToken'] !== 'string') return { ok: false, error: 'token 必须是字符串' }
    const token = raw['accessToken'].trim()
    if (token !== '' && (token.length < QQ_MIN_TOKEN_CHARS || token.length > QQ_MAX_TOKEN_CHARS)) {
      return { ok: false, error: `token 长度要在 ${QQ_MIN_TOKEN_CHARS}–${QQ_MAX_TOKEN_CHARS} 之间` }
    }
    if (/\s/u.test(token)) return { ok: false, error: 'token 不能包含空白' }
    patch.accessToken = token
  }
  if ('allowUsers' in raw) {
    const value = raw['allowUsers']
    const list = typeof value === 'string' ? parseAllowUsersStrict(value) : Array.isArray(value) ? dedupeUsers(value) : null
    if (list === null) return { ok: false, error: '白名单格式不对' }
    if (list === 'invalid') return { ok: false, error: '白名单里只能是 5–12 位 QQ 号' }
    if (list.length > QQ_MAX_ALLOW_USERS) {
      return { ok: false, error: `白名单最多 ${QQ_MAX_ALLOW_USERS} 个` }
    }
    patch.allowUsers = list
  }
  if ('replyMaxChars' in raw) {
    const chars = Number(raw['replyMaxChars'])
    if (!Number.isInteger(chars) || chars < QQ_REPLY_MIN_CHARS || chars > QQ_REPLY_MAX_CHARS) {
      return { ok: false, error: `单条长度要在 ${QQ_REPLY_MIN_CHARS}–${QQ_REPLY_MAX_CHARS} 之间` }
    }
    patch.replyMaxChars = chars
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: '没有要保存的改动' }
  return { ok: true, patch }
}

function dedupeUsers(value: readonly unknown[]): string[] | 'invalid' {
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return 'invalid'
    const user = normalizeAllowUser(item)
    if (user === null) return 'invalid'
    if (!out.includes(user)) out.push(user)
  }
  return out
}

export function applyQqPatch(db: Db, patch: QqSettingsPatch): void {
  if (patch.enabled !== undefined) setSetting(db, QQ_SETTING_KEYS.enabled, patch.enabled ? '1' : '0')
  if (patch.allowLan !== undefined) {
    setSetting(db, QQ_SETTING_KEYS.host, patch.allowLan ? QQ_LAN_HOST : QQ_DEFAULT_HOST)
  }
  if (patch.port !== undefined) setSetting(db, QQ_SETTING_KEYS.port, String(patch.port))
  if (patch.accessToken !== undefined) setSetting(db, QQ_SETTING_KEYS.accessToken, patch.accessToken)
  if (patch.allowUsers !== undefined) setSetting(db, QQ_SETTING_KEYS.allowUsers, patch.allowUsers.join(','))
  if (patch.replyMaxChars !== undefined) {
    setSetting(db, QQ_SETTING_KEYS.replyMaxChars, String(patch.replyMaxChars))
  }
}

/** settings 表 → 通道配置（缺省值在这里补齐；不在这里判断「能不能开」） */
export function readQqConfig(db: Db): QqChannelConfig {
  const port = Number(getSetting(db, QQ_SETTING_KEYS.port))
  const replyMaxChars = Number(getSetting(db, QQ_SETTING_KEYS.replyMaxChars))
  const storedHost = getSetting(db, QQ_SETTING_KEYS.host).trim()
  return {
    enabled: getSetting(db, QQ_SETTING_KEYS.enabled) === '1',
    // 只认两个值：存了别的（手改库 / 旧版本）一律回到回环，不放宽
    host: storedHost === QQ_LAN_HOST ? QQ_LAN_HOST : QQ_DEFAULT_HOST,
    port: Number.isInteger(port) && port >= QQ_MIN_PORT && port <= QQ_MAX_PORT ? port : QQ_DEFAULT_PORT,
    accessToken: getSetting(db, QQ_SETTING_KEYS.accessToken).trim(),
    allowUsers: parseAllowUsers(getSetting(db, QQ_SETTING_KEYS.allowUsers)),
    replyMaxChars:
      Number.isInteger(replyMaxChars) &&
      replyMaxChars >= QQ_REPLY_MIN_CHARS &&
      replyMaxChars <= QQ_REPLY_MAX_CHARS
        ? replyMaxChars
        : QQ_REPLY_DEFAULT_CHARS
  }
}

export function buildQqSettingsView(db: Db, status?: QqChannelStatus): QqSettingsView {
  const config = readQqConfig(db)
  return {
    enabled: config.enabled,
    allowLan: config.host === QQ_LAN_HOST,
    port: config.port,
    accessToken: config.accessToken,
    allowUsers: [...config.allowUsers],
    replyMaxChars: config.replyMaxChars,
    running: status?.running ?? false,
    connections: status?.connections ?? 0,
    ...(status?.lastError !== undefined ? { lastError: status.lastError } : {})
  }
}
