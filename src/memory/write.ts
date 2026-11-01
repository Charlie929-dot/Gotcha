/**
 * 个人记忆 · 日记写入（只追加 / 插评论，纯文件操作，不碰库、不碰网络）
 *
 * 这是方案里**唯一会改用户正文**的模块（`docs/agent/llm-call.md` §7、D57），所以规矩先写死：
 *
 * 1. **只追加**：`appendDiary` / `appendPlan` 只在段落末尾加行；`insertComment` 只往用户行里插
 *    `[❤️](正文)`，不动用户写的字、不改勾选、不改时间；
 * 2. **缺当天笔记就先建**（`ensureDailyNote`）：按 Obsidian 的 `daily-notes.json` 模板展开；
 *    模板里有需要 Templater 运行时才能算的东西（天气 / 一言）就跳过那几行，没有模板就写最简骨架。
 *    **已有的文件永远不动一个字节**——只在文件不存在时创建；
 * 3. **写前备份**：原文件先整份拷进 `backupDir`，每天保留最近 20 份；
 * 4. **原子写**：同目录临时文件 + rename，保留原文件的 BOM 与 CRLF；
 * 5. **冲突重试**：读之前记 `mtime/size`，写之前再比一次 —— 变了（Obsidian 刚存过盘）就重读重试，
 *    最多 2 次；仍变则报 `conflict`，整次不写。
 *
 * 行格式（§2.3）：
 *
 * ```markdown
 * - 08:40 今天早上有点困。[❤️](那就别硬撑，午休二十分钟？)[💬](好，我中午睡。)
 * - 23:30 今天你大部分时间都在改记忆球。 [❤️]()
 *   - 下午有一阵子盯着设置抽屉发呆，我猜你累了。 [❤️]()
 * - [ ] 09:00-10:00 写周报 [❤️]()
 * ```
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { TA_MARK, formatComment, parseMarks } from './marks'

export type DiarySection = 'diary' | 'tracking'

export type DiaryWriteErrorCode =
  | 'bad-day'
  | 'bad-time'
  | 'missing-file'
  | 'no-section'
  | 'empty-text'
  | 'line-not-found'
  | 'line-ambiguous'
  | 'already-commented'
  | 'anchor-not-found'
  | 'anchor-ambiguous'
  | 'conflict'

export class DiaryWriteError extends Error {
  readonly code: DiaryWriteErrorCode

  constructor(code: DiaryWriteErrorCode, message: string) {
    super(message)
    this.name = 'DiaryWriteError'
    this.code = code
  }
}

export interface DiaryWriteContext {
  dayKey: string
  /** 日记目录（`charlie_vault/daily`） */
  vaultDir: string
  /** 备份目录（`userData/diary-backups`）；不传就不备份（只给测试用，生产必须传） */
  backupDir?: string
  /** 显式文件路径（默认 `${vaultDir}/${dayKey}.md`） */
  file?: string
  /** 注入时钟（默认 `Date.now()`），测试固定钟用 */
  now?: number
  /** 仅测试用：读到内容之后回调（模拟 Obsidian 在此期间存盘，验证冲突重试） */
  onRead?: () => void
}

export interface DiaryWriteResult {
  dayKey: string
  /** 实际改动的段落（插评论按行所在段落判定） */
  section: DiarySection
  /** 新写入 / 插入的行数 */
  lines: number
  /** 备份文件名（不含目录）；没备份为 null */
  backup: string | null
}

export interface AppendDiaryInput extends DiaryWriteContext {
  /** 正文（多行就按行拆，每行一句） */
  text: string
  /** `HH:mm`；默认取 now */
  time?: string
}

export interface AppendPlanInput extends DiaryWriteContext {
  /** 事项 */
  text: string
  /** `HH:mm` 或 `HH:mm-HH:mm`；只给开始时间也可以 */
  time?: string
  /** 结束时间（`time` 只给了 `HH:mm` 时用） */
  end?: string
}

export interface InsertCommentInput extends DiaryWriteContext {
  /** 用户行的唯一子串（找不到 / 多命中都报错，不猜） */
  line: string
  /** 评论正文 */
  comment: string
  /** 锚点：插在它之后；不传 = 行尾 */
  after?: string
}

/** 一天的日记文本：行数组 + 原文件的换行风格 / BOM（重写时原样保留） */
export interface DailyDoc {
  bom: boolean
  eol: '\n' | '\r\n'
  lines: string[]
}

