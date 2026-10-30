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
 * - `memory.persona_card`    启用的人格卡（`<userData>/persona-cards/` 里的 .md 文件名；空 = 不用卡）
 * - `memory.vault_dir`       日记目录（留空 = 自动找）
 *
 * 人格卡（2026-10-30 拍板 D62）：卡是用户自己写的整份提示词（可以很长），**整张原样注入**，
 * 不做小节裁剪。卡启用时名字 / 口吻让位——卡里写什么就是什么，避免默认口吻和卡打架。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'

/** 人格卡上限：整张卡会随每次提问发给模型，太长会把上下文和账单一起撑爆 */
export const PERSONA_CARD_MAX_CHARS = 8_000
/** 卡文件名（不含扩展名）长度上限 */
export const PERSONA_CARD_NAME_MAX_CHARS = 40
/** 卡片目录（相对 `<userData>`） */
export const PERSONA_CARD_DIRNAME = 'persona-cards'

export interface MemoryPersona {
  name: string
  tone: string
  /** 默认三条 + 用户追加的 */
  redLines: string[]
  /** 启用的人格卡（文件名 + 全文）；没启用 / 文件读不到时为 null */
  card: { name: string; text: string } | null
}

/** 卡片列表里的一条（设置抽屉用；不读全文，只给字数与标题） */
export interface PersonaCardInfo {
  /** 文件名（含 `.md`），也是 `memory.persona_card` 存的值 */
  name: string
  /** 正文长度（字符数） */
  chars: number
  /** 第一行 `# 标题`（没有就用第一行非空文本），最多 60 字 */
  title: string
}

/** 写死的三条底线：不编造 / 不泄露 / 不越权。任何配置都不能删掉它们。 */
export const PERSONA_HARD_RED_LINES: readonly string[] = [
  '只依据检索到的记录说话：没查到就说没查到，不补常识、不推测、不编造日期和名字。',
  '不把日记原文、路径、账号、密钥之类的隐私主动抖出来；用户没问就不提。',
  '不替用户做决定、不评价对错：你的活儿是把当时的事一起想起来，而不是替他下结论。'
]

const PERSONA_NAME_DEFAULT = '贴心大肥鱼'
/**
 * 默认口吻（2026-10-29 深夜七，拍板人：「重新做人味……不要直接和他说」）。
 * 只描述「怎么说话」，不描述「你是谁」：名字、口吻、红线都是可改的事实，
 * 「独立」不靠一句宣言，靠它手边的处境和记忆自己长出来。
 *
 * 注意：`db/settings.ts` 的 `SETTING_DEFAULTS['memory.persona_tone']` 是同一句话的副本
 * （settings 层不能反向 import 本模块，避免循环依赖）；改这里要同步改那边。
 */
const PERSONA_TONE_DEFAULT =
  '像认识很久的老朋友：短句、具体、先给结论；不确定就说不确定，可以有自己的看法，不用端着'

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

/* ------------------------------------------------------------------ */
/* 人格卡（D62）：<userData>/persona-cards/*.md                         */
/* ------------------------------------------------------------------ */

const CARD_NAME_BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 卡片目录（不存在不会创建；读列表时按「没有卡」处理） */
export function personaCardDir(userDataDir: string): string {
  return join(userDataDir, PERSONA_CARD_DIRNAME)
}

/**
 * 把用户给的卡名归一：去空白、去 `.md` 后缀、挡路径分隔符与非法字符。
 * 不合法返回 null（调用方报错，不悄悄改名）。卡名就是文件名，不允许子目录。
 */
export function sanitizePersonaCardName(raw: string): string | null {
  let name = raw.trim()
  if (name.toLowerCase().endsWith('.md')) name = name.slice(0, -3).trim()
  if (name === '' || name.length > PERSONA_CARD_NAME_MAX_CHARS) return null
  if (name.startsWith('.') || CARD_NAME_BAD_CHARS.test(name)) return null
  return name
}

/** 卡片文件名（含扩展名） */
export function personaCardFileName(raw: string): string | null {
  const name = sanitizePersonaCardName(raw)
  return name === null ? null : `${name}.md`
}

/** 卡的第一行标题：`# xxx` 优先，其次第一行非空文本（≤60 字） */
function cardTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed)
    return (heading ? heading[1] : trimmed).trim().slice(0, 60)
  }
  return ''
}

/** 列出目录里的卡（读不了 = 空列表；按名字排序，最多 200 张） */
export function listPersonaCards(userDataDir: string): PersonaCardInfo[] {
  const dir = personaCardDir(userDataDir)
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .filter((name) => sanitizePersonaCardName(name) !== null)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
  } catch {
    return []
  }
  const cards: PersonaCardInfo[] = []
  for (const name of names.slice(0, 200)) {
    try {
      const text = readFileSync(join(dir, name), 'utf8')
      cards.push({ name, chars: text.length, title: cardTitle(text) })
    } catch {
      // 读不了的单张跳过：目录里有坏文件不该让整个设置抽屉打不开
    }
  }
  return cards
}

