/**
 * 任务记忆 · `mem_tasks` 读写（自调用方案 v0.2 §5–§6）
 *
 * 这张表是**持久化意图队列**：计划（与用户共建）与自主任务共存，用 `origin` 区分。
 * 本模块只回答四件事：
 *
 * 1. 新意图怎么落库（`createTask`）——参数在这里钳死，模型给什么都不信；
 * 2. 四种视图怎么查（`searchTasks`：pending / day / upcoming / about）；
 * 3. 时间怎么推进（`settleTask`：重复任务只推 `next_due_at`，不标完成）；
 * 4. 同一次 occurrence 怎么只执行一次（`claimTask` 的 `run_key` 租约）。
 *
 * 不碰模型、不碰网络、不碰 Obsidian 文件；到点后「说什么」由调度器和主进程决定，
 * 「记什么」只在这里。纯数据库操作，钟由调用方注入，测试可固定。
 */

import type { Db } from '../../db'

/** 来源：user = 与用户共建的计划；agent = ta 自己形成的后续意图；system = 系统例行 */
export type TaskOrigin = 'user' | 'agent' | 'system'
/** 交付：foreground 可开口；background 不打断当前回答；auto 由本轮结合上下文决定 */
export type TaskDelivery = 'foreground' | 'background' | 'auto'
/** 重复种类：空 = 一次性 */
export type RepeatKind = '' | 'daily' | 'weekly' | 'monthly' | 'yearly'
/**
 * 重复的持久化文本：`''` / `daily` / `weekly` / `weekly:1,3,5` / `monthly:1,15` / `yearly:11-01`。
 * - weekly 的周几用 ISO 口径（1=周一 … 7=周日），monthly 的几号用 1–31；都升序去重；
 * - yearly 用 `MM-DD`（本地日历；平年 2-29 钳到 2 月 28，不跳过这一年）；
 * - 裸 `weekly` / `monthly` / `yearly`（没有列表 / 日期）=「沿用当前 occurrence」，只为兼容旧行；
 *   新写入的都会由 `resolveRepeat` 补成显式值，避免短月钳制后日号漂移。
 */
export type TaskRepeat = string
/** 业务状态：`due` 是派生状态，「正在跑」是进程内租约，都不写进这里 */
export type TaskState = 'active' | 'paused' | 'completed' | 'cancelled'
/** 共建计划在用户 Obsidian 计划区的同步状态；空 = 不需要同步（自主任务 / 系统任务） */
export type TaskSyncState = '' | 'synced' | 'pending' | 'failed' | 'removed'

/** 解析后的重复规则（空 kind = 一次性） */
export interface RepeatRule {
  kind: RepeatKind
  /** weekly 的周几（1–7，升序去重）；空 = 沿用当前 occurrence 的星期几 */
  weekdays: number[]
  /** monthly 的几号（1–31，升序去重）；空 = 沿用当前 occurrence 的日号 */
  monthDays: number[]
  /** yearly 的月（1–12）；空 = 沿用当前 occurrence 的月 */
  yearlyMonth: number | null
  /** yearly 的日（1–31；2-29 合法，平年推进时钳到 2-28） */
  yearlyDay: number | null
}

export const TASK_ORIGINS: readonly TaskOrigin[] = ['user', 'agent', 'system']
export const TASK_DELIVERIES: readonly TaskDelivery[] = ['foreground', 'background', 'auto']

/** 库内行（列名即 snake_case，不做二次映射，避免字段漂移） */
export interface TaskRow {
  id: number
  instruction: string
  next_due_at: number | null
  repeat: TaskRepeat
  origin: TaskOrigin
  delivery: TaskDelivery
  valid_until: number | null
  state: TaskState
  last_run_at: number | null
  run_key: string | null
  obsidian_state: TaskSyncState
  obsidian_path: string | null
  obsidian_note: string | null
  created_at: number
  updated_at: number
}

export interface NewTaskInput {
  instruction: string
  /** 下一次到点的本地毫秒时间戳；null = 只记着，不到点叫醒（如「以后别这样」） */
  nextDueAt: number | null
  origin: TaskOrigin
  repeat?: TaskRepeat
  delivery?: TaskDelivery
  /** 超过这个时间不再补做；null = 一直有效 */
  validUntil?: number | null
  obsidianState?: TaskSyncState
  obsidianPath?: string | null
  obsidianNote?: string | null
  /** 固定钟（测试注入）；默认 `Date.now()` */
  now?: number
}

