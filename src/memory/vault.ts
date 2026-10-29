/**
 * 个人记忆 · Obsidian 日记解析（纯函数，不碰库、不碰网络）
 *
 * 记忆来源是 `charlie_vault/daily/yyyy-mm-dd.md` 那种**日记模板**：
 * - YAML frontmatter（🌻日期🌻 / 天气 / 温度 …）——只用来兜底取日期，不进记忆正文；
 * - 正文前有一段「一言 / 提醒」引用块——不是用户写的东西，整段丢弃；
 * - 正文是 `# Tracking`（待办清单）+ `# Diary`（带 `- HH:mm` 的日记块）；
 * - 每天结尾有 `<< [[昨天]] | [[明天]] >>` 导航行——丢弃。
 *
 * 为什么解析层要做这么细：记忆系统最怕的不是「搜不到」，是「把模板噪音记成了你说的话」。
 * 一条「获取失败，请检查网络连接」要是进了记忆，之后每次问「我最近在想什么」都会带上它。
 *
 * 产物是**条目**（item）：一条 = 用户写的一小段（日记块 / 待办 / 摘录），带日期、行号、
 * 时间（能解析出 `HH:mm` 才带）、标签（`#tag`）与双链（`[[名字]]`）。
 */

import { parseMarks } from './marks'

/** 一条记忆的类别：日记 / 待办 / 引用 / 其它笔记 */
export type MemoryItemKind = 'diary' | 'task' | 'quote' | 'note'

export interface ParsedMemoryItem {
  dayKey: string
  section: string
  kind: MemoryItemKind
  /** 清洗后的正文（已去 markdown 符号、已折叠空白；**作者标记保留在正文里**） */
  text: string
  /** 条目时刻（本地毫秒时间戳；只有能解析出 `- HH:mm` 的日记块才有） */
  ts: number | null
  /** 在原文里的行号（1 起，闭区间），用于「回原文核对」 */
  lineStart: number
  lineEnd: number
  /** `#标签` */
  tags: string[]
  /** `[[双链]]` 的目标名（人 / 项目 / 书） */
  refs: string[]
  /** 待办是否完成（只有 kind=task 有意义） */
  done?: boolean
  /**
   * 这一条是谁写的：行尾 `[❤️]()` = ta，否则是用户（`marks.ts`，D57）。
   * 只在本层保留 —— 落库只存原文，读的时候按 `text` 重新解析，不新增列。
   */
  author: 'user' | 'ta'
  /** ta 对这条的评论（非空 `[❤️](正文)`） */
  comments: string[]
  /** 用户对 ta 评论的回复（`[💬](正文)`） */
  replies: string[]
}

export interface ParsedDailyNote {
  dayKey: string
  fileName: string
  items: ParsedMemoryItem[]
  /** 被丢弃的行数（模板噪音 / 导航 / 空行），只用于诊断 */
  skippedLines: number
}

/** 作者 / 评论 / 回复：直接按标记契约推导，不猜语义 */
function markFields(text: string): Pick<ParsedMemoryItem, 'author' | 'comments' | 'replies'> {
  const parsed = parseMarks(text)
  return { author: parsed.author, comments: parsed.comments, replies: parsed.replies }
}

/** `2026-10-28.md` → 日期；不是这种名字就返回 null（后面再用 frontmatter 兜底） */
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/i
/** Templater 模板（`<%* … -%>`）不是日记，整份跳过 */
const TEMPLATE_RE = /<%[\s\S]*?%>/
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/
const NAV_RE = /^\s*<<\s*\[\[.*?\]\]\s*\|\s*\[\[.*?\]\]\s*>>\s*$/
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const TOP_BULLET_RE = /^[-*]\s+(.*)$/
const TASK_RE = /^[-*]\s+\[([ xX])\]\s+(.*)$/
const DIARY_TIME_RE = /^(\d{1,2}):(\d{2})\s*(.*)$/

const TAG_RE = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_\-/]{0,29})/gu
const REF_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g

/** 一天 00:00 的本地毫秒时间戳；`2026-10-28` 这种键解析不出来返回 null */
export function dayStartTs(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return new Date(year, month - 1, day).getTime()
}