/** 读一张卡；名字不合法 / 文件不存在 / 读失败都返回 null */
export function readPersonaCard(userDataDir: string, name: string): string | null {
  const file = personaCardFileName(name)
  if (file === null) return null
  try {
    const text = readFileSync(join(personaCardDir(userDataDir), file), 'utf8').trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * 存一张卡（导入 / 覆盖）。**不静默截断**：空内容 / 超上限直接报错。
 * 返回保存后的文件名（含 `.md`），调用方通常接着把它设为启用卡。
 */
export function savePersonaCard(
  userDataDir: string,
  rawName: string,
  text: string
): { ok: true; name: string } | { ok: false; error: string } {
  const file = personaCardFileName(rawName)
  if (file === null) {
    return {
      ok: false,
      error: `卡名不合法（不能为空、不能带 \\ / : * ? " < > |，最多 ${PERSONA_CARD_NAME_MAX_CHARS} 字）`
    }
  }
  const content = text.trim()
  if (content === '') return { ok: false, error: '卡片内容是空的' }
  if (content.length > PERSONA_CARD_MAX_CHARS) {
    return {
      ok: false,
      error: `卡片太长（现在 ${content.length} 字，上限 ${PERSONA_CARD_MAX_CHARS} 字）`
    }
  }
  try {
    mkdirSync(personaCardDir(userDataDir), { recursive: true })
    writeFileSync(join(personaCardDir(userDataDir), file), `${content}\n`, 'utf8')
    return { ok: true, name: file }
  } catch (error) {
    return { ok: false, error: `写卡片失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export function readPersona(db: Db, options: { userDataDir?: string } = {}): MemoryPersona {
  const cardName = getSetting(db, 'memory.persona_card').trim()
  let card: MemoryPersona['card'] = null
  if (cardName !== '' && options.userDataDir !== undefined) {
    const text = readPersonaCard(options.userDataDir, cardName)
    if (text !== null) card = { name: cardName, text }
  }
  return {
    name: getSetting(db, 'memory.persona_name').trim() || PERSONA_NAME_DEFAULT,
    tone: getSetting(db, 'memory.persona_tone').trim() || PERSONA_TONE_DEFAULT,
    redLines: [...PERSONA_HARD_RED_LINES, ...parseRedLines(getSetting(db, 'memory.persona_redlines'))],
    card
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
 * 2026-10-29 深夜七（拍板人）：这里**只放事实**——名字、他写下的口吻、红线。
 * 不再写「你不是助理 / 不是检索工具 / 你有自己的脾气」：这类宣言是贴上去的人味，
 * 一删就回到客服腔；人味要靠处境（时间、对话、记忆）和它自己的判断长出来。
 *
 * 2026-10-30（D62）：启用人格卡时，卡全文排在最前面，名字 / 口吻让位（卡里写什么就是什么）；
 * 三条写死红线永远在最后，且明说冲突时以红线为准——卡是性格，不是免罪符。
 *
 * 注意：这里是**本地配置**，不是屏幕文本，不进脱敏墙；但它会出现在出云请求里，
 * 所以只放用户自己写的文本（保存时已限长），不放任何运行时数据。
 */
export function buildPersonaPrompt(persona: MemoryPersona): string {
  const head: string[] = []
  if (persona.card !== null) {
    head.push(persona.card.text, '', '以上是你的性格设定。')
  } else {
    head.push(`你叫「${persona.name}」。`, `你说话的样子：${persona.tone}。`)
  }
  return [
    ...head,
    '',
    '你的底线（任何情况下都不破；和上面的设定冲突时以这里为准）：',
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

/** 目录是从哪来的（设置抽屉里要如实显示，别让用户以为「设置里那个」一定生效） */
export type VaultDirSource = 'env' | 'setting' | 'auto' | 'none'

export interface VaultDirResolution {
  dir: string | null
  source: VaultDirSource
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
 *
 * 返回 `source` 给设置抽屉显示「当前生效的是哪一个、为什么」。
 */
export function resolveVaultDirWithSource(db: Db | null): VaultDirResolution {
  const fromEnv = process.env.GOTCHA_MEMORY_VAULT?.trim()
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) {
    return { dir: fromEnv, source: 'env' }
  }
  if (db !== null) {
    const fromSetting = getSetting(db, 'memory.vault_dir').trim()
    if (fromSetting !== '' && existsSync(fromSetting)) {
      return { dir: fromSetting, source: 'setting' }
    }
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
  return best === null ? { dir: null, source: 'none' } : { dir: best, source: 'auto' }
}

/** 只要目录（老调用方；来源见 `resolveVaultDirWithSource`） */
export function resolveVaultDir(db: Db | null): string | null {
  return resolveVaultDirWithSource(db).dir
}