export interface TaskUpdateInput {
  id: number
  instruction?: string
  nextDueAt?: number | null
  repeat?: TaskRepeat
  delivery?: TaskDelivery
  validUntil?: number | null
  state?: TaskState
  obsidianState?: TaskSyncState
  obsidianPath?: string | null
  obsidianNote?: string | null
  now?: number
}

export type TaskView = 'pending' | 'day' | 'upcoming' | 'about'

export interface TaskSearchQuery {
  view: TaskView
  /** `day` 视图必填：本地日期 `YYYY-MM-DD` */
  day?: string
  /** `about` 视图必填：事项关键词（简单文本匹配，不做向量） */
  query?: string
  limit?: number
  now: number
}

/** 视图里多一个 `occurrence_at`：`day` 视图下这次任务在这一天几点发生 */
export interface TaskViewRow extends TaskRow {
  occurrence_at?: number
}

export interface TaskSearchResult {
  view: TaskView
  tasks: TaskViewRow[]
  /** 命中总数（不是返回条数）——截断时模型不能把结果说成全部 */
  total: number
  truncated: boolean
}

export const TASK_INSTRUCTION_MAX = 500
export const TASK_QUERY_MAX = 60
export const TASK_LIMIT_DEFAULT = 20
export const TASK_LIMIT_MAX = 50

const DAY_MS = 24 * 60 * 60 * 1000
const IDLE_LIMIT = 400

/* ------------------------------------------------------------------ */
/* 时间与格式：全部用本地时区（用户的「明天九点」是本地的九点）        */
/* ------------------------------------------------------------------ */

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 毫秒 → 本地 `YYYY-MM-DD` */
export function dayKeyOf(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地某一天的闭开区间 `[from, to)`；日期不合法返回 null（不猜） */
export function dayWindow(dayKey: string): { from: number; to: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const from = new Date(year, month - 1, day).getTime()
  if (!Number.isFinite(from)) return null
  const probe = new Date(from)
  // 2026-02-30 这类「滚月」的日期不算合法
  if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null
  return { from, to: new Date(year, month - 1, day + 1).getTime() }
}

/* ------------------------------------------------------------------ */
/* 重复规则：解析 / 规范化 / 推进                                       */
/* ------------------------------------------------------------------ */

/** ISO 周几：1=周一 … 7=周日（JS 的 0=周日 不直接外露） */
export function isoWeekdayOf(ts: number): number {
  const day = new Date(ts).getDay()
  return day === 0 ? 7 : day
}

/** 去重、升序，只留 [min, max] 内的整数；怪值直接丢（不猜） */
function cleanDays(values: readonly number[] | undefined, min: number, max: number): number[] {
  if (values === undefined) return []
  const unique = new Set<number>()
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isInteger(value)) continue
    if (value < min || value > max) continue
    unique.add(value)
  }
  return [...unique].sort((a, b) => a - b)
}

/** weekly 的周几（1–7） */
export function cleanWeekdays(values: readonly number[] | undefined): number[] {
  return cleanDays(values, 1, 7)
}

/** monthly 的几号（1–31） */
export function cleanMonthDays(values: readonly number[] | undefined): number[] {
  return cleanDays(values, 1, 31)
}

/** 某年某月（1–12）有多少天 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * yearly 的月 / 日：两个都给且合法才算数（用 2028 闰年校验，2-29 合法、2-30 不合法）。
 * 只给一个 / 都不给 → null（由 `resolveRepeat` 从第一次到点补）。
 */
function cleanYearlyDate(
  month: number | null | undefined,
  day: number | null | undefined
): { month: number; day: number } | null {
  if (month == null || day == null) return null
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(2028, month)) return null
  return { month, day }
}

/** 解析持久化文本；认不出的一律当一次性（不写坏枚举，与旧版口径一致） */
export function parseRepeat(value: string | null | undefined): RepeatRule {
  const empty: RepeatRule = {
    kind: '',
    weekdays: [],
    monthDays: [],
    yearlyMonth: null,
    yearlyDay: null
  }
  if (typeof value !== 'string') return empty
  const text = value.trim().toLowerCase()
  if (text === '') return empty
  if (text === 'daily') {
    return { kind: 'daily', weekdays: [], monthDays: [], yearlyMonth: null, yearlyDay: null }
  }
  const match = /^(weekly|monthly|yearly)(?::(.+))?$/u.exec(text)
  if (match === null) return empty
  if (match[1] === 'yearly') {
    if (match[2] === undefined) {
      return { kind: 'yearly', weekdays: [], monthDays: [], yearlyMonth: null, yearlyDay: null }
    }
    const date = /^(\d{1,2})-(\d{1,2})$/u.exec(match[2].trim())
    if (date === null) return empty
    const cleaned = cleanYearlyDate(Number(date[1]), Number(date[2]))
    if (cleaned === null) return empty
    return {
      kind: 'yearly',
      weekdays: [],
      monthDays: [],
      yearlyMonth: cleaned.month,
      yearlyDay: cleaned.day
    }
  }
  const kind: RepeatKind = match[1] === 'weekly' ? 'weekly' : 'monthly'
  const max = kind === 'weekly' ? 7 : 31
  const parsed: number[] = []
  if (match[2] !== undefined) {
    for (const part of match[2].split(',')) {
      if (!/^\d{1,2}$/u.test(part.trim())) return empty
      const day = Number(part)
      if (day < 1 || day > max) return empty
      parsed.push(day)
    }
  }
  const days = cleanDays(parsed, 1, max)
  return {
    kind,
    weekdays: kind === 'weekly' ? days : [],
    monthDays: kind === 'monthly' ? days : [],
    yearlyMonth: null,
    yearlyDay: null
  }
}

