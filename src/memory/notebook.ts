/**
 * 小本本 · 当前理解的核心页（自调用 v0.2 §7 / §12.2，2026-11-01）
 *
 * 载体（§13.1 的待拍板项）：**记忆仓里的独立 `notebook.md`**，不是用户 Obsidian 的日记。
 * 这么做有三个好处：
 * - 它是 ta 自己的东西（用户日记只读的口径不被打破）；
 * - 跟着记忆仓的分支走——换节点就是换一个人，小本本不会串；
 * - git 里有历史，改错了能回看。
 *
 * 文件由代码维护（格式见 `serializeNotebook`），模型只能通过 `update_notebook` 改，
 * 用户也可以直接编辑：带编号的行按原样读回，随手写的 `- 一句话` 会被补上一个编号。
 *
 * 这一层只做**文件内容**，不碰链层 / 主进程；要不要出云、怎么过脱敏，由上层决定。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/* ------------------------------------------------------------------ */
/* 分区与上限                                                          */
/* ------------------------------------------------------------------ */

export const NOTEBOOK_SECTION_IDS = ['about_you', 'recent_you', 'between_us', 'reminders'] as const
export type NotebookSection = (typeof NOTEBOOK_SECTION_IDS)[number]

/** 分区的人话名字（文件标题、工具回执、/notebook 都用它） */
export const NOTEBOOK_SECTION_LABELS: Readonly<Record<NotebookSection, string>> = {
  about_you: '关于你',
  recent_you: '最近的你',
  between_us: '我们之间',
  reminders: '我给自己的提醒'
}

/** 文件里的标题（中文名或英文 id 都认）→ 分区 */
const SECTION_BY_HEADING: ReadonlyMap<string, NotebookSection> = new Map(
  NOTEBOOK_SECTION_IDS.flatMap((id) => [
    [NOTEBOOK_SECTION_LABELS[id], id] as const,
    [id, id] as const
  ])
)

export function isNotebookSection(value: string): value is NotebookSection {
  return (NOTEBOOK_SECTION_IDS as readonly string[]).includes(value)
}

/** 单条上限：一条只说一件事；超了让模型自己挑重点，不静默截断 */
export const NOTEBOOK_ENTRY_MAX_CHARS = 140
/** 每栏最多几条：满了先合并 / 放下旧的，再记新的 */
export const NOTEBOOK_SECTION_MAX_ENTRIES = 5
/** 全本正文总字数上限：核心页必须有界 */
export const NOTEBOOK_TOTAL_MAX_CHARS = 1800
/** `<now>` 注入的硬上限（防御手工把文件改大；正常情况下写入口已经把本子限住） */
export const NOTEBOOK_INJECT_MAX_CHARS = 2200
/** 记忆仓里的文件名 */
export const NOTEBOOK_FILE_NAME = 'notebook.md'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface NotebookEntry {
  /** `n1`、`n2`……稳定编号；改 / 删都靠它 */
  id: string
  section: NotebookSection
  text: string
  /** 这条最近一次被写下的本地日期 `YYYY-MM-DD`；空 = 老格式 / 手写没日期 */
  at: string
}

export interface Notebook {
  entries: NotebookEntry[]
}

export interface NotebookUpdateOk {
  ok: true
  notebook: Notebook
  entry: NotebookEntry
  /** 改完之后一共几条 */
  total: number
  message: string
}

export interface NotebookUpdateError {
  ok: false
  message: string
}

export type NotebookUpdateOutcome = NotebookUpdateOk | NotebookUpdateError

/* ------------------------------------------------------------------ */
/* 解析 / 序列化                                                        */
/* ------------------------------------------------------------------ */

const HEADING_RE = /^##\s+(.+?)\s*$/u
/** 代码写的格式：`- n3 · 2026-11-01 · 内容` */
const DATED_ENTRY_RE = /^-\s+(n\d+)\s+·\s+(\d{4}-\d{2}-\d{2})\s+·\s+(.+)$/u
/** 兼容手写：`- n3 · 内容` */
const UNDATED_ENTRY_RE = /^-\s+(n\d+)\s+·\s+(.+)$/u
/** 用户随手写：`- 一句话`（补编号） */
const PLAIN_ENTRY_RE = /^-\s+(.+)$/u

/** 正文归一：折叠空白成单空格，去掉开头可能的列表符 */
export function normalizeNotebookText(raw: string): string {
  return raw
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[-·:：]\s*/u, '')
    .trim()
}

function sectionOfHeading(raw: string): NotebookSection | null {
  const heading = raw.trim()
  const byLabel = SECTION_BY_HEADING.get(heading)
  if (byLabel !== undefined) return byLabel
  return SECTION_BY_HEADING.get(heading.toLowerCase()) ?? null
}

