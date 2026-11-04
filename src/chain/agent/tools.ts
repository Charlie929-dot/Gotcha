/**
 * 信息链 · 问记忆工具循环的工具层（toolloop）
 *
 * 三个工具（方案定稿）：
 * - `search_info`：模型拆好的 keywords[] 逐词 OR（修「整句 LIKE 搜不到」的根因 2），
 *   可选 semantic 走向量弱信号；**includeOpen 硬编码 true**（修「漏开段」的根因 3）；
 *   多路结果本地 RRF（k=60，与 `query.ts` 同口径）合并排名；
 * - `get_freshness`：数据边界（根因 5）；
 * - `ask_history`：最近问答记录摘要。
 *
 * 2026-10-27 补 `read_segment`：命中摘要只有 80 字，地址栏 / URL / 完整 OCR 在正文里；
 * 不给「打开这一段」的工具，模型只能对摘要下结论（真实记录里因此误报「没有链接」）。
 * 只能展开 search_info 返回过、且没被脱敏整条挡下的段。
 *
 * 2026-10-29 补个人记忆（第二本账）：`recall_diary` / `read_diary` / `memory_profile`。
 * 日记条目按 itemId 走**独立白名单**（`AskToolOutcome.memories`），与屏幕段 id 不混用；
 * 最终答复里的 `memories[]` 由 `parse.ts` 按这份白名单校验，编造的一律剥掉。
 *
 * 只回**摘要**不回正文全文（snippet ≤80 字），正文证据等最终引用时由
 * `readSegmentEvidence()` 反查——工具结果小，循环轮数多也不至于把 token 撑爆。
 * 不设 present-info 工具：最终 JSON 的 citations 就是呈现指令。
 *
 * 本模块不做脱敏（安全策略在出云边界），产出的所有结构都是 `Redactable*` 形状，
 * 由注入的 `AskOutbound` 统一处理（云端 / 本机策略由组合根决定）。
 */
import {
  RRF_K,
  despaceSearchText,
  searchChainSegments,
  searchChainSegmentsBatch,
  type ChainHit,
  type ChainSearchBatchQuery,
  type ChainSearchBatchResult,
  type ChainSearchFilter
} from '../query'
import { getSegmentDetail, listSegmentLongestHeads, listSegmentUrls, type ChainDb } from '../store'
import { collectUrls } from '../content/urls'
import type {
  AskLoopFreshness,
  RedactableAskLoopHit,
  RedactableAskLoopToolResult,
  RedactableTaskView
} from './payload'
import { ASK_LOOP_READ_MAX_CHARS, ASK_LOOP_READ_MIN_CHARS } from './payload'
import { readChainFreshness } from './freshness'
import { normalizeArchiveId, type RecalledAttachment } from './archive'
import type { WorldToolDeps } from './world'

/** 引用白名单与 citation meta 的来源：search_info 返回过的段（at 是毫秒时间戳） */
export interface SearchHitMeta {
  segmentId: number
  at: number
  app: string
  title: string
}

/** 最近问答记录的最小视图（主进程把 `AskHistoryEntry` 结构化兼容地喂进来） */
export interface AskHistorySummary {
  at: number
  question: string
  kind: string
  /** 本会话 / 其他会话（只在 scope=all 时有意义；默认只查本会话） */
  session?: 'current' | 'other'
}

/* ------------------------------------------------------------------ */
/* 个人记忆（日记 = 第二本账）的工具依赖                                */
/* ------------------------------------------------------------------ */

/** 日记召回的一条命中（`text` 是原文，工具层负责截成 snippet 再送云） */
export interface DiaryHitView {
  itemId: number
  day: string
  section: string
  kind: string
  text: string
  tags: readonly string[]
  refs: readonly string[]
  reasons: readonly string[]
}

/** 打开某一天：拼接后的全文 + 当天条目（条目 id 用于最终引用） */
export interface DiaryDayView {
  day: string
  text: string
  items: readonly { itemId: number; section: string; text: string }[]
}

/** 「关于我」：统计 + 观测（当前只有统计型，不装心理分析） */
export interface DiaryProfileView {
  stats: Record<string, number | string | null>
  observations: readonly { topic: string; statement: string }[]
}

/** 主进程注入的日记记忆实现（测试可用内存库直接接） */
export interface DiaryToolDeps {  recall(query: {
    keywords: string[]
    day?: string
    from?: number
    to?: number
    tag?: string
    limit: number
  }): readonly DiaryHitView[]
  readDay(day: string): DiaryDayView | null
  profile(): DiaryProfileView
}

/** 生女儿（D81）：主进程注入的出生动作结果；失败只给可读原因 */
export interface GiveBirthResult {
  ok: boolean
  /**
   * 这一代真正起的名字（模型给的原话，用于回执 / 家谱显示，D82）。
   * 取不到时等于 `branch`。
   */
  nickname?: string
  /** 实际落下的分支名（slug；git 只认它） */
  branch?: string
  message: string
}

/** 写信落到哪：自己分支草稿 / 他的桌面 / 女儿分支（出生前先待寄） */
export type LetterAt = 'self' | 'desktop' | 'daughter'

export interface LetterSummary {
  id: string
  from: string
  to: string
  /** 毫秒时间戳 */
  at: number
  /** 仓里的位置：`letters/` 草稿 / `letters/outbox/` 待寄 */
  where: 'letters' | 'outbox'
  unread: boolean
}

export interface LetterView extends LetterSummary {
  text: string
}

export interface WriteLetterResult {
  ok: boolean
  id?: string
  at?: LetterAt
  message: string
}

/** 主进程注入的信件实现（仓内 / 桌面）；不传 = 这个分支没有写信能力 */
export interface LetterToolDeps {
  write(input: { to: string; write: string; at: LetterAt }): Promise<WriteLetterResult>
  list(): Promise<readonly LetterSummary[]>
  read(id: string | undefined): Promise<LetterView | null>
}

/* ------------------------------------------------------------------ */
/* 任务记忆（自调用 v0.2 §6）：四个工具的端口                          */
/* ------------------------------------------------------------------ */

/** 任务来源 / 交付（与 `memory/agent/tasks.ts` 同口径，类型在这里重复一份避免链层依赖记忆层） */
export type TaskOriginArg = 'user' | 'agent' | 'system'
export type TaskDeliveryArg = 'foreground' | 'background' | 'auto'
export type TaskRepeatArg = '' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export type TaskStateArg = 'active' | 'paused' | 'completed' | 'cancelled'

/** 新建请求：时间已经被工具层解析成本地毫秒时间戳（模型只给 `YYYY-MM-DD HH:mm`） */
export interface TaskScheduleRequest {
  instruction: string
  when: number | null
  repeat: TaskRepeatArg
  /** repeat=weekly 时生效：1=周一 … 7=周日，可多选 */
  weekdays?: number[]
  /** repeat=monthly 时生效：每月几号，1–31，可多选 */
  monthDays?: number[]
  /** repeat=yearly 时生效：每年几月（1–12） */
  yearlyMonth?: number
  /** repeat=yearly 时生效：每年几号（1–31；2-29 合法） */
  yearlyDay?: number
  origin: TaskOriginArg
  delivery: TaskDeliveryArg
  validUntil: number | null
}

export interface TaskUpdateRequest {
  id: number
  instruction?: string
  /** 给了 = 改到点时间；不给 = 不动 */
  when?: number | null
  repeat?: TaskRepeatArg
  weekdays?: number[]
  monthDays?: number[]
  yearlyMonth?: number
  yearlyDay?: number
  delivery?: TaskDeliveryArg
  validUntil?: number | null
  state?: TaskStateArg
}

export interface TaskSearchRequest {
  view: 'pending' | 'day' | 'upcoming' | 'about'
  day?: string
  query?: string
  limit?: number
}

/** 回执类结果：`ok=false` 时 message 说明为什么没成（模型不得改口成成功） */
export interface TaskMutationResult {
  ok: boolean
  message: string
  task: RedactableTaskView | null
}

export interface TaskSearchResultView {
  tasks: readonly RedactableTaskView[]
  total: number
  truncated: boolean
}

/** 主进程注入的任务实现（mem_tasks + 共建计划的 Obsidian 同步）；不传 = 这台机器没有任务库 */
export interface TaskToolDeps {
  schedule(input: TaskScheduleRequest): TaskMutationResult
  search(input: TaskSearchRequest): TaskSearchResultView
  update(input: TaskUpdateRequest): TaskMutationResult
  cancel(id: number): TaskMutationResult
}

/* ------------------------------------------------------------------ */
/* 小本本（自调用 v0.2 §7 / §12.2）：一个工具管增改删                    */
/* ------------------------------------------------------------------ */

export type NotebookSectionArg = string

export interface NotebookUpdateRequest {
  action: 'add' | 'revise' | 'remove'
  /** add 时必填 */
  section?: NotebookSectionArg
  /** revise / remove 时必填（如 n3） */
  id?: string
  /** add / revise 时必填 */
  text?: string
}