/** 规则 → 持久化文本（空 = 一次性；列表会去重升序，调用方不用先清洗） */
export function formatRepeat(rule: RepeatRule): string {
  if (rule.kind === 'daily') return 'daily'
  if (rule.kind === 'weekly') {
    const days = cleanDays(rule.weekdays, 1, 7)
    return days.length === 0 ? 'weekly' : `weekly:${days.join(',')}`
  }
  if (rule.kind === 'monthly') {
    const days = cleanDays(rule.monthDays, 1, 31)
    return days.length === 0 ? 'monthly' : `monthly:${days.join(',')}`
  }
  if (rule.kind === 'yearly') {
    const date = cleanYearlyDate(rule.yearlyMonth, rule.yearlyDay)
    return date === null ? 'yearly' : `yearly:${pad2(date.month)}-${pad2(date.day)}`
  }
  return ''
}

/**
 * 把「种类 + 可选的周几 / 几号 / 月日」落成持久化文本。
 * 没给列表时用 `anchor`（第一次到点）补出来——这样短月钳制之后日号不会漂
 * （1 月 31 号 → 2 月 28 号，下一次仍是 3 月 31 号，而不是 3 月 28 号）。
 */
export function resolveRepeat(input: {
  kind: RepeatKind
  weekdays?: readonly number[] | undefined
  monthDays?: readonly number[] | undefined
  yearlyMonth?: number | null | undefined
  yearlyDay?: number | null | undefined
  anchor?: number | null | undefined
}): string {
  if (input.kind === '' || input.kind === 'daily') return input.kind
  const weekdays = cleanWeekdays(input.weekdays)
  const monthDays = cleanMonthDays(input.monthDays)
  if (input.kind === 'weekly' && weekdays.length === 0 && input.anchor != null) {
    weekdays.push(isoWeekdayOf(input.anchor))
  }
  if (input.kind === 'monthly' && monthDays.length === 0 && input.anchor != null) {
    monthDays.push(new Date(input.anchor).getDate())
  }
  if (input.kind === 'yearly') {
    let date = cleanYearlyDate(input.yearlyMonth, input.yearlyDay)
    if (date === null && input.anchor != null) {
      const at = new Date(input.anchor)
      date = cleanYearlyDate(at.getMonth() + 1, at.getDate())
    }
    return formatRepeat({
      kind: 'yearly',
      weekdays,
      monthDays,
      yearlyMonth: date?.month ?? null,
      yearlyDay: date?.day ?? null
    })
  }
  return formatRepeat({ kind: input.kind, weekdays, monthDays, yearlyMonth: null, yearlyDay: null })
}

/** 不早于 / 晚于 `ts` 的下一次 weekly occurrence（同一天同一钟点；跨周用日历加天） */
function nextWeeklyAt(ts: number, rule: RepeatRule, inclusive: boolean): number | null {
  const source = new Date(ts)
  const days = rule.weekdays.length > 0 ? rule.weekdays : [isoWeekdayOf(ts)]
  for (let step = 0; step <= 7; step += 1) {
    if (step === 0 && !inclusive) continue
    const candidate = new Date(source)
    candidate.setDate(source.getDate() + step)
    if (days.includes(isoWeekdayOf(candidate.getTime()))) return candidate.getTime()
  }
  return null
}

/**
 * 下一次 monthly occurrence：在当月 / 后面 24 个月里找所选日号。
 * 短月没有这一号就钳到当月最后一天（如 31 号 → 2 月 28 号）；多个日号钳到同一天只算一次。
 */