function maxIdNumber(entries: readonly NotebookEntry[]): number {
  let max = 0
  for (const entry of entries) {
    const raw = Number(entry.id.slice(1))
    if (Number.isInteger(raw) && raw > max) max = raw
  }
  return max
}

/** 读文件内容 → 结构。不认识的标题 / 行一律忽略（文件可以由人改坏，别让整个本子打不开） */
export function parseNotebook(text: string, today = ''): Notebook {
  let section: NotebookSection | null = null
  /** 先收原始行：手写行还没编号，等知道最大编号后再补 */
  const raw: Array<{ id: string | null; section: NotebookSection; text: string; at: string }> = []
  for (const line of text.split(/\r?\n/u)) {
    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      section = sectionOfHeading(heading[1] ?? '')
      continue
    }
    if (section === null) continue
    const dated = DATED_ENTRY_RE.exec(line)
    if (dated !== null) {
      raw.push({ id: dated[1] ?? null, section, at: dated[2] ?? '', text: dated[3] ?? '' })
      continue
    }
    const undated = UNDATED_ENTRY_RE.exec(line)
    if (undated !== null) {
      raw.push({ id: undated[1] ?? null, section, at: '', text: undated[2] ?? '' })
      continue
    }
    const plain = PLAIN_ENTRY_RE.exec(line)
    if (plain !== null) {
      const body = (plain[1] ?? '').trim()
      // 勾选框不是小本本条目（用户可能把待办贴进来）
      if (body === '' || /^\[[ xX]\]/u.test(body)) continue
      raw.push({ id: null, section, at: '', text: body })
    }
  }
  const used = new Set<number>()
  for (const item of raw) {
    if (item.id === null) continue
    used.add(Number(item.id.slice(1)))
  }
  let next = Math.max(0, ...used) + 1
  const entries: NotebookEntry[] = []
  for (const item of raw) {
    let id = item.id
    if (id === null) {
      while (used.has(next)) next += 1
      id = `n${next}`
      used.add(next)
      next += 1
    }
    const body = normalizeNotebookText(item.text)
    if (body === '') continue
    entries.push({
      id,
      section: item.section,
      text: body,
      at: item.at === '' ? today : item.at
    })
  }
  return { entries }
}

