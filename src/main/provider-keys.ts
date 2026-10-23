/**
 * 供应商 API Key 写盘（M2 Phase 2 设置界面 / D21 补充）
 *
 * - 设置界面直接填写的密钥由主进程写入 `userData/.env`，与手写 `.env` 同一份读取路径：
 *   密钥仍然不进 settings 表、不进日志、不回显到渲染进程；
 * - 写入前校验变量名与密钥形态；改写时保留文件里其它行（注释 / 其它变量）并原子替换；
 * - 文件权限尽力设为 0600（Windows 上不保证，失败不阻断写入，也不影响读取）。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 常见 API Key 远短于此；上限防止误粘整段文本 */
export const MAX_API_KEY_LENGTH = 512

export function isValidKeyName(name: string): boolean {
  return KEY_NAME_RE.test(name)
}

export type ApiKeyValidation = { ok: true; key: string } | { ok: false; error: string }

/** 校验用户输入的密钥：非空、无空白 / 控制字符、长度受限（不校验具体格式） */
export function validateApiKey(value: unknown): ApiKeyValidation {
  if (typeof value !== 'string') return { ok: false, error: 'API Key 必须是字符串' }
  const key = value.trim()
  if (key === '') return { ok: false, error: 'API Key 不能为空' }
  if (key.length > MAX_API_KEY_LENGTH) {
    return { ok: false, error: `API Key 过长（上限 ${MAX_API_KEY_LENGTH} 字符）` }
  }
  if (/[\s\u0000-\u001f\u007f]/.test(key)) {
    return { ok: false, error: 'API Key 不能包含空白或控制字符' }
  }
  return { ok: true, key }
}

/**
 * 在 `.env` 文本里插入 / 替换一条 `NAME=value`。
 * 命中已有行（含 `export NAME=` 写法）时原位替换；重复同名行只保留改写后的那一条
 * （解析器后者覆盖前者，留着旧行会让新密钥看起来「没生效」）；没有则追加到末尾。
 */
export function upsertEnvEntry(content: string, name: string, value: string): string {
  if (!KEY_NAME_RE.test(name)) throw new Error('invalid env key name')
  const line = `${name}=${value}`
  const lines = content === '' ? [] : content.split(/\r?\n/)
  const existing = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`)
  let replaced = false
  const next: string[] = []
  for (const raw of lines) {
    if (existing.test(raw)) {
      if (!replaced) {
        next.push(line)
        replaced = true
      }
      // 重复的同名行丢弃：否则 .env 解析时旧值会覆盖新值
    } else {
      next.push(raw)
    }
  }
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
    next.push(line)
  }
  return `${next.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * 把密钥写入 `.env`（不存在则创建）。先写同目录临时文件再 rename，避免半截文件。
 * 任何失败都抛错，由调用方转成面向用户的短消息（不带文件内容）。
 */
export function writeEnvKey(filePath: string, name: string, value: string): void {
  if (!KEY_NAME_RE.test(name)) throw new Error('invalid env key name')
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  let existing = ''
  try {
    existing = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const content = upsertEnvEntry(existing, name, value)
  const tmpPath = join(dir, `.env.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 临时文件清理失败不改变原始错误
    }
    throw error
  }
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Windows 上 chmod 支持有限；权限收紧失败不阻断（密钥仍只在 userData 内）
  }
}