function nextMonthlyAt(ts: number, rule: RepeatRule, inclusive: boolean): number | null {
  const source = new Date(ts)
  const days = rule.monthDays.length > 0 ? rule.monthDays : [source.getDate()]
  const hour = source.getHours()
  const minute = source.getMinutes()
  const second = source.getSeconds()
  const millisecond = source.getMilliseconds()
  for (let offset = 0; offset <= 24; offset += 1) {
    const monthStart = new Date(source.getFullYear(), source.getMonth() + offset, 1)
    const year = monthStart.getFullYear()
    const month = monthStart.getMonth()
    const lastDay = new Date(year, month + 1, 0).getDate()
    const effective = [...new Set(days.map((day) => Math.min(day, lastDay)))].sort((a, b) => a - b)
    for (const day of effective) {
      const candidate = new Date(year, month, day, hour, minute, second, millisecond).getTime()
      if (candidate > ts || (inclusive && candidate === ts)) return candidate
    }
  }
  return null
}

function nextOccurrenceAt(ts: number, rule: RepeatRule, inclusive: boolean): number | null {
  if (rule.kind === 'weekly') return nextWeeklyAt(ts, rule, inclusive)
  if (rule.kind === 'monthly') return nextMonthlyAt(ts, rule, inclusive)
  if (rule.kind === 'yearly') return nextYearlyAt(ts, rule, inclusive)
  return null
}

/**
 * 下一次 yearly occurrence：在当年 / 后面 8 年里找所选月日。
 * 平年没有 2-29 就钳到 2 月 28（不跳过这一年）。
 */
function nextYearlyAt(ts: number, rule: RepeatRule, inclusive: boolean): number | null {
  const source = new Date(ts)
  const month = rule.yearlyMonth ?? source.getMonth() + 1
  const day = rule.yearlyDay ?? source.getDate()
  const hour = source.getHours()
  const minute = source.getMinutes()
  const second = source.getSeconds()
  const millisecond = source.getMilliseconds()
  for (let offset = 0; offset <= 8; offset += 1) {
    const year = source.getFullYear() + offset
    const effectiveDay = Math.min(day, daysInMonth(year, month))
    const candidate = new Date(year, month - 1, effectiveDay, hour, minute, second, millisecond).getTime()
    if (candidate > ts || (inclusive && candidate === ts)) return candidate
  }
  return null
}

/**
 * 把「第一次到点」归一到规则上：weekly / monthly / yearly 时返回不小于 `at` 的第一次 occurrence
 * （规则是每周一三五、when 落在周二 → 顺延到周三；当天的钟点不变）。
 * 一次性 / 每天 / `at` 为空时原样返回。
 */
export function alignFirstOccurrence(at: number | null, repeat: TaskRepeat): number | null {
  if (at === null) return null
  const rule = parseRepeat(repeat)
  if (rule.kind === '' || rule.kind === 'daily') return at
  return nextOccurrenceAt(at, rule, true) ?? at
}

/**
 * 按日历推下一次（不用 +86400000：跨月 / 跨年 / 月长都要分开算）；
 * weekly 落在所选周几里，monthly 落在所选日号（短月钳到月末），yearly 落在所选月日（平年 2-29 钳到 2-28）。
 */
