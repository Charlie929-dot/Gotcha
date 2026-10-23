/**
 * `userData/.env` 手写解析（M2 / D21）
 *
 * 不引 dotenv：只支持 `KEY=VALUE` 行、`#` 注释、可选 `export ` 前缀、
 * 成对单/双引号；不做变量展开。密钥只在本机文件 / 环境变量里，不落库、不落日志。
 */

import { readFileSync } from 'node:fs'

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** 解析 .env 文本；非法行（无 `=` / 空 key）跳过，不抛错 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue
    const value = unquote(withoutExport.slice(eq + 1).trim())
    result[key] = value
  }
  return result
}

/** 读取 .env 文件；不存在 / 读取失败 → 空对象（调用方回退进程环境变量） */
export function loadEnvFile(filePath: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}