/** 段内改动：返回改了几行、改在哪个段 */
type Mutation = (doc: DailyDoc) => { lines: number; section: DiarySection }

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/u
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/u
const NAV_RE = /^\s*<<\s*\[\[.*?\]\]\s*\|\s*\[\[.*?\]\]\s*>>\s*$/u
const RULE_RE = /^\s*---+\s*$/u
const TIME_ONLY_RE = /^(\d{1,2}):(\d{2})$/u
const TIME_RANGE_RE = /^(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2}):(\d{2})$/u
const BACKUP_KEEP = 20

function resolveFile(context: DiaryWriteContext): string {
  if (!DAY_KEY_RE.test(context.dayKey)) {
    throw new DiaryWriteError('bad-day', `dayKey 必须是 yyyy-mm-dd：${context.dayKey}`)
  }
  return context.file ?? join(context.vaultDir, `${context.dayKey}.md`)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function clockOf(ts: number): string {
  const date = new Date(ts)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** `HH:mm` → 规范化的 `HH:mm`；不合法返回 null（调用方报错，不猜） */
function normalizeClock(value: string): string | null {
  const match = TIME_ONLY_RE.exec(value.trim())
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${pad2(hours)}:${pad2(minutes)}`
}

function serialize(doc: DailyDoc): string {
  return `${doc.bom ? '\uFEFF' : ''}${doc.lines.join(doc.eol)}`
}

function readDoc(file: string): DailyDoc {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new DiaryWriteError('missing-file', `当天笔记不存在：${basename(file)}`)
  }
  const bom = raw.startsWith('\uFEFF')
  return {
    bom,
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    lines: (bom ? raw.slice(1) : raw).split(/\r?\n/u)
  }
}

/** 同目录临时文件 + rename：中途崩溃也不会留下半份日记 */
function writeDoc(file: string, doc: DailyDoc): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  writeFileSync(tmp, serialize(doc), 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件都删不掉就没什么可做的了：把原始错误抛出去更有用
    }
    throw error
  }
}

/** 备份一份原文件；按天只留最近 BACKUP_KEEP 份 */
function backupFile(
  file: string,
  backupDir: string | undefined,
  dayKey: string,
  now: number
): string | null {
  if (backupDir === undefined) return null
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-')
  const name = `${dayKey}-${stamp}.md`
  copyFileSync(file, join(backupDir, name))
  const prefix = `${dayKey}-`
  const existing = readdirSync(backupDir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.md'))
    .sort()
  for (const entry of existing.slice(0, Math.max(0, existing.length - BACKUP_KEEP))) {
    try {
      unlinkSync(join(backupDir, entry))
    } catch {
      // 清旧备份失败不影响本次写入
    }
  }
  return name
}

function sectionKindOf(name: string): DiarySection | 'other' {
  const lowered = name.toLowerCase()
  if (lowered.includes('tracking') || lowered.includes('待办') || lowered.includes('todo')) return 'tracking'
  if (lowered.includes('diary') || lowered.includes('日记') || lowered.includes('日志')) return 'diary'
  return 'other'
}

/** 找到某段的内容范围 `[heading, end)`；标题行是边界，导航行与 `---` 也算边界 */
function findSection(lines: string[], section: DiarySection): { heading: number; end: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const heading = HEADING_RE.exec(lines[index])
    if (heading === null || sectionKindOf(heading[2]) !== section) continue
    let end = lines.length
    for (let next = index + 1; next < lines.length; next += 1) {
      if (HEADING_RE.test(lines[next]) || NAV_RE.test(lines[next]) || RULE_RE.test(lines[next])) {
        end = next
        break
      }
    }
    return { heading: index, end }
  }
  return null
}

/** 某一行属于哪个段（插评论时回填结果用） */
function sectionAt(lines: string[], index: number): DiarySection {
  for (const section of ['tracking', 'diary'] as const) {
    const range = findSection(lines, section)
    if (range !== null && index > range.heading && index < range.end) return section
  }
  return 'diary'
}

/** 段内最后一个非空行的下一行：追加总是落在段落末尾（不打断已有条目） */
function appendIndex(lines: string[], range: { heading: number; end: number }): number {
  for (let index = range.end - 1; index > range.heading; index -= 1) {
    if (lines[index].trim() !== '') return index + 1
  }
  return range.heading + 1
}

/** 追加的块后面若紧贴标题（段内原本没有空行），补一行空行，别把列表和下一个标题黏在一起 */
function separateFromHeading(lines: string[], blockEnd: number): void {
  const next = lines[blockEnd]
  if (next === undefined || next.trim() === '') return
  if (!HEADING_RE.test(next) && !RULE_RE.test(next) && !NAV_RE.test(next)) return
  lines.splice(blockEnd, 0, '')
}

/**
 * 读 → 改 → 比 mtime → 备份 → 原子写；`mutate` 里抛错就整次不写。
 *
 * 冲突（Obsidian 在我们读之后存过盘）时重读重试，最多 2 次；`mutate` 会拿新内容再跑一遍，
 * 所以它必须是「看着当前文本决定怎么改」的纯改动。
 */
function commit(context: DiaryWriteContext, mutate: Mutation): DiaryWriteResult {
  const file = resolveFile(context)
  const maxRetries = 2
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let before: { mtimeMs: number; size: number }
    try {
      const stat = statSync(file)
      before = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      throw new DiaryWriteError('missing-file', `当天笔记不存在：${basename(file)}`)
    }
    const doc = readDoc(file)
    const result = mutate(doc)
    context.onRead?.()
    let after: { mtimeMs: number; size: number }
    try {
      const stat = statSync(file)
      after = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      throw new DiaryWriteError('conflict', '日记在写入前被移走，已放弃本次写入')
    }
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      // 用户 / Obsidian 动过文件：重读一遍再来，别覆盖他的新内容
      if (attempt < maxRetries) continue
      throw new DiaryWriteError('conflict', '日记在写入前被改动，已放弃本次写入')
    }
    const backup = backupFile(file, context.backupDir, context.dayKey, context.now ?? Date.now())
    writeDoc(file, doc)
    return { dayKey: context.dayKey, section: result.section, lines: result.lines, backup }
  }
  throw new DiaryWriteError('conflict', '日记在写入前被改动，已放弃本次写入')
}

function splitSentences(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/* ------------------------------------------------------------------ */
/* 缺当天的笔记：自动创建（2026-11-01 拍板：没有就自动建，别让计划悬着） */
/*                                                                     */
/* 规矩：                                                              */
/* 1. **只建不改**：文件已存在就原样返回 created=false，一个字节都不动； */
/* 2. **优先用用户自己的模板**：读 `<vault>/.obsidian/daily-notes.json`   */
/*    的 folder / template，展开里面的日期表达式；                     */
/* 3. **算不出来的就跳过那一行**：天气 / 一言这类要 Templater 运行时 +   */
/*    联网的东西后端跑不了，宁可少几行，也不把 `<% %>` 原样留在笔记里；  */
/* 4. 没有模板（或模板不可用）→ 写最简骨架，保证 `# Tracking` / `# Diary` */
/*    两段在，计划同步与日记写入都能落下去。                            */
/* ------------------------------------------------------------------ */

export interface EnsureDailyNoteInput extends DiaryWriteContext {
  /** 模板绝对路径；不传就按 `<vault>/.obsidian/daily-notes.json` 找 */
  templatePath?: string | null
}

export interface EnsureDailyNoteResult {
  file: string
  /** 这次是不是真的建了（false = 文件本来就在） */
  created: boolean
  /** 用到的模板路径（null = 没模板，写的最简骨架） */
  template: string | null
  /** 模板里依赖 Templater 运行时、自动创建时被跳过的行数 */
  skipped: number
}

/** 一天的骨架：日期进 frontmatter（解析器按它兜底日期），两段齐全 */
function skeletonLines(dayKey: string): string[] {
  const [year, month, day] = dayKey.split('-').map(Number)
  const fmt = (offset: number): string => {
    const date = new Date(year, month - 1, day + offset)
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }
  return [
    '---',
    `🌻日期🌻: ${dayKey}`,
    '---',
    '',
    '# Tracking',
    '',
    '# Diary',
    '',
    '---',
    `<< [[${fmt(-1)}]] | [[${fmt(1)}]] >>`,
    ''
  ]
}

/** 按 `daily-notes.json` 找模板（相对仓根 / 可以不带 `.md`） */
function resolveDailyTemplate(vaultDir: string, explicit?: string | null): string | null {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return explicit
  }
  const vaultRoot = dirname(vaultDir)
  const configPath = join(vaultRoot, '.obsidian', 'daily-notes.json')
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return null
  }
  let parsed: { template?: unknown; folder?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const template = typeof parsed.template === 'string' ? parsed.template.trim() : ''
  if (template === '') return null
  const file = join(vaultRoot, template.endsWith('.md') ? template : `${template}.md`)
  return existsSync(file) ? file : null
}

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/** 按 Obsidian / moment 的常见记号格式化本地时间（只支持模板里真的会用到的那几个） */
export function formatDailyStamp(ts: number, format: string): string {
  const date = new Date(ts)
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    dddd: WEEKDAY_NAMES[date.getDay()],
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad2(date.getDate()),
    D: String(date.getDate()),
    HH: pad2(date.getHours()),
    mm: pad2(date.getMinutes()),
    ss: pad2(date.getSeconds())
  }
  return format.replace(/YYYY|dddd|YY|MM|DD|HH|mm|ss|M|D/gu, (token) => tokens[token] ?? token)
}

/** 模板里的一行：展开得了就返回文本，展开不了（要 Templater 运行时）返回 null */
function expandTemplateLine(line: string, dayKey: string, now: number): string | null {
  const [year, month, day] = dayKey.split('-').map(Number)
  const base = new Date(year, month - 1, day, new Date(now).getHours(), new Date(now).getMinutes())
  const offsetOf = (raw: string | undefined): number => {
    const value = Number((raw ?? '').trim())
    return Number.isFinite(value) ? value : 0
  }
  const resolveOne = (expression: string): string | null => {
    const expr = expression.trim()
    if (expr === '') return ''
    // tp.file.creation_date("FMT") / tp.file.creation_date()
    const creation = /^tp\.file\.creation_date\(\s*(?:["']([^"']*)["']\s*)?\)$/u.exec(expr)
    if (creation !== null) return formatDailyStamp(now, creation[1] ?? 'YYYY-MM-DD')
    // tp.date.now("FMT", 偏移天数)
    const nowOffset = /^tp\.date\.now\(\s*(?:["']([^"']*)["']\s*)?(?:,\s*(-?\d+)\s*)?\)$/u.exec(expr)
    if (nowOffset !== null) {
      return formatDailyStamp(
        base.getTime() + offsetOf(nowOffset[2]) * 24 * 60 * 60 * 1000,
        nowOffset[1] ?? 'YYYY-MM-DD'
      )
    }
    // tp.date.yesterday / tomorrow
    const relative = /^tp\.date\.(yesterday|tomorrow)\(\s*(?:["']([^"']*)["']\s*)?\)$/u.exec(expr)
    if (relative !== null) {
      const offset = relative[1] === 'yesterday' ? -1 : 1
      return formatDailyStamp(
        base.getTime() + offset * 24 * 60 * 60 * 1000,
        relative[2] ?? 'YYYY-MM-DD'
      )
    }
    if (expr === 'tp.file.title') return dayKey
    return null
  }

  let unresolved = false
  const replaced = line.replace(/<%\s*([\s\S]*?)\s*%>/gu, (whole, expression: string) => {
    const value = resolveOne(expression)
    if (value === null) {
      unresolved = true
      return whole
    }
    return value
  })
  return unresolved ? null : replaced
}

/** 展开整份模板：去掉 `<%* … %>` 逻辑块、算不出来的行整行跳过 */
export function expandDailyTemplate(
  text: string,
  dayKey: string,
  now: number
): { lines: string[]; skipped: number } {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const raw = source.split(/\r?\n/u)
  const lines: string[] = []
  let skipped = 0
  let inBlock = false
  for (const line of raw) {
    // `<%* … %>`（可能跨行）：整个去掉，连内容一起
    if (inBlock) {
      if (line.includes('%>')) inBlock = false
      continue
    }
    if (/<%[*_]/u.test(line) && !line.includes('%>')) {
      inBlock = true
      continue
    }
    const withoutBlocks = line.replace(/<%[*_][\s\S]*?%>/gu, '')
    if (withoutBlocks !== line && withoutBlocks.trim() === '') {
      // 整行就是一个逻辑块：丢掉
      continue
    }
    const expanded = expandTemplateLine(withoutBlocks, dayKey, now)
    if (expanded === null) {
      skipped += 1
      // 只剩一个空的 callout 头（`> [!quote] 一言`）而其内容行被跳过了：一起丢掉，
      // 别在用户的笔记里留一个空提示块
      const last = lines[lines.length - 1]
      if (last !== undefined && /^\s*>\s*\[!/u.test(last)) lines.pop()
      continue
    }
    lines.push(expanded.replace(/\s+$/u, ''))
  }
  return { lines, skipped }
}

/**
 * 缺当天笔记就建一份。**已存在则什么都不做**（`created: false`）。
 *
 * 展开模板后如果 `# Tracking` / `# Diary` 两段里缺一个，会补上——计划同步与日记写入
 * 都靠这两个标题定位；补标题比让整条链路失败更合理（不碰用户已有的内容）。
 */
export function ensureDailyNote(input: EnsureDailyNoteInput): EnsureDailyNoteResult {
  const file = resolveFile(input)
  if (existsSync(file)) return { file, created: false, template: null, skipped: 0 }
  const now = input.now ?? Date.now()
  const templatePath = resolveDailyTemplate(input.vaultDir, input.templatePath)
  let lines: string[]
  let skipped = 0
  if (templatePath !== null) {
    const expanded = expandDailyTemplate(readFileSync(templatePath, 'utf8'), input.dayKey, now)
    lines = expanded.lines
    skipped = expanded.skipped
  } else {
    lines = skeletonLines(input.dayKey)
  }
  // 模板可能缺段（或被整段跳过）：补标题，保证后续写入有落点
  for (const heading of ['# Tracking', '# Diary']) {
    if (!lines.some((line) => line.trim().toLowerCase() === heading.toLowerCase())) {
      lines.push('', heading, '')
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeDoc(file, { bom: false, eol: '\n', lines })
  return { file, created: true, template: templatePath, skipped }
}

/**
 * ta 追加日记：第一句顶层 `- HH:mm … [❤️]()`，后续句缩进 `  - … [❤️]()`。
 * 只追加，不覆盖已有行；没有 `# Diary` 段就报 `no-section`（模板交给 Obsidian）。
 */
export function appendDiary(input: AppendDiaryInput): DiaryWriteResult {
  const sentences = splitSentences(input.text)
  if (sentences.length === 0) throw new DiaryWriteError('empty-text', '日记正文是空的')
  const time = input.time === undefined ? clockOf(input.now ?? Date.now()) : normalizeClock(input.time)
  if (time === null) throw new DiaryWriteError('bad-time', `时间格式不对：${input.time ?? ''}`)
  return commit(input, (doc) => {
    const range = findSection(doc.lines, 'diary')
    if (range === null) throw new DiaryWriteError('no-section', '当天笔记里没有 # Diary 段')
    const block = sentences.map((sentence, index) =>
      index === 0 ? `- ${time} ${sentence} ${TA_MARK}` : `  - ${sentence} ${TA_MARK}`
    )
    const at = appendIndex(doc.lines, range)
    doc.lines.splice(at, 0, ...block)
    separateFromHeading(doc.lines, at + block.length)
    return { lines: block.length, section: 'diary' as const }
  })
}

/**
 * ta 在 `# Tracking` 里追加一条计划：`- [ ] HH:mm-HH:mm 事项 [❤️]()`。
 * 计划是 ta 的单向账本（用户安排计划走 Obsidian 当天笔记，D57）；只追加，不改已有勾选。
 */
export function appendPlan(input: AppendPlanInput): DiaryWriteResult {
  const sentences = splitSentences(input.text)
  if (sentences.length === 0) throw new DiaryWriteError('empty-text', '计划正文是空的')
  let stamp = ''
  const range = input.time === undefined ? null : TIME_RANGE_RE.exec(input.time.trim())
  if (range !== null) {
    const start = normalizeClock(`${range[1]}:${range[2]}`)
    const end = normalizeClock(`${range[3]}:${range[4]}`)
    if (start === null || end === null) throw new DiaryWriteError('bad-time', `时间格式不对：${input.time ?? ''}`)
    stamp = `${start}-${end}`
  } else {
    const start = normalizeClock(input.time ?? clockOf(input.now ?? Date.now()))
    if (start === null) throw new DiaryWriteError('bad-time', `时间格式不对：${input.time ?? ''}`)
    if (input.end === undefined || input.end.trim() === '') {
      stamp = start
    } else {
      const end = normalizeClock(input.end)
      if (end === null) throw new DiaryWriteError('bad-time', `结束时间格式不对：${input.end}`)
      stamp = `${start}-${end}`
    }
  }
  return commit(input, (doc) => {
    const section = findSection(doc.lines, 'tracking')
    if (section === null) throw new DiaryWriteError('no-section', '当天笔记里没有 # Tracking 段')
    const block = sentences.map((sentence) => `- [ ] ${stamp} ${sentence} ${TA_MARK}`)
    const at = appendIndex(doc.lines, section)
    doc.lines.splice(at, 0, ...block)
    separateFromHeading(doc.lines, at + block.length)
    return { lines: block.length, section: 'tracking' as const }
  })
}

/** 用户行里找唯一目标行；标题 / 导航 / 分隔线不算候选 */
function locateLine(lines: string[], needle: string): { index: number; text: string } {
  const matches: Array<{ index: number; text: string }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (HEADING_RE.test(line) || NAV_RE.test(line) || RULE_RE.test(line)) continue
    if (line.includes(needle)) matches.push({ index, text: line })
  }
  if (matches.length === 0) throw new DiaryWriteError('line-not-found', `找不到这一行：${needle}`)
  if (matches.length > 1) {
    throw new DiaryWriteError('line-ambiguous', `这一段命中 ${matches.length} 行，需要更长的片段`)
  }
  return matches[0]
}

/**
 * ta 评论用户的一行：只插 ` [❤️](正文)`，不动正文 / 时间 / 勾选。
 *
 * 已经带 `[❤️]` 的行（ta 自己写的行，或评论过的行）一律拒绝 —— 一行允许多条评论，
 * 但入口是夜间批量的线程重建，不是这里（§7.2 只评没有标记的行）。
 */
export function insertComment(input: InsertCommentInput): DiaryWriteResult {
  const comment = formatComment(input.comment.trim())
  const needle = input.line.trim()
  if (needle === '') throw new DiaryWriteError('empty-text', '要评论的行不能为空')
  if (input.comment.trim() === '') throw new DiaryWriteError('empty-text', '评论正文是空的')
  return commit(input, (doc) => {
    const target = locateLine(doc.lines, needle)
    const parsed = parseMarks(target.text)
    if (parsed.author === 'ta' || parsed.comments.length > 0) {
      throw new DiaryWriteError('already-commented', '这一行是 ta 写的或已经评论过')
    }
    const anchor = input.after?.trim() ?? ''
    let insertAt = target.text.trimEnd().length
    if (anchor !== '') {
      const first = target.text.indexOf(anchor)
      if (first === -1) throw new DiaryWriteError('anchor-not-found', `行里找不到锚点：${anchor}`)
      if (target.text.indexOf(anchor, first + anchor.length) !== -1) {
        throw new DiaryWriteError('anchor-ambiguous', `锚点出现多次，需要更长的片段：${anchor}`)
      }
      insertAt = first + anchor.length
    }
    const before = target.text.slice(0, insertAt).trimEnd()
    const after = target.text.slice(insertAt).trimStart()
    // 中文标点前不硬塞空格（评论插在「，」前面时保持句子读起来是连着的）
    const glue = after === '' || /^[，。、；：！？）】》」』,.;:!?)]/u.test(after) ? '' : ' '
    doc.lines[target.index] = after === '' ? `${before} ${comment}` : `${before} ${comment}${glue}${after}`
    return { lines: 1, section: sectionAt(doc.lines, target.index) }
  })
}

/* ------------------------------------------------------------------ */
/* 计划区（共建计划的代码同步，自调用 v0.2 §4.1）                      */
/*                                                                     */
/* 只有计划同步器会改用户 Obsidian 的 `# Tracking` 段：                 */
/* - 新建计划 → `appendPlan`（只追加）；                                 */
/* - 改时间 / 改事项 → `updatePlanLine`（原地改那一行，保留勾选状态）；   */
/* - 取消计划 → `removePlanLine`（只删那一行）。                         */
/* 用户日记正文永远不会被模型或同步器改写。                             */
/* ------------------------------------------------------------------ */

export interface PlanLineInput extends DiaryWriteContext {
  /** 计划行里的唯一子串（拿旧事项文本或旧时间戳都能定位；多命中就报错，不猜） */
  match: string
}

export interface UpdatePlanLineInput extends PlanLineInput {
  /** 新的事项（不传 = 只改时间） */
  text?: string
  /** 新的 `HH:mm` / `HH:mm-HH:mm`（不传 = 只改事项） */
  time?: string
}

const PLAN_LINE_RE = /^(\s*-\s*\[[ xX]\]\s*)(\d{1,2}:\d{2}(?:\s*[-–~]\s*\d{1,2}:\d{2})?)?\s*(.*?)(\s*\[(?:❤️|💬)\].*)?$/u

/** 在 `# Tracking` 段里找唯一一条计划行（标题 / 导航 / 分隔线不算） */
function locatePlanLine(
  lines: string[],
  range: { heading: number; end: number },
  needle: string
): { index: number; text: string } {
  const matches: Array<{ index: number; text: string }> = []
  for (let index = range.heading + 1; index < range.end; index += 1) {
    const line = lines[index]
    if (HEADING_RE.test(line) || NAV_RE.test(line) || RULE_RE.test(line)) continue
    if (line.includes(needle)) matches.push({ index, text: line })
  }
  if (matches.length === 0) {
    throw new DiaryWriteError('line-not-found', `计划区里找不到这一条：${needle}`)
  }
  if (matches.length > 1) {
    throw new DiaryWriteError('line-ambiguous', `计划区里命中 ${matches.length} 行，需要更长的片段`)
  }
  return matches[0]
}

/** 拆一条计划行：勾选状态 / 时间 / 事项（保留用户勾过的 `[x]`） */
function parsePlanLine(line: string): { prefix: string; stamp: string; text: string; suffix: string } | null {
  const match = PLAN_LINE_RE.exec(line)
  if (match === null) return null
  return {
    prefix: match[1],
    stamp: (match[2] ?? '').trim(),
    text: (match[3] ?? '').trim(),
    suffix: match[4] ?? ''
  }
}

/**
 * 改计划区里的那一行：时间 / 事项谁给了改谁，勾选状态与 ta 的标记原样保留。
 * 找不到（用户自己删了）报 `line-not-found`，调用方据此只把同步状态记成失败，不动任务本身。
 */
export function updatePlanLine(input: UpdatePlanLineInput): DiaryWriteResult {
  const needle = input.match.trim()
  if (needle === '') throw new DiaryWriteError('empty-text', '要定位的计划行不能为空')
  return commit(input, (doc) => {
    const range = findSection(doc.lines, 'tracking')
    if (range === null) throw new DiaryWriteError('no-section', '当天笔记里没有 # Tracking 段')
    const target = locatePlanLine(doc.lines, range, needle)
    const parsed = parsePlanLine(target.text)
    if (parsed === null) throw new DiaryWriteError('line-not-found', `这一行不是计划行：${needle}`)
    const stamp =
      input.time === undefined ? parsed.stamp : (normalizePlanStamp(input.time) ?? parsed.stamp)
    const text = input.text === undefined ? parsed.text : splitSentences(input.text).join(' ')
    if (text === '') throw new DiaryWriteError('empty-text', '计划事项是空的')
    doc.lines[target.index] = `${parsed.prefix}${stamp === '' ? '' : `${stamp} `}${text}${parsed.suffix}`
    return { lines: 1, section: 'tracking' }
  })
}

/** 取消计划：只删掉那一行（勾过的也删：任务已取消，留着会误导） */
export function removePlanLine(input: PlanLineInput): DiaryWriteResult {
  const needle = input.match.trim()
  if (needle === '') throw new DiaryWriteError('empty-text', '要定位的计划行不能为空')
  return commit(input, (doc) => {
    const range = findSection(doc.lines, 'tracking')
    if (range === null) throw new DiaryWriteError('no-section', '当天笔记里没有 # Tracking 段')
    const target = locatePlanLine(doc.lines, range, needle)
    doc.lines.splice(target.index, 1)
    return { lines: 1, section: 'tracking' }
  })
}

/** `HH:mm` / `HH:mm-HH:mm` 规范化（改计划时间用）；不合法返回 null */
function normalizePlanStamp(value: string): string | null {
  const range = TIME_RANGE_RE.exec(value.trim())
  if (range !== null) {
    const start = normalizeClock(`${range[1]}:${range[2]}`)
    const end = normalizeClock(`${range[3]}:${range[4]}`)
    return start === null || end === null ? null : `${start}-${end}`
  }
  return normalizeClock(value)
}