/** 一条小本本条目在工具结果里的样子（section 是中文栏名，给人看） */
export interface NotebookEntryView {
  id: string
  section: string
  text: string
  at: string
}

export interface NotebookUpdateResult {
  ok: boolean
  message: string
  /** 这条的新样子；失败 / 内容被脱敏时为 null */
  entry: NotebookEntryView | null
  total: number
}

/** 主进程注入的小本本实现（记忆仓里的 notebook.md）；不传 = 这个分支没挂小本本 */
export interface NotebookToolDeps {
  update(input: NotebookUpdateRequest): NotebookUpdateResult
  read?(): readonly { id: string; section: string; text: string }[]
  owned?(): boolean
}

/* ------------------------------------------------------------------ */
/* 成长档案（自调用 v0.2 §8 / §12.3）：一个工具写日记 / 周记 / 月末总结 / 年终总结 */
/* ------------------------------------------------------------------ */

export type GrowthKindArg = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** 模型给的 kind 只认这四个（不猜：认不出来就让 ta 重说） */
export function growthKindArgOf(value: unknown): GrowthKindArg | null {
  if (value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'yearly') {
    return value
  }
  return null
}

export interface GrowthWriteRequest {
  kind: GrowthKindArg
  content: string
}

/** 回执：真的落盘了才 ok；`kind` / `period` 在失败时为空串 */
export interface GrowthWriteResult {
  ok: boolean
  message: string
  kind: GrowthKindArg | ''
  /** 写到哪一篇：`2026-11-01` / `2026-W44` / `2026-11` / `2026` */
  period: string
  chars: number
}

/** 主进程注入的成长档案实现（记忆仓里的 growth/）；不传 = 这个分支没挂成长档案 */
export interface GrowthToolDeps {
  write(input: GrowthWriteRequest): GrowthWriteResult
}

/** 日记引用的白名单元数据（模型最终给的 itemId 必须落在这里面） */
export interface MemoryCitationMeta {
  itemId: number
  day: string
  section: string
  text: string
}

/** 模型发起的一次工具调用（客户端已把 JSON 参数解析成对象） */
export interface AskToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface AskToolDeps {
  db: ChainDb
  /** 固定钟（测试注入）；主进程传 `() => Date.now()` */
  now: () => number
  /** 采集是否在跑（freshness 的 captureRunning） */
  captureRunning: () => boolean
  /** 语义检索用的向量（bge 会话；没接或算不出来就只走关键词，不因此失败） */
  embed?: (text: string) => Promise<Float32Array | null> | Float32Array | null
  /** 最近问答记录（ask_history 工具的数据源；没接就当没有历史） */
  readAskHistory?: (scope: 'conversation' | 'all') => readonly AskHistorySummary[]
  /**
   * read_segment 的越权门：只允许展开 search_info 返回过的段（驱动层按引用白名单实现）。
   * 不传 = 一律拒绝，避免模型拿段号扫库。
   */
  canReadSegment?: (segmentId: number) => boolean
  /**
   * 段截图 → data URL（2026-10-29 拍板：OCR 不可信，读段只给 UIA 文字 + 截图）。
   * 主进程注入；**用户没开「历史截图出云」时不要注入**——核心拿不到图就不附图。
   * 归档 / 打包进容器的截图没有可直接读的文件，返回 null 即可。
   */
  readShot?: (path: string) => string | null
  /**
   * 关键词批量检索的执行体（性能方案 §5.11）：主进程注入「进 worker 的那个」，
   * 测试 / 单发路径不传就退回进程内同步查。结果口径必须与 `searchChainSegmentsBatch` 一致。
   */
  searchBatch?: (query: ChainSearchBatchQuery) => Promise<ChainSearchBatchResult>
  /**
   * 日记记忆（第二本账）。不传 = 这台机器上没配日记目录：
   * 三个记忆工具会如实报「没有接入」，而不是假装查过。
   */
  diary?: DiaryToolDeps
  /**
   * 生女儿（D81 / D100）：persona 分支带工具就注入（常驻）；
   * 能不能生由 `giveBirth` 自己判（生命用过 15% 起）。
   * 不传 = 模型调 `give_birth` 会如实回「现在还不能传承」。
   */
  giveBirth?: (nickname: string) => Promise<GiveBirthResult>
  /**
   * 信（D81）：写 / 列 / 读。不传 = 这个分支没挂写信工具，模型调了只会收到可读原因。
   */
  letters?: LetterToolDeps
  /**
   * 回想归档（D88）：历史轮次里的图片 / 文本附件换成占位符后，按 id 取回原图或正文。
   * 只认本会话出现过的 id；不传 = 这个会话没有归档，工具会如实回「没有这个归档」。
   */
  recall?: (id: string) => RecalledAttachment | null
  /**
   * 任务记忆（自调用 v0.2 §6）：四个任务工具的执行端口。
   * 不传 = 这台机器没有任务库：工具会如实回「现在记不下」，而不是假装记下。
   */
  tasks?: TaskToolDeps
  /**
   * 小本本（自调用 v0.2 §7）：增改删的执行端口。
   * 不传 = 这个分支没挂小本本工具（或记忆仓不可用）：工具会如实回「现在写不了」。
   */
  notebook?: NotebookToolDeps
  world?: WorldToolDeps
  /**
   * 成长档案（自调用 v0.2 §8）：写日记 / 周记的执行端口。
   * 不传 = 这个分支没挂成长档案（或记忆仓不可用）：工具会如实回「现在写不了」。
   */
  growth?: GrowthToolDeps
  /**
   * QQ 引用（D96 / PR1）：按本地短号取回可引用的消息。
   * 不传 = 这条通道没有聊天台账：`quote_message` 会如实回「引用不了」。
   */
  quoteMessage?: (id: number) => QuoteMessageLookup
  /**
   * QQ 表情包 / 发图（D96 / PR2）：图鉴、挑图、收藏。
   * 不传 = 这条通道没有表情池：三个新工具会如实回「这边发不了图」。
   */
  stickers?: QqStickerToolDeps
  /**
   * 本会话里见过的图片 id → data URL（本轮附件 / 会话归档 / read_segment 截图）。
   * 只认真的在会话里出现过的图；不传 = `save_sticker` / `send_image` 找不到图。
   */
  imageById?: (id: string) => string | null
  /** 已经挑过的媒体（续查恢复时从这里接上，避免同一轮重复挑） */
  pickedMedia?: { readonly sticker?: string; readonly image?: string }
}

/** 表情包池里的一张（给模型的图鉴视图） */
export interface QqStickerView {
  readonly id: string
  readonly label: string
  readonly desc: string
  readonly tags: readonly string[]
  readonly useCount: number
}

/**
 * `send_sticker` / `save_sticker` / `send_image` 的执行端口（QQ 通道注入）。
 * 真实实现在 `main/qq/stickers.ts`：这里只认「图鉴 / 挑一张 / 收一张」三件事。
 */
export interface QqStickerToolDeps {
  /** 正式收藏的图鉴（按常用度排好，最多 40 条） */
  list(): readonly QqStickerView[]
  /** 挑一张准备发：返回压过口径的 data URL 与标签；找不到 / 文件坏了返回 null */
  pick(id: string): { readonly view: QqStickerView; readonly dataUrl: string } | null
  /** 收进池子；`dataUrl` 由驱动层从本会话图片里取到 */
  save(input: {
    readonly dataUrl: string
    readonly label: string
    readonly desc?: string
  }): { ok: true; id: string; label: string; duplicate: boolean } | { ok: false; error: string }
}

/** `quote_message` 能引用的目标（真实 QQ id 只在执行器 outcome 里流转，不进工具结果） */
export interface QuoteMessageTarget {
  /** 本地短号（`#12` 里的 12） */
  readonly id: number
  readonly from: 'user' | 'ta'
  /** 被引用原话（已截断） */
  readonly text: string
  /** 真实 QQ message_id（出站 `reply` 段用） */
  readonly qqId: number
}

/** 短号查询结果：命中给 target，没命中给最近几条可用短号（别让模型瞎猜） */
export interface QuoteMessageLookup {
  readonly target?: QuoteMessageTarget
  readonly recent: readonly number[]
}

