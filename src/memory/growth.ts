/**
 * 成长档案 · ta 自己的日记与周记（自调用 v0.2 §8 / §12.3，2026-11-01）
 *
 * 载体：**记忆仓里的 `growth/` 目录**（`growth/daily/YYYY-MM-DD.md`、
 * `growth/weekly/YYYY-Www.md`）。三条边界：
 *
 * 1. 只写 ta 自己的记忆仓库——用户 Obsidian 的日记一个字节都不碰（计划区是唯一例外，
 *    而且由计划同步器写）；
 * 2. 跟着记忆仓的分支走：换节点就是换一个人，成长档案不串；
 * 3. 每轮上下文**不注入**全文（§8）：只有少量结论回流小本本，原文留在这里，想看再翻。
 *
 * 这一层只做文件内容（键、标题、解析、序列化、有界、列表），不碰链层 / 主进程；
 * 要不要出云、怎么过脱敏，由上层决定。
 *
 * 文件格式（代码维护；人也可以直接改）：
 *
 * ```md
 * # 2026-11-01（周六）
 *
 * 正文……
 * ```
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/* ------------------------------------------------------------------ */
/* 类型与上限                                                          */
/* ------------------------------------------------------------------ */

export const GROWTH_KINDS = ['daily', 'weekly'] as const
export type GrowthKind = (typeof GROWTH_KINDS)[number]

/** 日记一天一篇：太长就不是日记了，让 ta 挑重点（不静默截断） */
export const GROWTH_DAILY_MAX_CHARS = 1200
/** 周记一篇一周：比日记长一点，但仍然有界 */
export const GROWTH_WEEKLY_MAX_CHARS = 2000
/** 记忆仓里的目录名 */
export const GROWTH_DIR_NAME = 'growth'
export const GROWTH_DAILY_DIR = 'daily'
export const GROWTH_WEEKLY_DIR = 'weekly'

export interface GrowthEntry {
  kind: GrowthKind
  /** `2026-11-01`（日记）/ `2026-W44`（周记） */
  key: string
  /** 文件第一行标题（人话） */
  title: string
  /** 正文（不含标题） */
  body: string
  /** 相对记忆仓的路径，如 `growth/daily/2026-11-01.md` */
  path: string
}

export interface GrowthWriteOk {
  ok: true
  entry: GrowthEntry
  /** 之前就有这一篇（重写 = 覆盖，不追加，重试也不会写出两份） */
  replaced: boolean
  message: string
}

export interface GrowthWriteError {
  ok: false
  message: string
}

export type GrowthWriteOutcome = GrowthWriteOk | GrowthWriteError

/* ------------------------------------------------------------------ */
/* 时间键（本地日 / ISO 周）                                            */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
const DAILY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u
const WEEKLY_KEY_RE = /^(\d{4})-W(\d{2})$/u

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地日 `YYYY-MM-DD`（与计划同步 / 提交主题同一个日历口径） */
export function localDayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** ISO-8601 周：周一为一周第一天；跨年按 ISO 归属（12-31 可能属于下一年的第 1 周） */
export function isoWeekOf(ts: number): { year: number; week: number } {
  const date = new Date(ts)
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay()
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum)
  const year = utc.getUTCFullYear()
  const yearStart = Date.UTC(year, 0, 1)
  const week = Math.ceil(((utc.getTime() - yearStart) / DAY_MS + 1) / 7)
  return { year, week }
}

/** `2026-W44`（周记的键） */
export function isoWeekKey(ts: number): string {
  const { year, week } = isoWeekOf(ts)
  return `${year}-W${pad2(week)}`
}

/** 这一周的周一 / 周日（本地日键），写进周记标题 */
export function isoWeekRange(ts: number): { start: string; end: string } {
  const date = new Date(ts)
  const day = date.getDay() === 0 ? 7 : date.getDay()
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - (day - 1))
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return { start: localDayKey(monday.getTime()), end: localDayKey(sunday.getTime()) }
}

export function isGrowthKind(value: string): value is GrowthKind {
  return (GROWTH_KINDS as readonly string[]).includes(value)
}