export function advanceOccurrence(ts: number, repeat: TaskRepeat): number {
  const rule = parseRepeat(repeat)
  if (rule.kind === '') return ts
  if (rule.kind === 'daily') {
    const date = new Date(ts)
    date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  return nextOccurrenceAt(ts, rule, false) ?? ts
}

/** 毫秒 → 人话时间（`10-31 09:30`；跨年补年份），供回执与工具结果使用 */
export function readableTaskTime(ts: number | null, now: number): string {
  if (ts === null) return '未定时间'
  const date = new Date(ts)
  const sameYear = new Date(now).getFullYear() === date.getFullYear()
  const stamp = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return sameYear ? stamp : `${date.getFullYear()}-${stamp}`
}

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/**
 * 重复规则的人话（空字符串 = 一次性）。
 * 裸 `weekly` / `monthly`（旧行）没有列表时按 `nextDueAt` 的星期几 / 日号来说。
 */
export function describeRepeat(repeat: TaskRepeat, nextDueAt?: number | null): string {
  const rule = parseRepeat(repeat)
  if (rule.kind === 'daily') return '每天'
  if (rule.kind === 'weekly') {
    const days =
      rule.weekdays.length > 0
        ? rule.weekdays
        : nextDueAt != null
          ? [isoWeekdayOf(nextDueAt)]
          : []
    return days.length === 0 ? '每周' : `每周${days.map((day) => WEEKDAY_LABELS[day - 1]).join('、')}`
  }
  if (rule.kind === 'monthly') {
    const days =
      rule.monthDays.length > 0
        ? rule.monthDays
        : nextDueAt != null
          ? [new Date(nextDueAt).getDate()]
          : []
    return days.length === 0 ? '每月' : `每月 ${days.join('、')} 号`
  }
  if (rule.kind === 'yearly') {
    const month =
      rule.yearlyMonth ?? (nextDueAt != null ? new Date(nextDueAt).getMonth() + 1 : null)
    const day = rule.yearlyDay ?? (nextDueAt != null ? new Date(nextDueAt).getDate() : null)
    return month == null || day == null ? '每年' : `每年 ${month} 月 ${day} 日`
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* 参数归一（模型输出不可信：类型、长度、枚举都在这里钳）              */
/* ------------------------------------------------------------------ */

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxChars)
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function optionalStamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TASK_LIMIT_DEFAULT
  return Math.min(TASK_LIMIT_MAX, Math.max(1, Math.round(value)))
}

/* ------------------------------------------------------------------ */
/* 写：新建 / 修改 / 取消                                              */
/* ------------------------------------------------------------------ */

const TASK_COLUMNS = `id, instruction, next_due_at, repeat, origin, delivery, valid_until,
  state, last_run_at, run_key, obsidian_state, obsidian_path, obsidian_note, created_at, updated_at`

function selectById(db: Db, id: number): TaskRow | null {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM mem_tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined
  return row ?? null
}

/** 按 id 读一条（找不到返回 null，调用方如实回「没有这条」） */
export function getTaskById(db: Db, id: number): TaskRow | null {
  return selectById(db, id)
}

/** 新建一条任务 / 计划，返回完整持久化记录（回执只认这条记录，不认模型的嘴） */
export function createTask(db: Db, input: NewTaskInput): TaskRow {
  const instruction = cleanText(input.instruction, TASK_INSTRUCTION_MAX)
  if (instruction === '') throw new Error('任务说明是空的：没有记下任何计划')
  const origin = pick<TaskOrigin>(input.origin, TASK_ORIGINS, 'agent')
  const delivery = pick<TaskDelivery>(input.delivery ?? 'auto', TASK_DELIVERIES, 'auto')
  const now = input.now ?? Date.now()
  const due = optionalStamp(input.nextDueAt)
  const parsedRepeat = parseRepeat(input.repeat ?? '')
  const repeat = resolveRepeat({
    kind: parsedRepeat.kind,
    weekdays: parsedRepeat.weekdays,
    monthDays: parsedRepeat.monthDays,
    yearlyMonth: parsedRepeat.yearlyMonth,
    yearlyDay: parsedRepeat.yearlyDay,
    anchor: due
  })
  const firstDue = alignFirstOccurrence(due, repeat)
  const result = db
    .prepare(
      `INSERT INTO mem_tasks
         (instruction, next_due_at, repeat, origin, delivery, valid_until, state,
          obsidian_state, obsidian_path, obsidian_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
    .run(
      instruction,
      firstDue,
      repeat,
      origin,
      delivery,
      optionalStamp(input.validUntil),
      pick<TaskSyncState>(input.obsidianState ?? '', ['', 'synced', 'pending', 'failed', 'removed'], ''),
      input.obsidianPath ?? null,
      input.obsidianNote ?? null,
      now,
      now
    )
  const created = selectById(db, Number(result.lastInsertRowid))
  if (created === null) throw new Error('任务写入后读不回来：数据库异常')
  return created
}

/**
 * 按 id 修改。只有显式给了的字段才动（`nextDueAt: null` = 明确清空定时）。
 * 找不到 id 返回 null（调用方据此如实回「没有这条任务」）。
 */
export function updateTask(db: Db, input: TaskUpdateInput): TaskRow | null {
  const current = selectById(db, input.id)
  if (current === null) return null
  const now = input.now ?? Date.now()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (input.instruction !== undefined) {
    const instruction = cleanText(input.instruction, TASK_INSTRUCTION_MAX)
    if (instruction === '') throw new Error('任务说明不能改成空的')
    push('instruction', instruction)
  }
  // 重复与到点是一对：改了任一项就把「下一次」归一到规则上，避免出现
  // 「每周一三五」这条任务的下一次却排在周二这种自相矛盾的行。
  const hasRepeat = input.repeat !== undefined
  const hasDue = input.nextDueAt !== undefined
  let repeatText = current.repeat
  if (hasRepeat) {
    const parsed = parseRepeat(input.repeat)
    repeatText = resolveRepeat({
      kind: parsed.kind,
      weekdays: parsed.weekdays,
      monthDays: parsed.monthDays,
      yearlyMonth: parsed.yearlyMonth,
      yearlyDay: parsed.yearlyDay,
      anchor: hasDue ? optionalStamp(input.nextDueAt) : current.next_due_at
    })
  }
  let due = hasDue ? optionalStamp(input.nextDueAt) : current.next_due_at
  if ((hasRepeat || hasDue) && repeatText !== '') due = alignFirstOccurrence(due, repeatText)
  if (hasRepeat) push('repeat', repeatText)
  if (hasDue || due !== current.next_due_at) push('next_due_at', due)
  if (input.delivery !== undefined) {
    push('delivery', pick<TaskDelivery>(input.delivery, TASK_DELIVERIES, 'auto'))
  }
  if (input.validUntil !== undefined) push('valid_until', optionalStamp(input.validUntil))
  if (input.state !== undefined) {
    push('state', pick<TaskState>(input.state, ['active', 'paused', 'completed', 'cancelled'], 'active'))
  }
  if (input.obsidianState !== undefined) {
    push(
      'obsidian_state',
      pick<TaskSyncState>(input.obsidianState, ['', 'synced', 'pending', 'failed', 'removed'], '')
    )
  }
  if (input.obsidianPath !== undefined) push('obsidian_path', input.obsidianPath)
  if (input.obsidianNote !== undefined) push('obsidian_note', input.obsidianNote)
  if (sets.length === 0) return current
  push('updated_at', now)
  db.prepare(`UPDATE mem_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, input.id)
  return selectById(db, input.id)
}

/** 取消（不删行：回执、审计与「我不想它再出现」都还要看得见这条任务） */
export function cancelTask(db: Db, id: number, now = Date.now()): TaskRow | null {
  const current = selectById(db, id)
  if (current === null) return null
  db.prepare(
    `UPDATE mem_tasks SET state = 'cancelled', updated_at = ? WHERE id = ? AND state <> 'cancelled'`
  ).run(now, id)
  return selectById(db, id)
}

/* ------------------------------------------------------------------ */
/* 调度：最近到点、到点列表、执行租约                                  */
/* ------------------------------------------------------------------ */

/** 最近的到点任务（调度器只睡到这一条；没有就返回 null，不留永久轮询） */
export function nextDueTask(db: Db): TaskRow | null {
  const row = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM mem_tasks
       WHERE state = 'active' AND next_due_at IS NOT NULL
       ORDER BY next_due_at ASC, id ASC
       LIMIT 1`
    )
    .get() as TaskRow | undefined
  return row ?? null
}

/** 已到点、还该跑的任务（跳过过期任务：`valid_until` 过了就不再补做） */
export function listDueTasks(db: Db, now: number, limit = 20): TaskRow[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM mem_tasks
       WHERE state = 'active' AND next_due_at IS NOT NULL AND next_due_at <= ?
         AND (valid_until IS NULL OR valid_until >= ?)
       ORDER BY next_due_at ASC, id ASC
       LIMIT ?`
    )
    .all(now, now, limit) as TaskRow[]
}

