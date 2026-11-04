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
/* 栏目（兼容旧本子）                                                          */
/* ------------------------------------------------------------------ */

export const NOTEBOOK_SECTION_IDS = ['about_you', 'recent_you', 'between_us', 'reminders'] as const
export type NotebookSection = string

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
  return value.trim() !== '' && !/[\r\n]/u.test(value)
}

/** 旧栏目只做兼容映射，新本子没有预设栏目。 */
export function notebookSectionLabel(section: string): string {
  return Object.hasOwn(NOTEBOOK_SECTION_LABELS, section) ? NOTEBOOK_SECTION_LABELS[section]! : section
}

export function notebookSections(notebook: Notebook): string[] {
  return [...new Set(notebook.entries.map((entry) => entry.section))]
}
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

/** 正文归一：保留段落与排版，只去掉首尾空白和开头的列表符 */
export function normalizeNotebookText(raw: string): string {
  return raw
    .replace(/\r\n/gu, '\n')
    .trim()
    .replace(/^[-·:：]\s*/u, '')
    .trim()
}

function sectionOfHeading(raw: string): NotebookSection | null {
  const heading = raw.trim()
  const byLabel = SECTION_BY_HEADING.get(heading)
  if (byLabel !== undefined) return byLabel
  return SECTION_BY_HEADING.get(heading.toLowerCase()) ?? heading
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
    if (line.startsWith('  ') && raw.length > 0) {
      raw[raw.length - 1]!.text += `\n${line.slice(2)}`
      continue
    }
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
  let next = 1
  for (const id of used) next = Math.max(next, id + 1)
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

/** 只序列化实际使用的栏目；旧栏目保留原来的名称与编号。 */
export function serializeNotebook(notebook: Notebook, today = ''): string {
  const lines = ['# 小本本', '']
  for (const section of notebookSections(notebook)) {
    lines.push(`## ${notebookSectionLabel(section)}`, '')
    for (const entry of notebook.entries) {
      if (entry.section !== section) continue
      const at = entry.at === '' ? today : entry.at
      const [first, ...rest] = entry.text.split('\n')
      lines.push(at === '' ? `- ${entry.id} · ${first}` : `- ${entry.id} · ${at} · ${first}`)
      for (const line of rest) lines.push(`  ${line}`)
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

function checkEntryText(raw: string): { ok: true; text: string } | { ok: false; message: string } {
  const text = normalizeNotebookText(raw)
  if (text === '') return { ok: false, message: '要记的内容是空的' }
  return { ok: true, text }
}

/** 补一条；栏目、篇幅与条数由持有者决定。 */
export function addNotebookEntry(
  notebook: Notebook,
  section: NotebookSection,
  rawText: string,
  at: string
): NotebookUpdateOutcome {
  const checked = checkEntryText(rawText)
  if (!checked.ok) return checked
  const text = checked.text
  section = sectionOfHeading(section) ?? '随手记'
  const id = `n${maxIdNumber(notebook.entries) + 1}`
  const entry: NotebookEntry = { id, section, text, at }
  return {
    ok: true,
    notebook: { entries: [...notebook.entries, entry] },
    entry,
    total: notebook.entries.length + 1,
    message: `记下了 ${id}（${notebookSectionLabel(section)}）。`
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
  return '小本本还是空的。'
}

/**
 * `/notebook` 的列表：按分区排，带编号（`/notebook rm` 就用它）。
 * 空栏不显示标题。
 */
export function notebookListText(notebook: Notebook): string {
  if (notebook.entries.length === 0) return emptyNotebookText()
  const lines = [`小本本（${notebook.entries.length} 条；文件在记忆仓的 ${NOTEBOOK_FILE_NAME}）`]
  for (const section of notebookSections(notebook)) {
    const entries = notebook.entries.filter((entry) => entry.section === section)
    if (entries.length === 0) continue
    lines.push('', notebookSectionLabel(section))
    for (const entry of entries) {
      lines.push(`  ${entry.id} ${entry.text}${entry.at === '' ? '' : `（${entry.at}）`}`)
    }
  }
  lines.push('', '删一条：/notebook rm <编号>')
  return lines.join('\n')
}