/** 某时刻该写哪一篇：日记 = 本地日，周记 = ISO 周 */
export function growthKeyOf(kind: GrowthKind, ts: number): string {
  return kind === 'daily' ? localDayKey(ts) : isoWeekKey(ts)
}

export function isGrowthKey(kind: GrowthKind, key: string): boolean {
  const match = kind === 'daily' ? DAILY_KEY_RE.exec(key) : WEEKLY_KEY_RE.exec(key)
  if (match === null) return false
  const year = Number(match[1])
  const n = Number(match[2])
  if (kind === 'daily') {
    const month = n
    const day = Number(match[3])
    return month >= 1 && month <= 12 && day >= 1 && day <= 31
  }
  return n >= 1 && n <= 53 && year >= 1970
}

/** 标题里的人话：`2026-11-01（周六）` / `2026 第 44 周（11-01 ~ 11-07）` */
export function growthTitle(kind: GrowthKind, key: string): string {
  if (kind === 'daily') {
    const match = DAILY_KEY_RE.exec(key)
    if (match === null) return key
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return `${key}（${WEEKDAY_LABELS[date.getDay()]}）`
  }
  const match = WEEKLY_KEY_RE.exec(key)
  if (match === null) return key
  const year = Number(match[1])
  const week = Number(match[2])
  // ISO 第 1 周 = 含 1 月 4 日的那一周；周一 = 1 月 4 日所在周的周一
  const jan4 = new Date(year, 0, 4)
  const day = jan4.getDay() === 0 ? 7 : jan4.getDay()
  const monday = new Date(year, 0, 4 - (day - 1) + (week - 1) * 7)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const mmdd = (value: Date): string => `${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
  return `${year} 第 ${week} 周（${mmdd(monday)} ~ ${mmdd(sunday)}）`
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

export function growthRelativePath(kind: GrowthKind, key: string): string {
  return join(GROWTH_DIR_NAME, kind === 'daily' ? GROWTH_DAILY_DIR : GROWTH_WEEKLY_DIR, `${key}.md`)
}

export function growthFilePath(root: string, kind: GrowthKind, key: string): string {
  return join(root, growthRelativePath(kind, key))
}

/* ------------------------------------------------------------------ */
/* 正文：归一 / 有界                                                    */
/* ------------------------------------------------------------------ */

export function growthBodyLimit(kind: GrowthKind): number {
  return kind === 'daily' ? GROWTH_DAILY_MAX_CHARS : GROWTH_WEEKLY_MAX_CHARS
}

/**
 * 正文归一：换行统一、行尾空白去掉、三连空行压成两行；模型顺手重复的 `# 标题` 去掉。
 * 不做逐行重排——markdown 的段落 / 列表由 ta 自己决定。
 */
export function normalizeGrowthBody(raw: string): string {
  const lines = raw.replace(/\r\n?/gu, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.replace(/[ \t]+$/u, '')
    if (trimmed.trim() === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(trimmed)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  // 模型有时会把标题再写一遍：去掉开头连续的一级标题行
  while (out.length > 0 && /^#\s+/u.test(out[0] ?? '')) out.shift()
  while (out.length > 0 && out[0] === '') out.shift()
  return out.join('\n').trim()
}

export function checkGrowthBody(
  kind: GrowthKind,
  raw: string
): { ok: true; body: string } | { ok: false; message: string } {
  const body = normalizeGrowthBody(raw)
  if (body === '') return { ok: false, message: '内容是空的：没有写任何东西' }
  const limit = growthBodyLimit(kind)
  if (body.length > limit) {
    return {
      ok: false,
      message: `太长（${body.length} 字，${kind === 'daily' ? '日记' : '周记'}最多 ${limit} 字）。挑最重要的写；细节留在记忆里。`
    }
  }
  return { ok: true, body }
}

/* ------------------------------------------------------------------ */
/* 解析 / 序列化 / 读写                                                 */
/* ------------------------------------------------------------------ */

export function serializeGrowthFile(kind: GrowthKind, key: string, body: string): string {
  return `# ${growthTitle(kind, key)}\n\n${body}\n`
}

/** 读文件内容 → 标题 + 正文；没有标题行就当全是正文（人改坏了也读得出来） */
export function parseGrowthFile(text: string): { title: string; body: string } {
  const normalized = text.replace(/\r\n?/gu, '\n').trim()
  if (normalized === '') return { title: '', body: '' }
  const lines = normalized.split('\n')
  const first = lines[0] ?? ''
  const heading = /^#\s+(.+)$/u.exec(first)
  if (heading === null) return { title: '', body: normalized }
  return { title: (heading[1] ?? '').trim(), body: lines.slice(1).join('\n').trim() }
}

export function readGrowthEntry(root: string, kind: GrowthKind, key: string): GrowthEntry | null {
  if (!isGrowthKey(kind, key)) return null
  const path = growthFilePath(root, kind, key)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const parsed = parseGrowthFile(text)
  return {
    kind,
    key,
    title: parsed.title === '' ? growthTitle(kind, key) : parsed.title,
    body: parsed.body,
    path: growthRelativePath(kind, key)
  }
}

/** 写一篇（已有就覆盖：重试不会写出两份；没有就建目录） */
export function writeGrowthEntry(
  root: string,
  kind: GrowthKind,
  key: string,
  rawBody: string
): GrowthWriteOutcome {
  if (!isGrowthKey(kind, key)) return { ok: false, message: `不认识的${kind === 'daily' ? '日期' : '周'}：${key}` }
  const checked = checkGrowthBody(kind, rawBody)
  if (!checked.ok) return checked
  const path = growthFilePath(root, kind, key)
  const replaced = existsSync(path)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializeGrowthFile(kind, key, checked.body), 'utf8')
  } catch (error) {
    return {
      ok: false,
      message: `没写进成长档案（${error instanceof Error ? error.message : String(error)}）`
    }
  }
  const entry: GrowthEntry = {
    kind,
    key,
    title: growthTitle(kind, key),
    body: checked.body,
    path: growthRelativePath(kind, key)
  }
  const label = kind === 'daily' ? '日记' : '周记'
  return {
    ok: true,
    entry,
    replaced,
    message: `${label}${replaced ? '已更新' : '已写入'} ${entry.path}（${checked.body.length} 字）`
  }
}

/** 目录里已有的键，新到旧；目录不存在 = 空 */
export function listGrowthKeys(root: string, kind: GrowthKind): string[] {
  const dir = join(root, GROWTH_DIR_NAME, kind === 'daily' ? GROWTH_DAILY_DIR : GROWTH_WEEKLY_DIR)
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3))
    .filter((key) => isGrowthKey(kind, key))
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
}