/** 结构 → 文件内容。四个分区永远都在（空栏也留标题），方便人看 / 手改 */
export function serializeNotebook(notebook: Notebook, today = ''): string {
  const lines = [
    '# 小本本',
    '',
    '> 当前理解，不是判决书。每条前面的编号用于修改 / 删除；可以直接改这个文件，也可以跟 ta 说。',
    ''
  ]
  for (const section of NOTEBOOK_SECTION_IDS) {
    lines.push(`## ${NOTEBOOK_SECTION_LABELS[section]}`, '')
    for (const entry of notebook.entries) {
      if (entry.section !== section) continue
      const at = entry.at === '' ? today : entry.at
      lines.push(at === '' ? `- ${entry.id} · ${entry.text}` : `- ${entry.id} · ${at} · ${entry.text}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}

/** 读记忆仓里的小本本；文件不存在 / 读不了 = 空本子（不建文件） */
export function readNotebookFile(path: string, today = ''): Notebook {
  if (!existsSync(path)) return { entries: [] }
  try {
    return parseNotebook(readFileSync(path, 'utf8'), today)
  } catch {
    return { entries: [] }
  }
}

/** 写回文件（目录不存在就建；内容很小，直接覆盖写） */
export function writeNotebookFile(path: string, notebook: Notebook, today = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeNotebook(notebook, today), 'utf8')
}

/* ------------------------------------------------------------------ */
/* 增 / 改 / 删                                                        */
/* ------------------------------------------------------------------ */

function totalTextChars(entries: readonly NotebookEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.text.length, 0)
}

function entryIdsOf(entries: readonly NotebookEntry[], section: NotebookSection): string[] {
  return entries.filter((entry) => entry.section === section).map((entry) => entry.id)
}

function checkEntryText(raw: string): { ok: true; text: string } | { ok: false; message: string } {
  const text = normalizeNotebookText(raw)
  if (text === '') return { ok: false, message: '要记的内容是空的' }
  if (text.length > NOTEBOOK_ENTRY_MAX_CHARS) {
    return {
      ok: false,
      message: `太长（${text.length} 字，一条最多 ${NOTEBOOK_ENTRY_MAX_CHARS} 字）。挑最重要的一句；细节留在记忆里。`
    }
  }
  return { ok: true, text }
}

/** 补一条：同一栏重复 / 栏满 / 全本超字数都如实拒绝，不静默丢旧条目 */
export function addNotebookEntry(
  notebook: Notebook,
  section: NotebookSection,
  rawText: string,
  at: string
): NotebookUpdateOutcome {
  const checked = checkEntryText(rawText)
  if (!checked.ok) return checked
  const text = checked.text
  const duplicate = notebook.entries.find((entry) => entry.section === section && entry.text === text)
  if (duplicate !== undefined) {
    return { ok: false, message: `这一栏已经有这一条了（${duplicate.id}）。要改就用 revise。` }
  }
  const ids = entryIdsOf(notebook.entries, section)
  if (ids.length >= NOTEBOOK_SECTION_MAX_ENTRIES) {
    return {
      ok: false,
      message: `「${NOTEBOOK_SECTION_LABELS[section]}」满了（${ids.join('、')}）。先 revise 合并，或 remove 放下不重要的，再记新的。`
    }
  }
  if (totalTextChars(notebook.entries) + text.length > NOTEBOOK_TOTAL_MAX_CHARS) {
    return {
      ok: false,
      message: `小本本满了（正文上限 ${NOTEBOOK_TOTAL_MAX_CHARS} 字）。先合并 / 删掉不再重要的，再记新的。`
    }
  }
  const id = `n${maxIdNumber(notebook.entries) + 1}`
  const entry: NotebookEntry = { id, section, text, at }
  return {
    ok: true,
    notebook: { entries: [...notebook.entries, entry] },
    entry,
    total: notebook.entries.length + 1,
    message: `记下了 ${id}（${NOTEBOOK_SECTION_LABELS[section]}）。`
  }
}

/** 改写一条（内容以新的为准，日期也更新）；编号不变，位置不变 */
export function reviseNotebookEntry(
  notebook: Notebook,
  id: string,
  rawText: string,
  at: string
): NotebookUpdateOutcome {
  const index = notebook.entries.findIndex((entry) => entry.id === id)
  if (index < 0) {
    return { ok: false, message: `没有 ${id} 这条（小本本里没有这个编号）。` }
  }
  const checked = checkEntryText(rawText)
  if (!checked.ok) return checked
  const text = checked.text
  const old = notebook.entries[index] as NotebookEntry
  const duplicate = notebook.entries.find(
    (entry) => entry.id !== id && entry.section === old.section && entry.text === text
  )
  if (duplicate !== undefined) {
    return { ok: false, message: `这一栏已经有这一条了（${duplicate.id}）；两条一样的话用 remove 放下 ${id}。` }
  }
  const total = totalTextChars(notebook.entries) - old.text.length + text.length
  if (total > NOTEBOOK_TOTAL_MAX_CHARS) {
    return {
      ok: false,
      message: `改完会超过正文上限（${total} > ${NOTEBOOK_TOTAL_MAX_CHARS} 字）。写短一点，或先删掉不重要的。`
    }
  }
  const entry: NotebookEntry = { ...old, text, at }
  const entries = [...notebook.entries]
  entries[index] = entry
  return {
    ok: true,
    notebook: { entries },
    entry,
    total: entries.length,
    message: `改好了 ${id}。`
  }
}

/** 放下一条（不再重要 / 不再准确） */
export function removeNotebookEntry(notebook: Notebook, id: string): NotebookUpdateOutcome {
  const entry = notebook.entries.find((item) => item.id === id)
  if (entry === undefined) {
    return { ok: false, message: `没有 ${id} 这条（小本本里没有这个编号）。` }
  }
  const entries = notebook.entries.filter((item) => item.id !== id)
  return {
    ok: true,
    notebook: { entries },
    entry,
    total: entries.length,
    message: `放下了 ${id}。`
  }
}

/* ------------------------------------------------------------------ */
/* 给人看的列表（/notebook）                                           */
/* ------------------------------------------------------------------ */

/** 空本子时的一句人话 */
export function emptyNotebookText(): string {
  return '小本本还是空的——等 ta 记下关于你的重要理解，这里就会有内容。'
}

/**
 * `/notebook` 的列表：按分区排，带编号（`/notebook rm` 就用它）。
 * 空栏不显示标题。
 */
export function notebookListText(notebook: Notebook): string {
  if (notebook.entries.length === 0) return emptyNotebookText()
  const lines = [`小本本（${notebook.entries.length} 条；文件在记忆仓的 ${NOTEBOOK_FILE_NAME}）`]
  for (const section of NOTEBOOK_SECTION_IDS) {
    const entries = notebook.entries.filter((entry) => entry.section === section)
    if (entries.length === 0) continue
    lines.push('', NOTEBOOK_SECTION_LABELS[section])
    for (const entry of entries) {
      lines.push(`  ${entry.id} ${entry.text}${entry.at === '' ? '' : `（${entry.at}）`}`)
    }
  }
  lines.push('', '删一条：/notebook rm <编号>')
  return lines.join('\n')
}