/** 毫秒时间戳 → `yyyy-mm-dd`（本地时区，与日记文件名同口径） */
export function dayKeyOf(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** frontmatter 里的日期（`🌻日期🌻: 2026-10-28`）；没有就返回 null */
function dayFromFrontmatter(frontmatter: string): string | null {
  const match = /^\s*[^\n:]*日期[^\n:]*:\s*(\d{4}-\d{2}-\d{2})\s*$/mu.exec(frontmatter)
  return match ? match[1] : null
}

/** 续行清洗：子列表 / 引用块的行首符号在合并后不该留在正文里 */
function stripLineMarkers(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+\[[ xX]\]\s*/u, '')
    .replace(/^[-*]\s+/u, '')
    .replace(/^>\s?/, '')
    .trim()
}

/** 文本清洗：去勾选框 / 引用符 / 行内代码 / 折叠空白 */
export function cleanItemText(raw: string): string {
  return raw
    .replace(/^[-*]\s+\[[ xX]\]\s*/u, '')
    .replace(/^>\s?/gmu, '')
    .replace(/`+/g, '')
    .replace(/[*_]{1,3}(?=\S)/g, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 抽标签：只认「空白后 + #」，避免把 markdown 标题 `# Diary` 当成标签 */
function extractTags(text: string): string[] {
  const tags: string[] = []
  for (const match of text.matchAll(TAG_RE)) {
    const tag = match[1].trim()
    // Obsidian 的高亮颜色会写成 `#[FF5582A6]` / `#FF5582A6`：那是颜色值，不是话题
    if (/^[0-9a-f]{6,8}$/iu.test(tag)) continue
    if (tag !== '' && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

/** 抽双链：`[[张三]]` / `[[项目/记忆球|记忆球]]` / `[[笔记#小节]]` 都只取目标名 */
function extractRefs(text: string): string[] {
  const refs: string[] = []
  for (const match of text.matchAll(REF_RE)) {
    const ref = match[1].trim()
    if (ref !== '' && !refs.includes(ref)) refs.push(ref)
  }
  return refs
}

/** 值不值得记：去空白后至少 2 个字，且不是纯符号 / 纯日期 */
function isUsefulText(text: string): boolean {
  const packed = text.replace(/\s+/gu, '')
  if (packed.length < 2) return false
  if (!/[\p{L}\p{N}]/u.test(packed)) return false
  return true
}

interface SourceLine {
  text: string
  lineNo: number
}

interface Section {
  name: string
  lines: SourceLine[]
}

/** 去掉 frontmatter / 导航行 / 分隔线，按 `# 标题` 切段；第一个标题之前的内容整段丢弃 */
function splitSections(content: string): { sections: Section[]; skippedLines: number } {
  const body = content.replace(FRONTMATTER_RE, '')
  const lines = body.split(/\r?\n/)
  const sections: Section[] = []
  let current: Section | null = null
  let skippedLines = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNo = index + 1
    if (NAV_RE.test(line) || /^\s*---+\s*$/.test(line)) {
      skippedLines += line.trim() === '' ? 0 : 1
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      current = { name: heading[2].trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current === null) {
      // 第一个标题之前：一言 / 提醒 / 天气回顾，全是模板噪音
      if (line.trim() !== '') skippedLines += 1
      continue
    }
    current.lines.push({ text: line, lineNo })
  }
  return { sections, skippedLines }
}

/** 待办：`- [ ] xxx` 每条一项；缩进子行并入上一条（子项常常是同一个目标的细节） */
function parseTaskItems(section: Section, dayKey: string): ParsedMemoryItem[] {
  const items: ParsedMemoryItem[] = []
  let current: { done: boolean; text: string; lineStart: number; lineEnd: number } | null = null
  const flush = (): void => {
    if (current === null) return
    const text = cleanItemText(current.text)
    if (isUsefulText(text)) {
      items.push({
        dayKey,
        section: section.name,
        kind: 'task',
        text,
        ts: null,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        tags: extractTags(text),
        refs: extractRefs(text),
        ...markFields(text),
        done: current.done
      })
    }
    current = null
  }
  for (const line of section.lines) {
    // 缩进的勾选框也是独立待办（Obsidian 里常见「目标 → 子任务」两层）；
    // 只对勾选框去掉缩进，普通续行仍然并进上一条当细节。
    const task = TASK_RE.exec(line.text.trimStart())
    if (task) {
      flush()
      current = {
        done: task[1].toLowerCase() === 'x',
        text: task[2],
        lineStart: line.lineNo,
        lineEnd: line.lineNo
      }
      continue
    }
    if (current !== null && line.text.trim() !== '') {
      current.text += ` ${stripLineMarkers(line.text)}`
      current.lineEnd = line.lineNo
    }
  }
  flush()
  return items
}

/** 日记：顶层 `- ` 起一个块（`- 01:19` 带时刻），块内续行 / 引用行都归它 */
function parseDiaryItems(section: Section, dayKey: string): ParsedMemoryItem[] {
  const items: ParsedMemoryItem[] = []
  const dayStart = dayStartTs(dayKey)
  let current: { text: string; lineStart: number; lineEnd: number; ts: number | null } | null = null
  const flush = (): void => {
    if (current === null) return
    const text = cleanItemText(current.text)
    if (isUsefulText(text)) {
      items.push({
        dayKey,
        section: section.name,
        kind: 'diary',
        text,
        ts: current.ts,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        tags: extractTags(text),
        refs: extractRefs(text),
        ...markFields(text)
      })
    }
    current = null
  }
  for (const line of section.lines) {
    const bullet = TOP_BULLET_RE.exec(line.text)
    if (bullet) {
      flush()
      const rest = bullet[1].trim()
      const timed = DIARY_TIME_RE.exec(rest)
      let ts: number | null = null
      let body = rest
      if (timed && dayStart !== null) {
        const hours = Number(timed[1])
        const minutes = Number(timed[2])
        if (hours <= 23 && minutes <= 59) {
          ts = dayStart + (hours * 60 + minutes) * 60_000
          body = timed[3].trim()
        }
      }
      current = { text: body, lineStart: line.lineNo, lineEnd: line.lineNo, ts }
      continue
    }
    if (current !== null && line.text.trim() !== '') {
      current.text += ` ${stripLineMarkers(line.text)}`
      current.lineEnd = line.lineNo
    }
  }
  flush()
  return items
}

/** 其它段落（心得 / 摘录）：按空行分块，一块一条 */
function parseParagraphItems(section: Section, dayKey: string): ParsedMemoryItem[] {
  const items: ParsedMemoryItem[] = []
  let block: { text: string; lineStart: number; lineEnd: number } | null = null
  const flush = (): void => {
    if (block === null) return
    const text = cleanItemText(block.text)
    if (isUsefulText(text)) {
      items.push({
        dayKey,
        section: section.name,
        kind: 'note',
        text,
        ts: null,
        lineStart: block.lineStart,
        lineEnd: block.lineEnd,
        tags: extractTags(text),
        refs: extractRefs(text),
        ...markFields(text)
      })
    }
    block = null
  }
  for (const line of section.lines) {
    if (line.text.trim() === '') {
      flush()
      continue
    }
    const bullet = TOP_BULLET_RE.exec(line.text)
    const text = bullet ? bullet[1] : line.text
    if (block === null) {
      block = { text, lineStart: line.lineNo, lineEnd: line.lineNo }
    } else {
      block.text += ` ${text.trim()}`
      block.lineEnd = line.lineNo
    }
  }
  flush()
  return items
}

function sectionKind(name: string): 'task' | 'diary' | 'note' {
  const lowered = name.toLowerCase()
  if (lowered.includes('tracking') || lowered.includes('待办') || lowered.includes('todo')) return 'task'
  if (lowered.includes('diary') || lowered.includes('日记') || lowered.includes('日志')) return 'diary'
  return 'note'
}

/**
 * 解析一份日记 markdown。
 *
 * @param fileName 文件名（`2026-10-28.md`）；日期优先从它取，取不到再用 frontmatter
 * @param content  全文
 * @returns 模板文件 / 无日期 / 无有效条目 → null（调用方据此跳过，不算错）
 */
export function parseDailyNote(fileName: string, content: string): ParsedDailyNote | null {
  if (TEMPLATE_RE.test(content)) return null
  const frontmatter = FRONTMATTER_RE.exec(content)?.[1] ?? ''
  const dayKey = DAY_FILE_RE.exec(fileName.trim())?.[1] ?? dayFromFrontmatter(frontmatter)
  if (dayKey === null) return null

  const { sections, skippedLines } = splitSections(content)
  const items: ParsedMemoryItem[] = []
  const seen = new Set<string>()
  for (const section of sections) {
    const kind = sectionKind(section.name)
    const parsed =
      kind === 'task'
        ? parseTaskItems(section, dayKey)
        : kind === 'diary'
          ? parseDiaryItems(section, dayKey)
          : parseParagraphItems(section, dayKey)
    for (const item of parsed) {
      // 同一天同一条重复写两遍（Obsidian 里复制粘贴很常见）：只留第一条
      const key = `${item.section}\u0000${item.text}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  if (items.length === 0) return null
  items.sort((a, b) => a.lineStart - b.lineStart)
  return { dayKey, fileName, items, skippedLines }
}

