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
  RedactableAskLoopToolResult
} from './payload'
import { ASK_LOOP_READ_MAX_CHARS, ASK_LOOP_READ_MIN_CHARS } from './payload'
import { readChainFreshness } from './freshness'

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
export interface DiaryToolDeps {
  recall(query: {
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, maxChars)
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const raw = optionalNumber(value)
  if (raw === undefined) return fallback
  return Math.min(max, Math.max(1, Math.round(raw)))
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
      result: { kind: 'error', message: '只能展开 search_info 返回过的段（先检索，再按 segmentId 展开）' },
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
        return { result: { kind: 'error', message: `未知工具：${call.name}` }, segments: [] }
      } catch {
        // 异常原文可能带库路径 / SQL 细节，不回给模型；驱动层会记日志
        return { result: { kind: 'error', message: '工具执行失败' }, segments: [] }
      }
    }
  }
}