/** 过期（`valid_until` 已过）的活动任务：只用来告知，不再执行 */
export function listExpiredTasks(db: Db, now: number, limit = 20): TaskRow[] {  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM mem_tasks
       WHERE state = 'active' AND next_due_at IS NOT NULL AND next_due_at <= ?
         AND valid_until IS NOT NULL AND valid_until < ?
       ORDER BY next_due_at ASC, id ASC
       LIMIT ?`
    )
    .all(now, now, limit) as TaskRow[]
}

/**
 * 把「过了有效期还没跑」的活动任务收掉（过期不补发，v0.2 §9）。
 *
 * 必须在取下一次到点**之前**调用：否则一条过期任务永远排在队首，
 * 调度器会每一轮都醒来、每一轮都跳过它（空转）。
 * 收成 `completed` 而不是 `cancelled`：它确实过期了，但不是用户取消的。
 */
export function expireTasks(db: Db, now: number): number {
  const result = db
    .prepare(
      `UPDATE mem_tasks SET state = 'completed', updated_at = ?
       WHERE state = 'active' AND valid_until IS NOT NULL AND valid_until < ?
         AND (next_due_at IS NULL OR next_due_at <= ?)`
    )
    .run(now, now, now)
  return result.changes
}

/** 任务里有几个还活着的（设置抽屉 / 状态行用） */
export function countActiveTasks(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM mem_tasks WHERE state = 'active'`).get() as {
    n: number
  }
  return row.n
}