/* ------------------------------------------------------------------ */
/* 给人看的（/growth）                                                  */
/* ------------------------------------------------------------------ */

export function emptyGrowthText(): string {
  return '成长档案还是空的——等 ta 写下第一篇日记，这里就会有内容。'
}

/** `/growth` 的列表：最近 7 篇日记 + 最近 3 篇周记（只给键与字数，全文按需看） */
export function growthListText(root: string, dailyLimit = 7, weeklyLimit = 3): string {
  const daily = listGrowthKeys(root, 'daily').slice(0, dailyLimit)
  const weekly = listGrowthKeys(root, 'weekly').slice(0, weeklyLimit)
  if (daily.length === 0 && weekly.length === 0) return emptyGrowthText()
  const lines = [`成长档案（ta 自己的日记；文件在记忆仓的 ${GROWTH_DIR_NAME}/）`]
  if (daily.length > 0) {
    lines.push('', '日记（最近几篇）')
    for (const key of daily) {
      const entry = readGrowthEntry(root, 'daily', key)
      if (entry === null) continue
      lines.push(`  ${entry.title} · ${entry.body.length} 字`)
    }
  }
  if (weekly.length > 0) {
    lines.push('', '周记（最近几篇）')
    for (const key of weekly) {
      const entry = readGrowthEntry(root, 'weekly', key)
      if (entry === null) continue
      lines.push(`  ${entry.title} · ${entry.body.length} 字`)
    }
  }
  lines.push('', '看全文：/growth 2026-11-01 或 /growth 2026-W44')
  return lines.join('\n')
}

/** 一篇的全文（`/growth <键>`） */
export function growthEntryText(entry: GrowthEntry): string {
  return `# ${entry.title}\n\n${entry.body}\n\n（${entry.path}）`
}