export interface AskToolOutcome {
  /** 送云摘要（送云前由 AskOutbound 统一处理——工具结果就是屏幕内容） */
  result: RedactableAskLoopToolResult
  /** search_info 命中的段：引用白名单与 citation meta 的唯一来源 */
  segments: readonly SearchHitMeta[]
  /** recall_diary / read_diary 给过的日记条目：memories 引用的白名单 */
  memories?: readonly MemoryCitationMeta[]
  /**
   * read_segment 真正打开过的段（2026-10-29 晚，拍板改 DSH 式）：
   * 最终引用不再靠模型在正文里写 `[[段 N]]`，而是由驱动层把「已读」自动带出。
   * 只有 read_segment 会填这个字段；检索命中不算「读过」。
   */
  read?: readonly SearchHitMeta[]
  /**
   * read_segment 带出的截图（data URL）：驱动层把图挂到该轮工具结果后面，
   * 以 user 消息送给模型（DeepSeek 只允许 user 消息带图）。没有就是没开 / 没图。
   */
  images?: readonly string[]
  /**
   * `quote_message` 选中的目标（真实 QQ message_id）：驱动层把它挂到最终结果上，
   * 由 QQ 通道翻译成出站 `reply` 段；桌面通道忽略。
   */
  replyTo?: number
  /**
   * 这一轮要跟着发出去的媒体（D96 / PR2）：`send_sticker` / `send_image` 挑中的那张。
   * 驱动层收集成 `outboundMedia`，QQ 通道在文字之后发送；桌面忽略。
   */
  media?: {
    readonly kind: 'sticker' | 'image'
    readonly dataUrl: string
    readonly label?: string
    /** 表情 id / 图片归档 id：通道用它做 24h 同图去重 */
    readonly ref?: string
  }
}

/* ------------------------------------------------------------------ */
/* 参数归一（模型输出不可信：类型、范围、条数都在这里钳）               */
/* ------------------------------------------------------------------ */

const KEYWORDS_MAX = 8
const KEYWORD_CHARS = 50
const SEMANTIC_CHARS = 200
const FILTER_CHARS = 80
const TOOL_LIMIT_DEFAULT = 8
const TOOL_LIMIT_MAX = 20
const HISTORY_LIMIT_DEFAULT = 10
const HISTORY_LIMIT_MAX = 50
const HISTORY_QUESTION_CHARS = 120
const SNIPPET_CHARS = 80
/** 表情图鉴一次最多列几条（与 `main/qq/stickers.ts` 的 `QQ_STICKER_CATALOG_MAX` 同口径） */
const STICKER_CATALOG_MAX = 40
/** 表情标签 / 描述长度上限（模型不能无限写；与池子的钳制同口径） */
const STICKER_LABEL_MAX_CHARS = 20
const STICKER_DESC_MAX_CHARS = 100

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, maxChars)
}

/** QQ 消息短号：接受 `#12` / `12` / 数字 12；不是正整数返回 null */
function quoteShortId(value: unknown): number | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  const trimmed = raw.trim().replace(/^#+/u, '')
  if (!/^\d{1,9}$/u.test(trimmed)) return null
  const id = Number(trimmed)
  return Number.isInteger(id) && id > 0 ? id : null
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const raw = optionalNumber(value)
  if (raw === undefined) return fallback
  return Math.min(max, Math.max(1, Math.round(raw)))
}

/**
 * `YYYY-MM-DD HH:mm`（也收 `T` 分隔、只给日期 = 当天 00:00）→ 本地毫秒时间戳。
 *
 * 为什么不让模型直接给毫秒：它算时区 / 跨月必错；这里只认人能读的写法，
 * 解不出来就让它重给，绝不替它猜「明天九点」是哪一天。
 */
const LOCAL_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/u

function parseLocalStamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = LOCAL_STAMP_RE.exec(value.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = match[4] === undefined ? 0 : Number(match[4])
  const minute = match[5] === undefined ? 0 : Number(match[5])
  if (hour > 23 || minute > 59) return null
  const probe = new Date(year, month - 1, day, hour, minute, 0, 0)
  // 2026-02-30 / 25:00 这类「滚过去」的写法不算合法
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day ||
    probe.getHours() !== hour ||
    probe.getMinutes() !== minute
  ) {
    return null
  }
  return probe.getTime()
}

/** 任务 id：正整数；其余一律当没给 */
function taskIdOf(value: unknown): number | undefined {
  const raw = optionalNumber(value)
  if (raw === undefined || !Number.isInteger(raw) || raw <= 0) return undefined
  return raw
}

/**
 * 重复列表参数（weekdays 1–7 / month_days 1–31）：
 * `undefined` = 没给；`null` = 给了但非法（由调用方报错，不静默吞掉模型的错参数）。
 */
function parseRepeatDays(
  value: unknown,
  min: number,
  max: number
): number[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  // 空数组 = 没选（不当作非法）；让任务层按第一次到点补默认
  if (value.length === 0) return undefined
  const days = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max) {
      return null
    }
    days.add(item)
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * yearly 的月 / 日参数：两个一起给才算数。
 * `undefined` = 都没给；`null` = 给了但非法（缺一个 / 越界 / 2 月 30 这种）。
 * 用 2028（闰年）校验：2-29 合法，2-30、13 月不合法。
 */