/** 活着（active / paused）的条数：设置抽屉「任务」块的总数 */
export function countLiveTasks(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM mem_tasks WHERE state IN ('active', 'paused')`)
    .get() as { n: number }
  return row.n
}

/**
 * 设置抽屉用：还活着的任务（active / paused），active 在前、按到点时间排。
 * 取消 / 完成的不列（与 `/tasks` 的 pending 视图不同：这里要把暂停的也显示出来，
 * 才能点「继续」）。
 */
export function listLiveTasks(db: Db, limit = 50): TaskRow[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM mem_tasks
       WHERE state IN ('active', 'paused')
       ORDER BY (state = 'paused') ASC, (next_due_at IS NULL) ASC, next_due_at ASC, id ASC
       LIMIT ?`
    )
    .all(limit) as TaskRow[]
}

/** 一次执行计划的固定键：同一个 id + 同一个 next_due_at 就是同一次 occurrence */
export function occurrenceKey(task: TaskRow): string {
  return `${task.id}:${task.next_due_at ?? 0}`
}

/**
 * 抢执行租约（单飞 + 去重）。返回 null = 这条不归本次跑：
 * 已经被别的轮次执行过（`run_key` 相同），或中途被取消 / 改了时间。
 *
 * 为什么不用内存里的 Set：重启后内存清空，`run_key` 落在库里才能「重启不重复」。
 */
export function claimTask(db: Db, id: number, now = Date.now()): TaskRow | null {
  const current = selectById(db, id)
  if (current === null || current.state !== 'active') return null
  const key = occurrenceKey(current)
  if (current.run_key === key) return null
  const result = db
    .prepare(
      `UPDATE mem_tasks SET run_key = ?, updated_at = ?
       WHERE id = ? AND state = 'active' AND IFNULL(next_due_at, 0) = ? AND IFNULL(run_key, '') <> ?`
    )
    .run(key, now, id, current.next_due_at ?? 0, key)
  if (result.changes !== 1) return null
  return selectById(db, id)
}

export interface TaskOutcome {
  /** 明确收尾：completed / paused / cancelled；不传就按重复规则自动推进 */
  state?: TaskState
  /** 延后到什么时候（任务仍保持 active）；不传就按重复规则推进或完成 */
  nextDueAt?: number | null
  /** 本次执行时间；默认 now */
  ranAt?: number
}

/**
 * 执行完之后结算：
 * - 明确给了 `state` → 照办；
 * - 给了 `nextDueAt` → 延后（保持 active）；
 * - 重复任务 → 把 `next_due_at` 推到下一次（跨过已经过去的若干次，不补发）；
 * - 一次性任务 → `completed`。
 * 无论哪条，`last_run_at` 只在真的跑过之后才写。
 */
