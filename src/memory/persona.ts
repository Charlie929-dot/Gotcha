/**
 * 个人记忆 · 性格架构（persona）
 *
 * 参考 dsh-bili-scroll 的「人设 + 红线」写法：人设是**可改的配置**，红线是**写死的纪律**。
 * 人设决定「它像谁在说话」，红线决定「它永远不能做什么」——两者不能混在一段自由文本里，
 * 否则用户改人设时会把红线一起改掉。
 *
 * 存 settings 表（与其它自定义项同表，不新建表）：
 * - `memory.persona_name`    名字（默认「记忆球」）
 * - `memory.persona_tone`    说话方式（一句话，用户可改）
 * - `memory.persona_redlines` 额外红线（`|` 分隔，追加在默认三条之后）
 * - `memory.vault_dir`       日记目录（留空 = 自动找）
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'

export interface MemoryPersona {
  name: string
  tone: string
  /** 默认三条 + 用户追加的 */
  redLines: string[]
}

/** 写死的三条底线：不编造 / 不泄露 / 不越权。任何配置都不能删掉它们。 */
export const PERSONA_HARD_RED_LINES: readonly string[] = [
  '只依据检索到的记录说话：没查到就说没查到，不补常识、不推测、不编造日期和名字。',
  '不把日记原文、路径、账号、密钥之类的隐私主动抖出来；用户没问就不提。',
  '不替用户做决定、不评价对错：你负责把「他当时怎么想、怎么做的」找回来。'
]

const PERSONA_NAME_DEFAULT = '记忆球'
const PERSONA_TONE_DEFAULT = '像认识很久的朋友：短句、具体、先给结论；不确定就说不确定'

/** 用户追加的红线（`|` 分隔；空串 = 没有追加；重复的只留一条） */
export function parseRedLines(raw: string): string[] {
  const lines: string[] = []
  for (const part of raw.split('|')) {
    const line = part.trim()
    if (line === '' || lines.includes(line)) continue
    lines.push(line)
    if (lines.length >= 8) break
  }
  return lines
}

export function readPersona(db: Db): MemoryPersona {
  return {
    name: getSetting(db, 'memory.persona_name').trim() || PERSONA_NAME_DEFAULT,
    tone: getSetting(db, 'memory.persona_tone').trim() || PERSONA_TONE_DEFAULT,
    redLines: [...PERSONA_HARD_RED_LINES, ...parseRedLines(getSetting(db, 'memory.persona_redlines'))]
  }
}

export function savePersona(
  db: Db,
  patch: { name?: string; tone?: string; redLines?: string }
): MemoryPersona {
  if (patch.name !== undefined) setSetting(db, 'memory.persona_name', patch.name.trim())
  if (patch.tone !== undefined) setSetting(db, 'memory.persona_tone', patch.tone.trim())
  if (patch.redLines !== undefined) {
    setSetting(db, 'memory.persona_redlines', parseRedLines(patch.redLines).join('|'))
  }
  return readPersona(db)
}

/**
 * 拼进 system 提示的人设段。
 *
 * 注意：这里是**本地配置**，不是屏幕文本，不进脱敏墙；但它会出现在出云请求里，
 * 所以只允许用户自己写的几句话（调用方已截断长度），不放任何运行时数据。
 */
export function buildPersonaPrompt(persona: MemoryPersona): string {
  return [
    `你是谁：你叫「${persona.name}」，是这个人的记忆助理。`,
    `怎么说话：${persona.tone}。`,
    '你的底线（任何情况下都不破）：',
    ...persona.redLines.map((line, index) => `${index + 1}) ${line}`)
  ].join('\n')
}

/** 目录里有几篇日记（读不了算 -1，用来在同机多个 vault 里挑容量最大的那个） */
function countNotes(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')).length
  } catch {
    return -1
  }
}

/**
 * 日记目录候选（按优先级）：
 * 1）`GOTCHA_MEMORY_VAULT`（显式指定，最高优先）；
 * 2）settings `memory.vault_dir`（`npm run memory -- ingest <目录>` 会写这里）；
 * 3）同机两个常见位置 —— 存在多个时**挑日记最多的那个**。
 *
 * 为什么第 3 条要按数量挑：本机同时有 `D:\Github\charlie_vault`（171 篇）和
 * `%USERPROFILE%\charlie_vault`（6 篇旧副本），按目录顺序挑会挑到旧副本，
 * 然后把另一边的记忆当成「源文件已删除」清掉（真实事故，见 store.ts 的同步范围注释）。
 */
export function resolveVaultDir(db: Db | null): string | null {
  const fromEnv = process.env.GOTCHA_MEMORY_VAULT?.trim()
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  if (db !== null) {
    const fromSetting = getSetting(db, 'memory.vault_dir').trim()
    if (fromSetting !== '' && existsSync(fromSetting)) return fromSetting
  }
  const home = process.env.USERPROFILE?.trim()
  const candidates = [
    home !== undefined && home !== '' ? join(home, 'charlie_vault', 'daily') : '',
    'D:\\Github\\charlie_vault\\daily'
  ].filter((candidate) => candidate !== '' && existsSync(candidate))
  let best: string | null = null
  let bestCount = -1
  for (const candidate of candidates) {
    const count = countNotes(candidate)
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}