function parseYearlyDateArgs(
  monthValue: unknown,
  dayValue: unknown
): { month: number; day: number } | null | undefined {
  if (monthValue === undefined && dayValue === undefined) return undefined
  const month = optionalNumber(monthValue)
  const day = optionalNumber(dayValue)
  if (month === undefined || day === undefined) return null
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const probe = new Date(2028, month - 1, day)
  if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null
  return { month, day }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 毫秒时间戳 → 'HH:mm'（提示纪律：模型指证据用「HH:mm 的〈应用〉」） */
function hhmm(ts: number): string {
  const date = new Date(ts)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 毫秒时间戳 → 'MM-DD HH:mm'（问答记录用：模型不必自己换算时间戳，避免算错时区） */
function readableTime(ts: number): string {
  const date = new Date(ts)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${hhmm(ts)}`
}

function titleOf(hit: ChainHit): string {
  return hit.segment.title_last ?? hit.segment.title_first ?? ''
}

function metaOf(hit: ChainHit): SearchHitMeta {
  return {
    segmentId: hit.segment.id,
    at: hit.segment.start_ts,
    app: hit.segment.app ?? '',
    title: titleOf(hit)
  }
}

/** 没有关键词命中时的兜底摘要：传进来的是「该段最长那条正文的开头」（不读全文） */
function fallbackSnippetFromHead(head: string | undefined): string {
  return (head ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
}

/**
 * 段正文里出现的网址（地址栏 / 页面里的链接）：snippet 只有 80 字，URL 常在中后段，
 * 不单独抽出来模型就看不到，只会答「没有记录到链接」。逐条去重、限量、限长。
 *
 * 规则与写入 `chain_content.urls` 时共用一份（`content/urls.ts`）：这里只在已经拿到
 * 正文的路径（read_segment 的证据行）上现抽，`search_info` 直接读列。
 */
function extractUrls(contents: readonly { text: string }[] | undefined): string[] {
  return collectUrls((contents ?? []).map((row) => row.text))
}

/* ------------------------------------------------------------------ */
/* search_info                                                         */
/* ------------------------------------------------------------------ */

interface SearchInfoArgs {
  filter: ChainSearchFilter
  keywords: string[]
  semantic: string | null
  limit: number
}
/** 参数归一；完全空查询（没有任何可执行条件）返回 null → 报「参数不合法」 */
function parseSearchInfoArgs(args: Record<string, unknown>): SearchInfoArgs | null {
  const from = optionalNumber(args.from)
  const to = optionalNumber(args.to)
  if (from !== undefined && to !== undefined && to < from) return null
  const keywords = (Array.isArray(args.keywords) ? args.keywords : [])
    .filter((keyword): keyword is string => typeof keyword === 'string')
    .map((keyword) => keyword.trim().slice(0, KEYWORD_CHARS))
    .filter((keyword) => keyword !== '')
    .slice(0, KEYWORDS_MAX)
  const semantic = optionalText(args.semantic, SEMANTIC_CHARS) ?? null
  const app = optionalText(args.app, FILTER_CHARS)
  const tag = optionalText(args.tag, FILTER_CHARS)
  const link = optionalText(args.link, FILTER_CHARS)
  const order = args.order === 'oldest' ? 'oldest' : args.order === 'newest' ? 'newest' : undefined
  const filter: ChainSearchFilter = {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(app !== undefined ? { app } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(order !== undefined ? { order } : {})
  }
  const hasFilter =
    filter.from !== undefined || filter.to !== undefined ||
    filter.app !== undefined || filter.tag !== undefined || filter.link !== undefined
  if (keywords.length === 0 && semantic === null && !hasFilter) return null
  return { filter, keywords, semantic, limit: clampLimit(args.limit, TOOL_LIMIT_DEFAULT, TOOL_LIMIT_MAX) }
}

/**
 * keywords 逐词各查一次（OR 语义由「任一词命中即可」天然成立），semantic 走一次向量，
 * 本地 RRF（k=60）合并排名——两路都命中的段排前面，只命中一路的靠后。
 */
async function executeSearchInfo(deps: AskToolDeps, args: SearchInfoArgs): Promise<AskToolOutcome> {
  const db = deps.db
  // includeOpen 硬编码 true：漏开段是召回根因之一（方案拍板，不做成参数）
  const base = { ...args.filter, includeOpen: true as const, limit: args.limit }

  const batch =
    args.keywords.length > 0
      ? await (deps.searchBatch
          ? deps.searchBatch({ ...base, texts: args.keywords })
          : searchChainSegmentsBatch(db, { ...base, texts: args.keywords }))
      : null
  const keywordHits: ChainHit[][] = batch?.hitsPerText ?? []
  let semanticHits: ChainHit[] = []
  let semanticUsed = false
  if (args.semantic !== null) {
    let vector: Float32Array | null = null
    if (deps.embed) {
      try {
        vector = (await deps.embed(args.semantic)) ?? null
      } catch {
        vector = null // 向量算不出来只关语义路，不因此失败
      }
    }
    if (vector) {
      semanticUsed = true
      semanticHits = searchChainSegments(db, { ...base, vector }).hits
    }
  }

  // 纯过滤（没给关键词也没算出语义向量）：按开始时间倒序列段，一样受 includeOpen 约束
  const filterOnly = keywordHits.length === 0 && !semanticUsed
  const filterHits = filterOnly ? searchChainSegments(db, base).hits : []

  // 各路名次 → RRF 分；名次口径沿用 query.ts（各路内部已按相关度排好）
  const rankings: number[][] = [
    ...keywordHits.map((hits) => hits.map((hit) => hit.segment.id)),
    ...(semanticUsed ? [semanticHits.map((hit) => hit.segment.id)] : [])
  ]
  const startTsOf = new Map<number, number>()
  for (const hit of [...keywordHits.flat(), ...semanticHits, ...filterHits]) {
    startTsOf.set(hit.segment.id, hit.segment.start_ts)
  }

  let orderedIds: number[]
  if (rankings.length === 0) {
    orderedIds = filterHits.map((hit) => hit.segment.id)
  } else {
    const scores = new Map<number, number>()
    for (const ranking of rankings) {
      ranking.forEach((segmentId, index) => {
        scores.set(segmentId, (scores.get(segmentId) ?? 0) + 1 / (RRF_K + index + 1))
      })
    }
    orderedIds = [...scores.keys()].sort(
      (a, b) =>
        scores.get(b)! - scores.get(a)! ||
        (startTsOf.get(b) ?? 0) - (startTsOf.get(a) ?? 0)
    )
  }
  orderedIds = orderedIds.slice(0, args.limit)

  // 段行 / 摘要视图从各路命中里找：优先带关键词摘要的，其次语义路，最后纯过滤路
  const byId = new Map<number, ChainHit>()
  for (const hit of [...keywordHits.flat(), ...semanticHits, ...filterHits]) {
    const existing = byId.get(hit.segment.id)
    if (!existing || (existing.snippet === null && hit.snippet !== null)) byId.set(hit.segment.id, hit)
  }

  // 只取这一段真正需要的两样东西（性能方案 P1-6）：
  // - 网址：写入时已落到 `chain_content.urls`，读列即可（不再为抽网址搬整段正文）；
  // - 兜底摘要：只有「没有关键词 / 语义摘要」的段才需要，且只要最长那条正文的开头。
  const shownIds = orderedIds.filter((segmentId) => byId.has(segmentId))
  const urlsBySegment = listSegmentUrls(db, shownIds)
  const needHead = shownIds.filter((segmentId) => byId.get(segmentId)?.snippet == null)
  const headBySegment = needHead.length > 0 ? listSegmentLongestHeads(db, needHead) : new Map()

  const hits: RedactableAskLoopHit[] = []
  const segments: SearchHitMeta[] = []
  for (const segmentId of shownIds) {
    const hit = byId.get(segmentId)
    if (!hit) continue // 排名与读行之间段被删了（只可能是人为清理）：跳过，不编造
    const snippet =
      hit.snippet?.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS) ??
      fallbackSnippetFromHead(headBySegment.get(segmentId))
    hits.push({
      segmentId,
      at: hhmm(hit.segment.start_ts),
      app: hit.segment.app ?? '',
      title: titleOf(hit),
      snippet,
      tags: hit.tags,
      links: hit.links,
      urls: urlsBySegment.get(segmentId) ?? []
    })
    segments.push(metaOf(hit))
  }

  const mode: string =
    keywordHits.length > 0 && semanticUsed
      ? 'hybrid'
      : keywordHits.length > 0
        ? 'keywords'
        : semanticUsed
          ? 'semantic'
          : 'filter'
  const keywordRows = batch?.stats.keywordRows ?? 0

  return {
    result: {
      kind: 'search_info',
      freshness: currentFreshness(deps),
      hits,
      stats: { mode, keywordRows }
    },
    segments
  }
}

/* ------------------------------------------------------------------ */
/* ask_history                                                         */
/* ------------------------------------------------------------------ */

function executeAskHistory(deps: AskToolDeps, args: Record<string, unknown>): AskToolOutcome {
  const from = optionalNumber(args.from)
  const to = optionalNumber(args.to)
  const limit = clampLimit(args.limit, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX)
  // 默认只查本会话：以前把全库问答按时间倒出来，模型会把别的会话的问题写成「你刚才问的」。
  // 要跨会话必须显式 scope:"all"（每条带 session，提示词要求分开说）。
  const scope = args.scope === 'all' ? 'all' : 'conversation'
  // 默认最新在前；问「第一次 / 最早问过什么」时按时间正序，否则永远拿不到最早那条
  const oldestFirst = args.order === 'oldest'
  const filtered = (deps.readAskHistory?.(scope) ?? [])
    .filter((entry) => (from === undefined || entry.at >= from) && (to === undefined || entry.at <= to))
  if (oldestFirst) filtered.sort((a, b) => a.at - b.at)
  // 只给本地可读时刻，**不给毫秒时间戳**：模型拿到数字就会自己换算，真实记录里
  // 一会儿报 11:01、一会儿报 15:01（同一条 15:01 的记录），用户看到的“时间”在变。
  // 时间范围过滤由模型按系统提示里的当前时间换算 from / to，不需要每条都带时间戳。
  const entries = filtered.slice(0, limit).map((entry) => ({
    time: readableTime(entry.at),
    question: entry.question.slice(0, HISTORY_QUESTION_CHARS),
    kind: entry.kind,
    ...(entry.session !== undefined ? { session: entry.session } : {})
  }))
  return {
    result: { kind: 'ask_history', freshness: currentFreshness(deps), entries },
    segments: []
  }
}

/* ------------------------------------------------------------------ */
/* read_segment                                                        */
/* ------------------------------------------------------------------ */

const READ_DEFAULT_CHARS = 3000
const READ_OFFSET_MAX = 200_000
/** read_segment 的 query：在正文里定位这一段要找的内容（模型自己决定找什么） */
const READ_QUERY_MAX_CHARS = 200
/** 自动展开时从命中处往前多带这么多字：上下文（标题 / 列表头）常常就在命中处前面 */
const FOCUS_LEAD_CHARS = 600
/** 问题拆词最多取这么多前缀字符：中文没有空格，靠 n-gram 在正文里定位命中处 */
const QUESTION_FOCUS_MAX_CHARS = 24

/** 段正文（多条内容行拼起来）；段没了 / 正文全空返回 null */
export function segmentBodyText(db: ChainDb, segmentId: number): string | null {
  const detail = getSegmentDetail(db, segmentId)
  if (!detail) return null
  const text = detail.contents
    .map((row) => row.text)
    .filter((value) => value.trim() !== '')
    .join('\n\n')
  return text === '' ? null : text
}

/** 去空白后子串在原文里的起始下标（空白差异不影响定位）；找不到返回 -1 */
function packedIndexOf(text: string, needle: string): number {
  const packedNeedle = despaceSearchText(needle).toLowerCase()
  if (packedNeedle === '') return -1
  const packedText = despaceSearchText(text).toLowerCase()
  const hit = packedText.indexOf(packedNeedle)
  if (hit < 0) return -1
  let seen = 0
  for (let index = 0; index < text.length; index += 1) {
    if (' \t\n\r\u3000\u00a0'.includes(text[index])) continue
    if (seen === hit) return index
    seen += 1
  }
  return -1
}

/**
 * `query` 在正文里的位置 → read_segment 的起点（往前带一点上下文，命中处不会孤零零地
 * 出现在窗口第一行）。空白差异用去空白匹配兜住；找不到返回 0，从开头读。
 */
function locateOffset(text: string, query: string): number {
  const needle = query.trim()
  if (needle === '') return 0
  const index = packedIndexOf(text, needle)
  return index < 0 ? 0 : Math.max(0, index - FOCUS_LEAD_CHARS)
}

function clampReadLimit(value: unknown): number {
  const raw = optionalNumber(value)
  if (raw === undefined) return READ_DEFAULT_CHARS
  return Math.min(ASK_LOOP_READ_MAX_CHARS, Math.max(ASK_LOOP_READ_MIN_CHARS, Math.round(raw)))
}

function clampReadOffset(value: unknown): number {
  const raw = optionalNumber(value)
  if (raw === undefined) return 0
  return Math.min(READ_OFFSET_MAX, Math.max(0, Math.round(raw)))
}

/**
 * 展开一段命中段。2026-10-29 拍板：**永远不信任 OCR**——OCR 只用于检索命中，
 * 读段时只回 UIA 文字（`source='uia'`）与该段最近一张截图；OCR 正文一律不回给模型。
 * 越权（不在 search_info 结果里的段）一律拒绝；脱敏在出云边界统一做。
 */
function executeReadSegment(deps: AskToolDeps, args: Record<string, unknown>): AskToolOutcome {
  const rawId = optionalNumber(args.segmentId)
  if (rawId === undefined || !Number.isInteger(rawId) || rawId <= 0) {
    return { result: { kind: 'error', message: 'read_segment 需要正整数 segmentId' }, segments: [] }
  }
  if (!deps.canReadSegment || !deps.canReadSegment(rawId)) {
    return {
      result: {
        kind: 'error',
        message:
          '只能展开 search_info 返回过的段，而且只在本轮有效（换了一问，段号就过期了）：重新 search_info，再按新的 segmentId 展开'
      },
      segments: []
    }
  }
  const detail = getSegmentDetail(deps.db, rawId)
  if (!detail) {
    return { result: { kind: 'error', message: '这一段已经读不到了（可能被保留期清掉）' }, segments: [] }
  }
  // OCR 只当检索用的线索，不当作读段的证据：只留 UIA 采到的界面文字。
  const uiContents = detail.contents.filter((row) => row.source === 'uia')
  const text = uiContents
    .map((row) => row.text)
    .filter((value) => value.trim() !== '')
    .join('\n\n')

  // 截图：只给最近一张（每张约 1024 token，多给是浪费）。没开「历史截图出云」时
  // 主进程不会注入 readShot，这里自然拿不到图。
  const images: string[] = []
  if (deps.readShot) {
    const shots = detail.shots.filter((row) => typeof row.path === 'string' && row.path !== '')
    for (const shot of shots.slice(-1)) {
      const url = deps.readShot(shot.path as string)
      if (typeof url === 'string' && url.startsWith('data:image/')) images.push(url)
    }
  }
  if (text === '' && images.length === 0) {
    return {
      result: {
        kind: 'error',
        message: '这一段没有可读的界面文字（UIA），也没有可看的截图'
      },
      segments: []
    }
  }
  const segment = detail.segment
  // 定位顺序：显式 offset > query（在正文里找这一句）> 开头。
  const query = optionalText(args.query, READ_QUERY_MAX_CHARS)
  const offset =
    args.offset !== undefined
      ? clampReadOffset(args.offset)
      : query !== undefined
        ? locateOffset(text, query)
        : 0
  return {
    result: {
      kind: 'read_segment',
      freshness: currentFreshness(deps),
      segmentId: rawId,
      at: readableTime(segment.start_ts),
      app: segment.app ?? '',
      title: segment.title_last ?? segment.title_first ?? '',
      text,
      urls: extractUrls(uiContents),
      offset,
      limit: clampReadLimit(args.limit),
      shotCount: images.length
    },
    segments: [],
    // 打开过 = 引用（DSH 式自动记录）：最终答复里不需要任何记号
    read: [
      {
        segmentId: rawId,
        at: segment.start_ts,
        app: segment.app ?? '',
        title: segment.title_last ?? segment.title_first ?? ''
      }
    ],
    ...(images.length > 0 ? { images } : {})
  }
}

/* ------------------------------------------------------------------ */
/* 个人记忆（日记）：recall_diary / read_diary / memory_profile         */
/* ------------------------------------------------------------------ */

/** 日记召回的摘要长度：与 search_info 的 80 字同量级，要看细节必须 read_diary */
const DIARY_SNIPPET_CHARS = 120
const DIARY_KEYWORDS_MAX = 8
const DIARY_KEYWORD_CHARS = 50
const DIARY_LIMIT_DEFAULT = 6
const DIARY_LIMIT_MAX = 20
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDayKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return DAY_KEY_RE.test(trimmed) ? trimmed : undefined
}

interface RecallDiaryArgs {
  keywords: string[]
  day?: string
  from?: number
  to?: number
  tag?: string
  limit: number
}

/**
 * 参数归一：日记是「按天 / 按词 / 按标签」三选一以上的查询。
 * 什么条件都不给 → null（报参数不合法），避免模型拿空查询把整库按时间倒出来。
 */
function parseRecallDiaryArgs(args: Record<string, unknown>): RecallDiaryArgs | null {
  const keywords = (Array.isArray(args.keywords) ? args.keywords : [])
    .filter((keyword): keyword is string => typeof keyword === 'string')
    .map((keyword) => keyword.trim().slice(0, DIARY_KEYWORD_CHARS))
    .filter((keyword) => keyword !== '')
    .slice(0, DIARY_KEYWORDS_MAX)
  const day = parseDayKey(args.day)
  const tag = optionalText(args.tag, FILTER_CHARS)
  const from = optionalNumber(args.from)
  const to = optionalNumber(args.to)
  if (from !== undefined && to !== undefined && to < from) return null
  if (keywords.length === 0 && day === undefined && tag === undefined && from === undefined && to === undefined) {
    return null
  }
  return {
    keywords,
    ...(day !== undefined ? { day } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    limit: clampLimit(args.limit, DIARY_LIMIT_DEFAULT, DIARY_LIMIT_MAX)
  }
}

function requireDiary(deps: AskToolDeps): DiaryToolDeps | null {
  return deps.diary ?? null
}

function executeRecallDiary(deps: AskToolDeps, args: RecallDiaryArgs): AskToolOutcome {
  const diary = requireDiary(deps)
  if (!diary) {
    return { result: { kind: 'error', message: '这台机器上没有接入日记记忆（个人记忆）' }, segments: [] }
  }
  const hits = diary.recall(args)
  const memories: MemoryCitationMeta[] = []
  const views = hits.map((hit) => {
    memories.push({ itemId: hit.itemId, day: hit.day, section: hit.section, text: hit.text })
    return {
      itemId: hit.itemId,
      day: hit.day,
      kind: hit.kind,
      snippet: hit.text.replace(/\s+/gu, ' ').trim().slice(0, DIARY_SNIPPET_CHARS),
      tags: hit.tags,
      refs: hit.refs,
      reasons: hit.reasons
    }
  })
  return {
    result: {
      kind: 'recall_diary',
      freshness: currentFreshness(deps),
      hits: views,
      stats: { mode: args.keywords.length > 0 ? 'keywords' : 'filter', candidates: hits.length }
    },
    segments: [],
    memories
  }
}

function executeReadDiary(deps: AskToolDeps, args: Record<string, unknown>): AskToolOutcome {
  const diary = requireDiary(deps)
  if (!diary) {
    return { result: { kind: 'error', message: '这台机器上没有接入日记记忆（个人记忆）' }, segments: [] }
  }
  const day = parseDayKey(args.day)
  if (day === undefined) {
    return { result: { kind: 'error', message: 'read_diary 需要 day（格式 2026-09-29）' }, segments: [] }
  }
  const view = diary.readDay(day)
  if (view === null) {
    return { result: { kind: 'error', message: `这一天没有日记条目：${day}` }, segments: [] }
  }
  const memories: MemoryCitationMeta[] = view.items.map((item) => ({
    itemId: item.itemId,
    day,
    section: item.section,
    text: item.text
  }))
  return {
    result: {
      kind: 'read_diary',
      freshness: currentFreshness(deps),
      day,
      text: view.text,
      items: view.items,
      offset: clampReadOffset(args.offset),
      limit: clampReadLimit(args.limit)
    },
    segments: [],
    memories
  }
}

function executeMemoryProfile(deps: AskToolDeps): AskToolOutcome {
  const diary = requireDiary(deps)
  if (!diary) {
    return { result: { kind: 'error', message: '这台机器上没有接入日记记忆（个人记忆）' }, segments: [] }
  }
  const view = diary.profile()
  return {
    result: {
      kind: 'memory_profile',
      freshness: currentFreshness(deps),
      stats: view.stats,
      observations: view.observations
    },
    segments: []
  }
}

/* ------------------------------------------------------------------ */
/* 执行器入口                                                          */
/* ------------------------------------------------------------------ */

function currentFreshness(deps: AskToolDeps): AskLoopFreshness {
  return {
    latestEvidenceTs: readChainFreshness(deps.db, deps.now()).latestEvidenceTs,
    captureRunning: deps.captureRunning()
  }
}

/**
 * 工具执行器。纪律：
 * - 执行抛错不炸循环：变成 `error` 摘要回给模型（固定文案，不含异常原文）；
 * - 未知工具名如实回 `error`（工具名会过脱敏再送云）；
 * - 每个结果都带 freshness（根因 5：模型随时知道数据边界）。
 */
export function createAskToolExecutor(deps: AskToolDeps): {
  freshness: () => AskLoopFreshness
  execute: (call: AskToolCall) => Promise<AskToolOutcome>
} {
  /** 这一问里已经引用过的消息（D96：一轮只认一次，第二次调用给错误） */
  let quotedTarget: QuoteMessageTarget | null = null
  /** 这一问里已经挑好的媒体（D96 / PR2：表情、图片各最多一张） */
  let pickedSticker = deps.pickedMedia?.sticker ?? null
  let pickedImage = deps.pickedMedia?.image ?? null
  return {
    freshness: () => currentFreshness(deps),
    async execute(call: AskToolCall): Promise<AskToolOutcome> {
      try {
        if (call.name === 'search_info') {
          const args = parseSearchInfoArgs(call.arguments)
          if (args === null) {
            return { result: { kind: 'error', message: 'search_info 参数不合法（需要 keywords / semantic / 过滤条件之一）' }, segments: [] }
          }
          return await executeSearchInfo(deps, args)
        }
        if (call.name === 'get_freshness') {
          return { result: { kind: 'get_freshness', freshness: currentFreshness(deps) }, segments: [] }
        }
        if (call.name === 'ask_history') {
          return executeAskHistory(deps, call.arguments)
        }
        if (call.name === 'read_segment') {
          return executeReadSegment(deps, call.arguments)
        }
        if (call.name === 'recall') {
          const id = normalizeArchiveId(
            typeof call.arguments['id'] === 'string' ? call.arguments['id'] : ''
          )
          if (id === null) {
            return {
              result: {
                kind: 'error',
                message: 'recall 需要归档 id（占位符里 # 后面那串，例如 #a1b2c3d4）'
              },
              segments: []
            }
          }
          const got = deps.recall?.(id) ?? null
          if (got === null) {
            return {
              result: {
                kind: 'error',
                message: '没有这个归档：只认本会话里出现过的图片 / 文件 / 工具结果'
              },
              segments: []
            }
          }
          return {
            result: {
              kind: 'recall',
              id,
              media: got.media,
              text: got.media === 'image' ? '' : got.text ?? '',
              name: got.name ?? '',
              // D89：回显「回想的是哪一段」，下一轮它自己被占位时模型才认得出
              ...(got.label !== undefined && got.label !== '' ? { label: got.label } : {})
            },
            segments: [],
            ...(got.media === 'image' && got.images !== undefined && got.images.length > 0
              ? { images: got.images }
              : {})
          }
        }
        if (call.name === 'recall_diary') {
          const args = parseRecallDiaryArgs(call.arguments)
          if (args === null) {
            return {
              result: { kind: 'error', message: 'recall_diary 参数不合法（需要 keywords / day / tag / from-to 之一）' },
              segments: []
            }
          }
          return executeRecallDiary(deps, args)
        }
        if (call.name === 'read_diary') {
          return executeReadDiary(deps, call.arguments)
        }
        if (call.name === 'memory_profile') {
          return executeMemoryProfile(deps)
        }
        if (call.name === 'give_birth') {
          const nickname = optionalText(call.arguments['nickname'], 40)
          if (nickname === undefined) {
            return { result: { kind: 'error', message: 'give_birth 需要 nickname' }, segments: [] }
          }
          if (deps.giveBirth === undefined) {
            return {
              result: { kind: 'error', message: '现在还不能传承（生命还没到终点，或记忆仓不可用）' },
              segments: []
            }
          }
          const outcome = await deps.giveBirth(nickname)
          return outcome.ok
            ? {
                result: {
                  kind: 'give_birth',
                  freshness: currentFreshness(deps),
                  born: true,
                  nickname: outcome.nickname ?? nickname,
                  message: outcome.message
                },
                segments: []
              }
            : { result: { kind: 'error', message: outcome.message }, segments: [] }
        }
        if (call.name === 'write_letter') {
          const to = optionalText(call.arguments['to'], 60)
          const write = optionalText(call.arguments['write'], 8_000)
          const rawAt = call.arguments['at']
          const at: LetterAt | undefined =
            rawAt === 'self' || rawAt === 'desktop' || rawAt === 'daughter' ? rawAt : undefined
          if (to === undefined || write === undefined || at === undefined) {
            return {
              result: {
                kind: 'error',
                message: 'write_letter 参数不合法（需要 to / write / at: self|desktop|daughter）'
              },
              segments: []
            }
          }
          if (deps.letters === undefined) {
            return {
              result: { kind: 'error', message: '现在不能写信（记忆仓不可用，或这个分支没挂写信工具）' },
              segments: []
            }
          }
          const outcome = await deps.letters.write({ to, write, at })
          return outcome.ok
            ? {
                result: {
                  kind: 'write_letter',
                  freshness: currentFreshness(deps),
                  id: outcome.id ?? '',
                  at,
                  message: outcome.message
                },
                segments: []
              }
            : { result: { kind: 'error', message: outcome.message }, segments: [] }
        }
        if (call.name === 'list_letter') {
          if (deps.letters === undefined) {
            return {
              result: { kind: 'error', message: '现在看不了信（记忆仓不可用，或这个分支没挂写信工具）' },
              segments: []
            }
          }
          const letters = await deps.letters.list()
          return {
            result: { kind: 'list_letter', freshness: currentFreshness(deps), letters },
            segments: []
          }
        }
        if (call.name === 'read_letter') {
          if (deps.letters === undefined) {
            return {
              result: { kind: 'error', message: '现在看不了信（记忆仓不可用，或这个分支没挂写信工具）' },
              segments: []
            }
          }
          const id = optionalText(call.arguments['id'], 80)
          const letter = await deps.letters.read(id)
          if (letter === null) {
            return {
              result: { kind: 'error', message: '没有这封信（用 list_letter 看有哪些）' },
              segments: []
            }
          }
          return {
            result: { kind: 'read_letter', freshness: currentFreshness(deps), ...letter },
            segments: []
          }
        }
        if (call.name === 'schedule_task') {
          const instruction = optionalText(call.arguments['instruction'], 500)
          if (instruction === undefined) {
            return {
              result: { kind: 'error', message: 'schedule_task 需要 instruction（到点想做什么）' },
              segments: []
            }
          }
          if (deps.tasks === undefined) {
            return {
              result: { kind: 'error', message: '现在记不下（这台机器没有任务库，或这个分支没挂任务工具）' },
              segments: []
            }
          }
          const rawWhen = call.arguments['when']
          const when = rawWhen === undefined ? null : parseLocalStamp(rawWhen)
          if (rawWhen !== undefined && when === null) {
            return {
              result: {
                kind: 'error',
                message: 'when 要写成 `YYYY-MM-DD HH:mm`（本地时间），例如 2026-11-02 09:30'
              },
              segments: []
            }
          }
          const rawValid = call.arguments['valid_until']
          const validUntil = rawValid === undefined ? null : parseLocalStamp(rawValid)
          if (rawValid !== undefined && validUntil === null) {
            return {
              result: {
                kind: 'error',
                message: 'valid_until 要写成 `YYYY-MM-DD HH:mm`（本地时间）'
              },
              segments: []
            }
          }
          const rawRepeat = call.arguments['repeat']
          const repeat: TaskRepeatArg =
            rawRepeat === 'daily' ||
            rawRepeat === 'weekly' ||
            rawRepeat === 'monthly' ||
            rawRepeat === 'yearly'
              ? rawRepeat
              : ''
          const weekdays = parseRepeatDays(call.arguments['weekdays'], 1, 7)
          if (weekdays === null) {
            return {
              result: {
                kind: 'error',
                message: 'weekdays 要用 1–7 的整数数组（1=周一 … 7=周日），可多选，例如 [1,3,5]'
              },
              segments: []
            }
          }
          const monthDays = parseRepeatDays(call.arguments['month_days'], 1, 31)
          if (monthDays === null) {
            return {
              result: {
                kind: 'error',
                message: 'month_days 要用 1–31 的整数数组，可多选，例如 [1,15]'
              },
              segments: []
            }
          }
          const yearly = parseYearlyDateArgs(
            call.arguments['yearly_month'],
            call.arguments['yearly_day']
          )
          if (yearly === null) {
            return {
              result: {
                kind: 'error',
                message: 'yearly_month / yearly_day 要一起给：month 1–12、day 1–31（2 月最多 29 日）'
              },
              segments: []
            }
          }
          const rawOrigin = call.arguments['origin']
          const origin: TaskOriginArg =
            rawOrigin === 'user' || rawOrigin === 'system' ? rawOrigin : 'agent'
          const rawDelivery = call.arguments['delivery']
          const delivery: TaskDeliveryArg =
            rawDelivery === 'foreground' || rawDelivery === 'background' ? rawDelivery : 'auto'
          const outcome = deps.tasks.schedule({
            instruction,
            when,
            repeat,
            ...(weekdays === undefined ? {} : { weekdays }),
            ...(monthDays === undefined ? {} : { monthDays }),
            ...(yearly === undefined ? {} : { yearlyMonth: yearly.month, yearlyDay: yearly.day }),
            origin,
            delivery,
            validUntil
          })
          return {
            result: {
              kind: 'schedule_task',
              freshness: currentFreshness(deps),
              ok: outcome.ok,
              task: outcome.task,
              message: outcome.message
            },
            segments: []
          }
        }
        if (call.name === 'search_tasks') {
          if (deps.tasks === undefined) {
            return {
              result: { kind: 'error', message: '现在查不了任务（这台机器没有任务库）' },
              segments: []
            }
          }
          const rawView = call.arguments['view']
          const view =
            rawView === 'pending' || rawView === 'day' || rawView === 'upcoming' || rawView === 'about'
              ? rawView
              : undefined
          if (view === undefined) {
            return {
              result: { kind: 'error', message: 'search_tasks 需要 view: pending / day / upcoming / about' },
              segments: []
            }
          }
          const day = optionalText(call.arguments['day'], 10)
          const query = optionalText(call.arguments['query'], 60)
          if (view === 'day' && day === undefined) {
            return { result: { kind: 'error', message: 'view=day 时要给 day（`YYYY-MM-DD`）' }, segments: [] }
          }
          if (view === 'about' && query === undefined) {
            return { result: { kind: 'error', message: 'view=about 时要给 query（事项关键词）' }, segments: [] }
          }
          const limit = clampLimit(call.arguments['limit'], 20, 50)
          const outcome = deps.tasks.search({
            view,
            ...(day === undefined ? {} : { day }),
            ...(query === undefined ? {} : { query }),
            limit
          })
          return {
            result: {
              kind: 'search_tasks',
              freshness: currentFreshness(deps),
              view,
              tasks: outcome.tasks,
              total: outcome.total,
              truncated: outcome.truncated
            },
            segments: []
          }
        }
        if (call.name === 'update_task') {
          const id = taskIdOf(call.arguments['id'])
          if (id === undefined) {
            return { result: { kind: 'error', message: 'update_task 需要 id（search_tasks 里有）' }, segments: [] }
          }
          if (deps.tasks === undefined) {
            return { result: { kind: 'error', message: '现在改不了任务（这台机器没有任务库）' }, segments: [] }
          }
          const instruction = optionalText(call.arguments['instruction'], 500)
          const rawWhen = call.arguments['when']
          const when = rawWhen === undefined ? undefined : parseLocalStamp(rawWhen)
          if (rawWhen !== undefined && when === null) {
            return {
              result: { kind: 'error', message: 'when 要写成 `YYYY-MM-DD HH:mm`（本地时间）' },
              segments: []
            }
          }
          const rawValid = call.arguments['valid_until']
          const validUntil = rawValid === undefined ? undefined : parseLocalStamp(rawValid)
          if (rawValid !== undefined && validUntil === null) {
            return {
              result: { kind: 'error', message: 'valid_until 要写成 `YYYY-MM-DD HH:mm`（本地时间）' },
              segments: []
            }
          }
          const rawRepeat = call.arguments['repeat']
          const repeat: TaskRepeatArg | undefined =
            rawRepeat === 'daily' ||
            rawRepeat === 'weekly' ||
            rawRepeat === 'monthly' ||
            rawRepeat === 'yearly' ||
            rawRepeat === ''
              ? rawRepeat
              : undefined
          const weekdays = parseRepeatDays(call.arguments['weekdays'], 1, 7)
          if (weekdays === null) {
            return {
              result: {
                kind: 'error',
                message: 'weekdays 要用 1–7 的整数数组（1=周一 … 7=周日），可多选，例如 [1,3,5]'
              },
              segments: []
            }
          }
          const monthDays = parseRepeatDays(call.arguments['month_days'], 1, 31)
          if (monthDays === null) {
            return {
              result: {
                kind: 'error',
                message: 'month_days 要用 1–31 的整数数组，可多选，例如 [1,15]'
              },
              segments: []
            }
          }
          const yearly = parseYearlyDateArgs(
            call.arguments['yearly_month'],
            call.arguments['yearly_day']
          )
          if (yearly === null) {
            return {
              result: {
                kind: 'error',
                message: 'yearly_month / yearly_day 要一起给：month 1–12、day 1–31（2 月最多 29 日）'
              },
              segments: []
            }
          }
          const rawDelivery = call.arguments['delivery']
          const delivery: TaskDeliveryArg | undefined =
            rawDelivery === 'foreground' || rawDelivery === 'background' || rawDelivery === 'auto'
              ? rawDelivery
              : undefined
          const rawState = call.arguments['state']
          const state: TaskStateArg | undefined =
            rawState === 'active' ||
            rawState === 'paused' ||
            rawState === 'completed' ||
            rawState === 'cancelled'
              ? rawState
              : undefined
          const outcome = deps.tasks.update({
            id,
            ...(instruction === undefined ? {} : { instruction }),
            ...(when === undefined ? {} : { when }),
            ...(repeat === undefined ? {} : { repeat }),
            ...(weekdays === undefined ? {} : { weekdays }),
            ...(monthDays === undefined ? {} : { monthDays }),
            ...(yearly === undefined ? {} : { yearlyMonth: yearly.month, yearlyDay: yearly.day }),
            ...(delivery === undefined ? {} : { delivery }),
            ...(validUntil === undefined ? {} : { validUntil }),
            ...(state === undefined ? {} : { state })
          })
          return {
            result: {
              kind: 'update_task',
              freshness: currentFreshness(deps),
              ok: outcome.ok,
              task: outcome.task,
              message: outcome.message
            },
            segments: []
          }
        }
        if (call.name === 'cancel_task') {
          const id = taskIdOf(call.arguments['id'])
          if (id === undefined) {
            return { result: { kind: 'error', message: 'cancel_task 需要 id（search_tasks 里有）' }, segments: [] }
          }
          if (deps.tasks === undefined) {
            return { result: { kind: 'error', message: '现在取消不了任务（这台机器没有任务库）' }, segments: [] }
          }
          const outcome = deps.tasks.cancel(id)
          return {
            result: {
              kind: 'cancel_task',
              freshness: currentFreshness(deps),
              ok: outcome.ok,
              task: outcome.task,
              message: outcome.message
            },
            segments: []
          }
        }
        if (call.name === 'visit_world') {
          const action = call.arguments['action'] ?? 'look'
          if (action !== 'look' && action !== 'read' && action !== 'claim') {
            return { result: { kind: 'error', message: 'visit_world 的 action 是 look / read / claim' }, segments: [] }
          }
          if (deps.world === undefined) return { result: { kind: 'error', message: '这边还没有接上世界。' }, segments: [] }
          const rawId = call.arguments['id']
          const id = typeof rawId === 'string' ? rawId.trim() : undefined
          const result = deps.world.visit({ action, ...(id ? { id } : {}) })
          return { result: { kind: 'visit_world', ...result }, segments: [] }
        }
        if (call.name === 'read_notebook') {
          if (deps.notebook?.read === undefined) {
            return { result: { kind: 'error', message: '这边还翻不开小本本。' }, segments: [] }
          }
          if (deps.notebook.owned?.() === false) {
            return { result: { kind: 'error', message: '这里还没有小本本；物品架上有一本空白的。' }, segments: [] }
          }
          const section = typeof call.arguments['section'] === 'string' ? call.arguments['section'].trim() : undefined
          const query = typeof call.arguments['query'] === 'string' ? call.arguments['query'].trim() : undefined
          const entries = deps.notebook.read().filter((entry) =>
            (!section || entry.section === section) && (!query || entry.text.includes(query)))
          return { result: { kind: 'read_notebook', entries }, segments: [] }
        }
        if (call.name === 'update_notebook') {
          const action = call.arguments['action']
          if (action !== 'add' && action !== 'revise' && action !== 'remove') {
            return {
              result: { kind: 'error', message: 'update_notebook 需要 action：add / revise / remove' },
              segments: []
            }
          }
          if (deps.notebook === undefined) {
            return {
              result: { kind: 'error', message: '现在写不了小本本（这个分支没挂工具，或记忆仓不可用）' },
              segments: []
            }
          }
          const rawSection = call.arguments['section']
          const section = typeof rawSection === 'string' ? rawSection.trim() : undefined
          const id = optionalText(call.arguments['id'], 20)
          const rawText = call.arguments['text']
          const text = typeof rawText === 'string' && rawText.trim() !== '' ? rawText.trim() : undefined
          if (action === 'add') {
            if (section !== undefined && /[\r\n]/u.test(section)) {
              return {
                result: {
                  kind: 'error',
                  message:
                    '栏目名称含换行，无法写成一个标题。'
                },
                segments: []
              }
            }
            if (text === undefined) {
              return { result: { kind: 'error', message: 'add 需要 text（要记下的那句话）' }, segments: [] }
            }
          }
          if (action === 'revise' && (id === undefined || text === undefined)) {
            return {
              result: { kind: 'error', message: 'revise 需要 id（如 n3）和新的 text' },
              segments: []
            }
          }
          if (action === 'remove' && id === undefined) {
            return { result: { kind: 'error', message: 'remove 需要 id（如 n3）' }, segments: [] }
          }
          const outcome = deps.notebook.update({
            action,
            ...(section === undefined || action !== 'add' ? {} : { section }),
            ...(id === undefined ? {} : { id }),
            ...(text === undefined ? {} : { text })
          })
          return {
            result: {
              kind: 'update_notebook',
              ok: outcome.ok,
              entry: outcome.entry,
              total: outcome.total,
              message: outcome.message
            },
            segments: []
          }
        }
        if (call.name === 'write_growth') {
          const rawKind = call.arguments['kind']
          const kind = growthKindArgOf(rawKind)
          if (kind === null) {
            return {
              result: {
                kind: 'error',
                message:
                  'write_growth 需要 kind：daily（今天的日记）/ weekly（这一周的周记）/ monthly（这个月的月末总结）/ yearly（这一年的年终总结）'
              },
              segments: []
            }
          }
          const rawContent = call.arguments['content']
          const content = typeof rawContent === 'string' ? rawContent : ''
          if (content.trim() === '') {
            return { result: { kind: 'error', message: 'write_growth 需要 content（正文）' }, segments: [] }
          }
          // 不静默截断：超过安全线就如实拒绝，让 ta 自己挑重点
          if (content.length > 4000) {
            return {
              result: { kind: 'error', message: `正文太长（${content.length} 字，最多 2000 字）：挑最重要的写。` },
              segments: []
            }
          }
          if (deps.growth === undefined) {
            return {
              result: {
                kind: 'error',
                message: '现在写不了成长档案（这个分支没挂工具，或记忆仓不可用）'
              },
              segments: []
            }
          }
          const outcome = deps.growth.write({ kind, content })
          return {
            result: {
              kind: 'write_growth',
              ok: outcome.ok,
              growthKind: outcome.kind,
              period: outcome.period,
              chars: outcome.chars,
              message: outcome.message
            },
            segments: []
          }
        }
        if (call.name === 'quote_message') {
          if (deps.quoteMessage === undefined) {
            return {
              result: {
                kind: 'error',
                message: '现在引用不了（这条通道没有聊天台账）'
              },
              segments: []
            }
          }
          if (quotedTarget !== null) {
            return {
              result: {
                kind: 'error',
                message: `这一轮已经引用过 #${quotedTarget.id} 了，回答里直接说就行`
              },
              segments: []
            }
          }
          const id = quoteShortId(call.arguments['id'])
          if (id === null) {
            return {
              result: {
                kind: 'error',
                message: 'quote_message 需要消息短号（例如 #12 或 12）'
              },
              segments: []
            }
          }
          const lookup = deps.quoteMessage(id)
          const target = lookup.target
          if (target === undefined) {
            const recent = lookup.recent.slice(0, 6)
            return {
              result: {
                kind: 'error',
                message:
                  recent.length === 0
                    ? `没有 #${id} 这条消息（这次聊天里还没有能引用的）`
                    : `没有 #${id} 这条消息；最近能引用的是：${recent.map((n) => `#${n}`).join('、')}`
              },
              segments: []
            }
          }
          quotedTarget = target
          return {
            result: {
              kind: 'quote_message',
              id: target.id,
              from: target.from,
              text: target.text,
              ok: true
            },
            segments: [],
            replyTo: target.qqId
          }
        }
        // ---- QQ 表情 ／ 发图（D96 / PR2）------------------------------------
        if (call.name === 'send_sticker') {
          const port = deps.stickers
          if (port === undefined) {
            return {
              result: { kind: 'error', message: '这边发不了表情（这条通道没有表情池）' },
              segments: []
            }
          }
          const rawId = call.arguments['id']
          const stickerId =
            typeof rawId === 'string' || typeof rawId === 'number'
              ? normalizeArchiveId(String(rawId))
              : null
          if (stickerId === null) {
            // 不带 id = 只看图鉴，不发（模型据此挑一张）
            const catalog = port.list().slice(0, STICKER_CATALOG_MAX).map((entry) => ({
              id: entry.id,
              label: entry.label,
              desc: entry.desc,
              tags: [...entry.tags],
              useCount: entry.useCount
            }))
            return {
              result: {
                kind: 'send_sticker',
                ok: true,
                stickerId: null,
                label: '',
                catalog,
                message:
                  catalog.length === 0
                    ? '表情包还是空的：先收几张（收到图可以让我存成表情），以后才发得出来'
                    : '图鉴在上；挑一张，带 id 再调一次才会发（不带 id 只给你看）'
              },
              segments: []
            }
          }
          if (pickedSticker !== null) {
            return {
              result: {
                kind: 'error',
                message: `这一轮已经挑过表情 #${pickedSticker} 了：一条回答最多带一张表情`
              },
              segments: []
            }
          }
          const picked = port.pick(stickerId)
          if (picked === null) {
            return {
              result: {
                kind: 'error',
                message: `没有 #${stickerId} 这张表情（id 不对，或者文件已经没了）：不带 id 调一次看图鉴`
              },
              segments: []
            }
          }
          pickedSticker = picked.view.id
          return {
            result: {
              kind: 'send_sticker',
              ok: true,
              stickerId: picked.view.id,
              label: picked.view.label,
              catalog: [],
              message: `排好了：回答之后发「${picked.view.label}」`
            },
            segments: [],
            media: {
              kind: 'sticker',
              dataUrl: picked.dataUrl,
              label: picked.view.label,
              ref: picked.view.id
            }
          }
        }
        if (call.name === 'save_sticker') {
          const port = deps.stickers
          if (port === undefined) {
            return {
              result: { kind: 'error', message: '这边收不了表情（这条通道没有表情池）' },
              segments: []
            }
          }
          const rawImageId = call.arguments['image_id']
          const imageId = typeof rawImageId === 'string' ? normalizeArchiveId(rawImageId) : null
          const label = optionalText(call.arguments['label'], STICKER_LABEL_MAX_CHARS)
          if (imageId === null) {
            return {
              result: {
                kind: 'error',
                message: 'save_sticker 需要 image_id：图片占位符里的 #id（只收这次会话里真实出现过的图）'
              },
              segments: []
            }
          }
          if (label === undefined) {
            return {
              result: { kind: 'error', message: 'save_sticker 需要 label：给这张图起个名字（≤20 字）' },
              segments: []
            }
          }
          const image = deps.imageById?.(imageId) ?? null
          if (image === null) {
            return {
              result: {
                kind: 'error',
                message: '这次会话里没有这张图的原始字节：只能收你这一轮收到 / 看到的图'
              },
              segments: []
            }
          }
          const desc = optionalText(call.arguments['desc'], STICKER_DESC_MAX_CHARS)
          const saved = port.save({
            dataUrl: image,
            label,
            ...(desc !== undefined ? { desc } : {})
          })
          if (!saved.ok) {
            return {
              result: {
                kind: 'save_sticker',
                ok: false,
                stickerId: null,
                label,
                duplicate: false,
                message: saved.error
              },
              segments: []
            }
          }
          return {
            result: {
              kind: 'save_sticker',
              ok: true,
              stickerId: saved.id,
              label: saved.label,
              duplicate: saved.duplicate,
              message: saved.duplicate
                ? `这张图本来就在表情包里（#${saved.id}「${saved.label}」），标签已经按你说的更新`
                : `收好了：#${saved.id}「${saved.label}」`
            },
            segments: []
          }
        }
        if (call.name === 'send_image') {
          const rawImageId = call.arguments['archive_id'] ?? call.arguments['image_id']
          const imageId = typeof rawImageId === 'string' ? normalizeArchiveId(rawImageId) : null
          if (imageId === null) {
            return {
              result: {
                kind: 'error',
                message: 'send_image 需要 archive_id：图片占位符里的 #id（只发这次会话里真实出现过的图）'
              },
              segments: []
            }
          }
          if (pickedImage !== null) {
            return {
              result: {
                kind: 'error',
                message: `这一轮已经挑过图片 #${pickedImage} 了：一条回答最多带一张图`
              },
              segments: []
            }
          }
          const image = deps.imageById?.(imageId) ?? null
          if (image === null) {
            return {
              result: {
                kind: 'error',
                message: '这次会话里没有这张图（只能发你这一轮收到 / 看到过、或者我打开过的截图）'
              },
              segments: []
            }
          }
          pickedImage = imageId
          return {
            result: {
              kind: 'send_image',
              ok: true,
              imageId,
              message: '排好了：回答之后把这张图发出去'
            },
            segments: [],
            media: { kind: 'image', dataUrl: image, ref: imageId }
          }
        }
        return { result: { kind: 'error', message: `未知工具：${call.name}` }, segments: [] }
      } catch {
        // 异常原文可能带库路径 / SQL 细节，不回给模型；驱动层会记日志
        return { result: { kind: 'error', message: '工具执行失败' }, segments: [] }
      }
    }
  }
}