export function settleTask(db: Db, id: number, outcome: TaskOutcome, now = Date.now()): TaskRow | null {
  const current = selectById(db, id)
  if (current === null) return null
  const ranAt = outcome.ranAt ?? now
  if (outcome.state !== undefined) {
    return updateTask(db, {
      id,
      state: outcome.state,
      obsidianState:
        current.origin === 'user' && outcome.state === 'cancelled' ? 'removed' : undefined,
      now
    })
  }
  if (outcome.nextDueAt !== undefined) {
    return updateTask(db, { id, nextDueAt: outcome.nextDueAt, state: 'active', now })
  }
  if (current.repeat !== '' && current.next_due_at !== null) {
    let next = advanceOccurrence(current.next_due_at, current.repeat)
    let guard = 0
    while (next <= now && guard < IDLE_LIMIT) {
      next = advanceOccurrence(next, current.repeat)
      guard += 1
    }
    db.prepare(
      `UPDATE mem_tasks SET next_due_at = ?, state = 'active', last_run_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(next, ranAt, now, id)
    return selectById(db, id)
  }
  db.prepare(
    `UPDATE mem_tasks SET state = 'completed', last_run_at = ?, updated_at = ? WHERE id = ?`
  ).run(ranAt, now, id)
  return selectById(db, id)
}

/* ------------------------------------------------------------------ */
/* 查：四种视图                                                        */
/* ------------------------------------------------------------------ */

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/gu, (char) => `\\${char}`)
}

/**
 * 一条任务在 `[from, to)` 里有没有 occurrence；有就返回那次的时间戳。
 * - 一次性：`next_due_at` 落在这个窗口里才算；
 * - 重复：从 `next_due_at` 按日历往前推，落在窗口里才算（过期任务也算，
 *   它本来就欠着这一次，`pending` 会把它列出来）。
 */
export function occurrenceInWindow(
  task: TaskRow,
  from: number,
  to: number
): number | null {
  const due = task.next_due_at
  if (due === null) return null
  if (task.repeat === '') return due >= from && due < to ? due : null
  let at = due
  let guard = 0
  while (at < from && guard < IDLE_LIMIT * 8) {
    at = advanceOccurrence(at, task.repeat)
    guard += 1
  }
  return at >= from && at < to ? at : null
}

/**
 * 四种视图（v0.2 §6.2）：
 * - `pending`：所有活动任务，包括已过期但还没处理的那条（按到点时间升序，没时间的排最后）；
 * - `day`：本地某一天会发生的任务，重复任务按日历算出当天那次；
 * - `upcoming`：从现在往后的活动任务，只给任务本身与下一次时间，不无限展开；
 * - `about`：按事项关键词匹配（第一版简单文本匹配，不做向量）。
 */
export function searchTasks(db: Db, query: TaskSearchQuery): TaskSearchResult {
  const limit = clampLimit(query.limit)
  const view = query.view
  let candidates: TaskViewRow[] = []

  if (view === 'pending') {
    candidates = db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM mem_tasks WHERE state = 'active'
         ORDER BY (next_due_at IS NULL) ASC, next_due_at ASC, id ASC`
      )
      .all() as TaskViewRow[]
  } else if (view === 'upcoming') {
    candidates = db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM mem_tasks
         WHERE state = 'active' AND next_due_at IS NOT NULL AND next_due_at >= ?
         ORDER BY next_due_at ASC, id ASC`
      )
      .all(query.now) as TaskViewRow[]
  } else if (view === 'day') {
    const window = dayWindow(query.day ?? '')
    if (window === null) throw new Error(`日期格式不对：${query.day ?? ''}（要 YYYY-MM-DD）`)
    const rows = db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM mem_tasks
         WHERE state = 'active' AND next_due_at IS NOT NULL
         ORDER BY next_due_at ASC, id ASC`
      )
      .all() as TaskViewRow[]
    candidates = []
    for (const row of rows) {
      const at = occurrenceInWindow(row, window.from, window.to)
      if (at !== null) candidates.push({ ...row, occurrence_at: at })
    }
    candidates.sort((a, b) => (a.occurrence_at ?? 0) - (b.occurrence_at ?? 0) || a.id - b.id)
  } else {
    const needle = cleanText(query.query, TASK_QUERY_MAX)
    if (needle === '') throw new Error('about 视图要给一个关键词')
    candidates = db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM mem_tasks
         WHERE state <> 'cancelled' AND instruction LIKE ? ESCAPE '\\'
         ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, next_due_at ASC, id ASC`
      )
      .all(`%${escapeLike(needle)}%`) as TaskViewRow[]
  }

  const total = candidates.length
  return {
    view,
    tasks: candidates.slice(0, limit),
    total,
    truncated: total > limit
  }
}

/** `day` 视图里今天还没到的条数（状态行用；不算过期任务） */
export function countDueToday(db: Db, now: number): number {
  const window = dayWindow(dayKeyOf(now))
  if (window === null) return 0
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM mem_tasks WHERE state = 'active' AND next_due_at IS NOT NULL`
    )
    .all() as TaskRow[]
  let count = 0
  for (const row of rows) {
    if (occurrenceInWindow(row, window.from, window.to) !== null) count += 1
  }
  return count
}

/** 距离下一条任务到点还有多少毫秒（没有到点任务时返回 null） */
export function msUntilNextDue(db: Db, now: number): number | null {
  const next = nextDueTask(db)
  if (next?.next_due_at == null) return null
  return next.next_due_at - now
}

/** 给状态行 / 工具结果用的一句话 */
export function describeTask(task: TaskRow, now: number): string {
  const when = readableTaskTime(task.next_due_at, now)
  const repeat = describeRepeat(task.repeat, task.next_due_at)
  const origin = task.origin === 'user' ? '共建' : task.origin === 'agent' ? '自主' : '例行'
  const state =
    task.state === 'completed'
      ? ' · 已完成'
      : task.state === 'cancelled'
        ? ' · 已取消'
        : task.state === 'paused'
          ? ' · 已暂停'
          : ''
  const sync =
    task.obsidian_state === 'failed'
      ? ' · Obsidian 未同步'
      : task.obsidian_state === 'pending'
        ? ' · Obsidian 待同步'
        : ''
  return `#${task.id} ${when}${repeat === '' ? '' : `（${repeat}）`} · ${origin} · ${task.instruction}${state}${sync}`
}

export { DAY_MS }
