/**
 * 信息链 · 问记忆的送云载荷（核心侧）
 *
 * **边界**：本模块只做「协议组装 + 截断 + 品牌」——问题、证据、工具结果怎么排成
 * 一份载荷是核心功能；哪些文本不许出云是安全策略，由调用方注入 `AskTextPolicy`。
 *
 * 2026-10-30（D64）：工具循环改成「固定 system + 只追加消息」。本模块负责把
 * 「此刻 / 数据边界 / 最近段」渲染成一条 `<now>` 正文，并把会话历史原样透传
 * （`conversation`）；消息怎么排由 `deepseek.ts` 决定。
 * 云端实现见 `understand/cloud/ask-outbound.ts`（`createCloudAskOutbound()`），
 * 本机模型 / 测试可用 `createLocalAskOutbound()` 直通。
 *
 * 这样核心功能（检索、工具循环、问答）不 import `understand/cloud/redact`，
 * 安全规则坏掉 / 还没配好时不会把「问记忆」整条链路卡死；只有真正要出网时，
 * 组合根（`main/index.ts`）才把云端策略接进来。
 */

import type { CloudAskConversationTurn } from './conversation'
import { ASK_TOOL_NAMES, hasScreenTools } from './tool-catalog'

/** 出云文本的剥离结果（策略实现返回；核心只消费，不认识具体规则） */
export interface AskTextRedaction {
  text: string
  /** 命中过非阻断规则、有片段被替换 */
  redacted: boolean
  /** true = 命中密码类 / 无法安全剥离的规则，整条不得出云 */
  blocked: boolean
}

/** 注入给载荷组装的文本策略：云端 = 脱敏墙，本机 = 直通 */
export interface AskTextPolicy {
  redact(text: string): AskTextRedaction
}

/**
 * 用户随问题上传的附件（2026-10-29）：
 * - 图片：用户在输入框粘贴 / 拖进来 / 选的，与选区截图同口径，不过脱敏墙；
 * - 文件：只收文本类，抽取出来的文本随问题一起出云；用户主动选的，同样不过脱敏墙。
 * 这里只做协议校验与截断，安全判定在出云门（D24）。
 */
export interface RedactableAskAttachments {
  images?: readonly string[]
  files?: readonly { name: string; text: string }[]
}

/** 协议处理后的附件（图片 data URL、文件文本已截断） */
export interface CloudAskAttachments {
  readonly images: readonly string[]
  readonly files: readonly { readonly name: string; readonly text: string }[]
}

/** 附件上限：条数 / 单图体积（data URL 字符数）/ 文件文本总量（字符） */
const ATTACH_IMAGE_MAX = 4
const ATTACH_FILE_MAX = 4
const ATTACH_IMAGE_DATA_URL_MAX_CHARS = 6 * 1024 * 1024
const ATTACH_FILE_NAME_MAX_CHARS = 120
const ATTACH_TEXT_TOTAL_MAX_CHARS = 30_000
const ATTACH_IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,/i

/** 图片附件 → 协议视图：只收图片 data URL，条数与单张长度钳死 */
function guardAttachImages(images: readonly string[] | undefined): string[] {
  if (!images || images.length === 0) return []
  const out: string[] = []
  for (const url of images) {
    if (typeof url !== 'string' || url.length > ATTACH_IMAGE_DATA_URL_MAX_CHARS) continue
    if (!ATTACH_IMAGE_DATA_URL_RE.test(url)) continue
    out.push(url)
    if (out.length >= ATTACH_IMAGE_MAX) break
  }
  return out
}

/** 文本附件 → 协议视图：逐条截断文件名，正文按总预算切（后略标记写在正文里） */
function guardAttachFiles(files: readonly { name: string; text: string }[] | undefined): { name: string; text: string }[] {
  if (!files || files.length === 0) return []
  const out: { name: string; text: string }[] = []
  let remaining = ATTACH_TEXT_TOTAL_MAX_CHARS
  for (const file of files) {
    if (remaining <= 0 || out.length >= ATTACH_FILE_MAX) break
    if (typeof file.text !== 'string') continue
    const name = (file.name ?? '').trim().slice(0, ATTACH_FILE_NAME_MAX_CHARS) || '未命名文件'
    const text = file.text.slice(0, remaining)
    if (text.trim() === '') continue
    const clipped = text.length < file.text.length ? `${text}\n…（后面还有 ${file.text.length - text.length} 字，已截断）` : text
    out.push({ name, text: clipped })
    remaining -= text.length
  }
  return out
}

/** 附件协议视图（没有附件返回 undefined，载荷里就不出现这个键） */
function guardAttachments(
  attachments: RedactableAskAttachments | undefined
): CloudAskAttachments | undefined {
  if (!attachments) return undefined
  const images = guardAttachImages(attachments.images)
  const files = guardAttachFiles(attachments.files)
  if (images.length === 0 && files.length === 0) return undefined
  return { images, files }
}

/** 开场注入的「此刻」事实上限：一两句话，撑大反而像旁白 */
const OPENING_FACTS_MAX_CHARS = 300
/** 开场最多带几条「想到的」：与工具召回同量级，多了会变成塞满上下文 */
export const ASK_LOOP_OPENING_REMEMBERED_MAX = 3

/**
 * 开场注入 → 送云视图。逐段过策略：
 * - facts 是本地算的（时间 / 计数 / 日期），过一遍只为口径统一；
 * - 日记片段是用户正文：命中阻断规则整条丢，不连坐。
 */
function guardOpening(
  policy: AskTextPolicy,
  opening: RedactableAskOpening | undefined
): CloudAskOpening | undefined {
  if (!opening) return undefined
  let facts: string | undefined
  if (opening.facts !== undefined && opening.facts.trim() !== '') {
    const guarded = guardText(policy, opening.facts, OPENING_FACTS_MAX_CHARS)
    if (!guarded.blocked) facts = guarded.text
  }
  const remembered: Array<{ day: string; snippet: string }> = []
  for (const hit of opening.remembered ?? []) {
    const day = guardText(policy, hit.day, 20)
    if (day.blocked) continue
    const snippet = guardText(policy, hit.snippet, ASK_LOOP_DIARY_SNIPPET_MAX_CHARS)
    if (snippet.blocked) continue
    remembered.push({ day: day.text, snippet: snippet.text })
    if (remembered.length >= ASK_LOOP_OPENING_REMEMBERED_MAX) break
  }
  if (facts === undefined && remembered.length === 0) return undefined
  return {
    ...(facts !== undefined ? { facts } : {}),
    ...(remembered.length > 0 ? { remembered } : {})
  }
}

/** 问记忆（S1）里的单段证据 */
export interface CloudChainAskEvidence {
  readonly segmentId: number
  readonly app: string
  readonly title: string
  readonly startTs: number
  readonly endTs: number
  readonly text: string
  readonly truncated: boolean
  readonly tags: readonly string[]
  readonly links: readonly string[]
}

declare const chainAskBrand: unique symbol

/** 问记忆载荷（只能由载荷组装产出；品牌只存在于类型层） */
export interface ChainAskPayload {
  readonly question: string
  readonly evidence: readonly CloudChainAskEvidence[]
  /** 用户随问题上传的附件（没有就不出现） */
  readonly attachments?: CloudAskAttachments
  readonly [chainAskBrand]: true
}

export interface RedactableChainAskEvidence {
  segmentId: number
  app: string
  title: string
  startTs: number
  endTs: number
  /** 命中原文片段（上游已按上限截断） */
  text: string
  truncated?: boolean
  tags?: readonly string[]
  links?: readonly string[]
}

export interface AskBuildOptions {
  /** 证据正文上限；默认 500 */
  textMaxChars?: number
  appMaxChars?: number
  titleMaxChars?: number
  /** 问题的字符上限；默认 500（问题是用户敲的，不该有长文） */
  questionMaxChars?: number
  /**
   * 用户随本轮问题上传的附件（图片 / 文本文件）。
   * 与选区截图同口径：用户主动提供，不过脱敏墙；出云门照旧在门口判定。
   */
  attachments?: RedactableAskAttachments
}

export interface ChainAskBuildResult {
  payload: ChainAskPayload
  /** 问题本身命中敏感规则：整次不该出云（载荷里 question 为空） */
  questionBlocked: boolean
  /** 被敏感规则挡下、整段不出云的段 id */
  blockedSegmentIds: number[]
  /** 有片段被替换成 `[已脱敏]` 的段 id */
  redactedSegmentIds: number[]
}

/** 数据新鲜度（数字为毫秒时间戳；空库为 null） */
export interface AskLoopFreshness {
  readonly latestEvidenceTs: number | null
  readonly captureRunning: boolean
}

/**
 * 提问前最后一段证据（应用 / 标题 / 时刻）。
 * 只当「这个界面 / 刚才那个」的指代线索——不是证据，模型引用它必须经 search_info / read_segment。
 */
export interface AskRecentSegment {
  readonly app: string
  readonly title: string
  /** 毫秒时间戳（送云前按 HH:mm 展示，不带数字） */
  readonly at: number
}

/** search_info 摘要里的一条命中（送云前过策略；`at` 是 'HH:mm'，提示纪律要求模型用它指证据） */
export interface RedactableAskLoopHit {
  segmentId: number
  at: string
  app: string
  title: string
  snippet: string
  tags: readonly string[]
  links: readonly string[]
  /** 段正文里出现的网址（送云前同样逐条过策略，命中阻断规则的单条丢弃） */
  urls: readonly string[]
}

/**
 * ask_history 摘要里的一条历史问答。
 * 只给本地可读时刻 `time`：毫秒时间戳一律不出云——模型拿到数字会自己换算，
 * 真实记录里同一条 15:01 的问答被答成过 11:01（还报出了时间戳）。
 */
export interface RedactableAskLoopHistoryEntry {
  time: string
  question: string
  kind: string
  /** 本会话 / 其他会话（scope=all 时尤其重要：别的会话不能被说成「你刚才问的」） */
  session?: 'current' | 'other'
}

/** 续问时带上的一轮对话（问题 + 最终答复 / 澄清问题） */
export interface RedactableAskLoopConversationTurn {
  question: string
  answer: string
}

/**
 * 开场注入（2026-10-29 深夜七，D61）：「此刻」每轮注入，「想到的」只在新对话第一问出现。
 *
 * - `facts`：本地算出来的「此刻」事实（时间 / 今天说过几句 / 上次多久前 / 日记记到哪天），
 *   不含用户正文；由主进程用确定规则算，不是模型推测。
 * - `remembered`：按问题关键词本地回想到的日记片段——**联想，不是证据**；
 *   想核对要让它自己 `recall_diary` / `read_diary`（引用仍只由「真的打开过」生成）。
 *
 * 两段都按屏幕 / 日记文本同口径过策略：命中断阻断就整条丢，半截被打码也照实带出去。
 */
export interface RedactableRememberedHit {
  day: string
  snippet: string
}

export interface RedactableAskOpening {
  facts?: string
  remembered?: readonly RedactableRememberedHit[]
}

/** 过策略后的开场注入（送云视图） */
export interface CloudAskOpening {
  readonly facts?: string
  readonly remembered?: readonly { readonly day: string; readonly snippet: string }[]
}

/**
 * 日记召回的一条命中（个人记忆 · 第二本账）。
 * `day` 是日记文件名日期（本地可读，不带时间戳）；`snippet` 是原文片段。
 */
export interface RedactableDiaryHit {
  itemId: number
  day: string
  kind: string
  snippet: string
  tags: readonly string[]
  refs: readonly string[]
  /** 为什么命中（提到 X / 标签 / 距今多少天）；模型要能向用户解释「为什么给这几条」 */
  reasons: readonly string[]
}

/** 打开某一天后返回的条目（供模型引用；只有 itemId 能在最终 memories 里被承认） */
export interface RedactableDiaryItem {
  itemId: number
  section: string
  text: string
}

/** 「关于我」的一条观测（当前只有统计型，来源写死在 `source`） */
export interface RedactableDiaryObservation {
  topic: string
  statement: string
}

/** 一次工具结果的待组装视图：按 kind 决定哪些字段是屏幕文本 */
export type RedactableAskLoopToolResult =
  | {
      kind: 'search_info'
      freshness: AskLoopFreshness
      hits: readonly RedactableAskLoopHit[]
      stats: { mode: string; keywordRows: number }
    }
  | { kind: 'get_freshness'; freshness: AskLoopFreshness }
  | { kind: 'ask_history'; freshness: AskLoopFreshness; entries: readonly RedactableAskLoopHistoryEntry[] }
  /**
   * 展开一段命中段的正文（search_info 只给 80 字摘要；地址栏 / 链接常在正文中后段）。
   * 只能读 search_info 返回过的段（驱动层用引用白名单校验，执行器不做越权读取）。
   * `text` 是该段完整正文（本地），策略处理后按 offset / limit 切出载荷片段。
   */
  | {
      kind: 'read_segment'
      freshness: AskLoopFreshness
      segmentId: number
      at: string
      app: string
      title: string
      /** 只含 UIA 采到的界面文字；OCR 不当作读段证据（2026-10-29 拍板） */
      text: string
      urls: readonly string[]
      offset: number
      limit: number
      /** 附在工具结果后面的截图张数（0 = 没开历史截图 / 这一段没图） */
      shotCount?: number
    }
  /** 执行器兜底：参数不合法 / 未知工具 / 执行抛错（message 是固定文案或已过策略的工具名） */
  | { kind: 'error'; message: string }
  /** 日记召回（个人记忆 · 第二本账；与屏幕段检索并列） */
  | {
      kind: 'recall_diary'
      freshness: AskLoopFreshness
      hits: readonly RedactableDiaryHit[]
      stats: { mode: string; candidates: number }
    }
  /** 打开某一天：返回该天的条目与拼接后的全文（模型可据此引用具体 itemId） */
  | {
      kind: 'read_diary'
      freshness: AskLoopFreshness
      day: string
      text: string
      items: readonly RedactableDiaryItem[]
      offset: number
      limit: number
    }
  /** 「关于我」：条目 / 天数 / 待办 / 高频话题（全部是统计，不是心理分析） */
  | {
      kind: 'memory_profile'
      freshness: AskLoopFreshness
      stats: Record<string, number | string | null>
      observations: readonly RedactableDiaryObservation[]
    }
  /**
   * 传承（M4）：this generation 已经把记忆线交给女儿。
   * `born=true` 时工具结果会告诉模型「这一问之后从空白开始」；`nickname` 是女儿的分支名。
   */
  | {
      kind: 'conceive_daughter'
      freshness: AskLoopFreshness
      born: boolean
      nickname: string
      message: string
    }

/** 循环里的一次往返：模型发起的调用 + 执行器给出的摘要 */
export interface RedactableAskLoopTurn {
  toolCall: { name: string; arguments: Record<string, unknown> }
  toolResult: RedactableAskLoopToolResult
  /**
   * read_segment 带出的截图（data URL）。
   * 2026-10-29 拍板：OCR 不可信，读段只给 UIA 文字 + 截图；图走 user 消息，
   * 不能塞进 tool 消息（DeepSeek 只允许 user 消息带图，tool 带图直接 400）。
   */
  images?: readonly string[]
  /**
   * 这一轮模型给出的思维链（只有开 thinking 才有）。回传给模型时**原样**带回去：
   * DeepSeek 在请求带 `tools` 时要求回传历史各轮 CoT，缺了就从第 2 轮起 400。
   */
  reasoning?: string
}

/** 策略处理后的工具调用（arguments 里的字符串叶子已过策略） */
export interface CloudAskLoopTurn {
  readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> }
  readonly toolResult: Record<string, unknown>
  /** see `RedactableAskLoopTurn.images`（已过协议校验；未开历史截图时为空） */
  readonly images?: readonly string[]
  /** 同一轮的思维链（模型自己产出的，只回传给同一个模型，不落盘界面之外） */
  readonly reasoning?: string
}

declare const chainAskLoopBrand: unique symbol

/** 循环载荷（只能由载荷组装产出；品牌只存在于类型层） */
export interface ChainAskLoopPayload {
  readonly question: string
  readonly systemTime: string
  readonly freshness: AskLoopFreshness
  readonly turns: readonly CloudAskLoopTurn[]
  /** 同一会话里之前几轮（已处理、已限额；空数组 = 新对话） */
  readonly history: readonly { readonly question: string; readonly answer: string }[]
  /**
   * 本轮 `<now>` 正文（当前时间 / 此刻 / 想到的 / 数据边界 / 最近段）。
   * 它不是用户说的话，拼在 user 消息的问题之后（同一条 user，避免连续 user 被 reasoner 拒）。
   */
  readonly now: string
  /**
   * 之前轮次（已过策略，回放时逐字节一致）。有它时消息按
   * 「user(问题 + now) → 工具轮 → assistant」原样重放；没有会话存储时由
   * `history` 播种（只含问答、无工具轮）。
   */
  readonly conversation?: readonly CloudAskConversationTurn[]
  /** 更早会话被裁掉后的摘要（一行行「问 → 答」；没有就不出现） */
  readonly digest?: string
  /** 提问前最后一段证据（指代线索；已过策略，阻断则缺省） */
  readonly recent?: AskRecentSegment
  /** 开场注入（新对话第一问才出现；见 `RedactableAskOpening`） */
  readonly opening?: CloudAskOpening
  /** 当前节点的生命（M3；每轮现算） */
  readonly life?: AskLifeState
  /** 用户随本轮问题上传的附件（图片 / 文本文件；没有就不出现） */
  readonly attachments?: CloudAskAttachments
  readonly [chainAskLoopBrand]: true
}

/** 当前节点的生命（M3）：每轮由组合根现算，只进 `<now>`，不进 system */
export interface AskLifeState {
  /** 最近一次请求的上下文占用（prompt + completion） */
  readonly used: number
  /** 一条命的额度 */
  readonly limit: number
}

export interface ChainAskLoopBuildInput {
  question: string
  systemTime: string
  /** 与 `systemTime` 同一刻的毫秒值；缺省从字符串解析（测试 / 老调用方只给字符串也能用） */
  systemTimeMs?: number
  /** 这次给哪些工具（元素名，D72；决定 `<now>` 里有没有数据边界 / 最近段） */
  tools?: readonly string[]
  freshness: AskLoopFreshness
  turns: readonly RedactableAskLoopTurn[]
  /** 同一会话之前的几轮（新对话不传；仅在没给 `conversation` 时用来播种） */
  history?: readonly RedactableAskLoopConversationTurn[]
  /** 会话存储给出的更早摘要（已过策略，原样透传） */
  digest?: string
  /** 会话存储给出的之前轮次（已过策略，原样透传；给了就不再从 history 播种） */
  conversation?: readonly CloudAskConversationTurn[]
  /** 提问前最后一段证据（应用 / 标题 / 时刻；送云前过策略） */
  recent?: AskRecentSegment
  /** 开场注入（新对话第一问；送云前逐段过策略） */
  opening?: RedactableAskOpening
  /** 当前节点的生命（M3；每轮现算，`<now>` 里的一行事实，不过策略——数字不是隐私） */
  life?: AskLifeState
  /** 用户随本轮问题上传的附件（用户主动提供，不过脱敏墙） */
  attachments?: RedactableAskAttachments
}

export interface ChainAskLoopBuildResult {
  payload: ChainAskLoopPayload
  /** 问题本身命中敏感规则：整次不该出云（载荷里 question 为空） */
  questionBlocked: boolean
  /**
   * 本次构建里被策略整条挡下、不出云的命中段（诊断用）。
   * 驱动层按「本载荷里实际可见的 search_info 命中集合」收缩引用白名单，
   * 不拿它做增量删除，避免把「后来以干净摘要重新展示过」的段误删。
   */
  blockedSegmentIds: number[]
}

/** `/compact` 摘要的送云载荷（M3）：一段已过策略的会话原文 */
export interface AskSummaryPayload {
  readonly text: string
}

export interface AskSummaryBuildResult {
  payload: AskSummaryPayload
  /** 过策略后的字符数 */
  chars: number
  /** 整段被策略挡下（不该出云） */
  blocked: boolean
}

/** 一次摘要最多送多少旧对话（字符）；超出由调用方先截断 */
export const ASK_SUMMARY_MAX_CHARS = 60_000

/** 出云载荷组装端口：核心只依赖这个接口，不依赖任何具体安全实现 */
export interface AskOutbound {
  buildAsk(
    question: string,
    evidence: readonly RedactableChainAskEvidence[],
    options?: AskBuildOptions
  ): ChainAskBuildResult
  buildLoop(input: ChainAskLoopBuildInput): ChainAskLoopBuildResult
  /** `/compact` 的摘要载荷：只过策略 + 截断，不拼问记忆的消息 */
  buildSummary(text: string): AskSummaryBuildResult
}

/* ------------------------------------------------------------------ */
/* 协议常量（与安全规则无关，放核心；旧 redact.ts 继续 re-export）      */
/* ------------------------------------------------------------------ */

const ASK_TAG_MAX_CHARS = 40
const ASK_TAGS_MAX = 8
const ASK_QUESTION_MAX_CHARS = 500
/** 与 LLM_DEFAULTS 的字段截断保持一致（核心协议常量，不 import 云端配置） */
const ASK_APP_MAX_CHARS = 80
const ASK_TITLE_MAX_CHARS = 120

const ASK_LOOP_SNIPPET_MAX_CHARS = 80
const ASK_LOOP_QUESTION_MAX_CHARS = 120
/** 续问带上的历史轮数 / 每轮答复长度上限：上下文够用就好，别把载荷撑爆 */
const ASK_LOOP_HISTORY_MAX_TURNS = 4
const ASK_LOOP_HISTORY_ANSWER_MAX_CHARS = 300
/** 参数处理的递归深度上限：参数只该是扁平小对象，超深结构整体折叠（防自引用 / 防漏检） */
const ASK_LOOP_ARGS_MAX_DEPTH = 4
/** 参数键名长度上限：键名也是模型生成的，长键截断 */
const ASK_LOOP_ARGS_KEY_MAX_CHARS = 64
/** 参数数组 / 对象的条数上限：模型可以塞超长参数，这里给个硬上界防撑爆载荷 */
const ASK_LOOP_ARGS_MAX_ITEMS = 32
const ASK_LOOP_URLS_MAX = 3
/** URL 比标签长得多（B 站带追踪参数的地址可到 150+ 字），单独给上限 */
const ASK_LOOP_URL_MAX_CHARS = 400
/** read_segment 一次送云的正文字符范围（模型可用 offset 继续翻） */
export const ASK_LOOP_READ_MIN_CHARS = 1
export const ASK_LOOP_READ_MAX_CHARS = 6000
/** 日记召回一条最多给多少字：和 search_info 的 80 字摘要同量级（模型要细节必须 read_diary） */
export const ASK_LOOP_DIARY_SNIPPET_MAX_CHARS = 120
/** 日记引用里原文片段的上限（最终答复的 memories[].snippet） */
export const ASK_LOOP_DIARY_QUOTE_MAX_CHARS = 160

/* ------------------------------------------------------------------ */
/* 组装辅助                                                            */
/* ------------------------------------------------------------------ */

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/** 先过策略（剥离）再截断：避免半截密钥漏检 */
function guardText(
  policy: AskTextPolicy,
  text: string | null | undefined,
  maxChars: number
): AskTextRedaction {
  const result = policy.redact(normalizeText(text))
  return {
    text: result.text.slice(0, maxChars),
    redacted: result.redacted,
    blocked: result.blocked
  }
}

/* ------------------------------------------------------------------ */
/* 单发载荷                                                             */
/* ------------------------------------------------------------------ */

/**
 * 问记忆的送云载荷：问题 + 命中的段（都过注入的策略）。
 * 问题被挡就整次不出云——是否允许「挡」由策略决定；核心不预设规则。
 */
export function buildAskPayload(
  question: string,
  evidence: readonly RedactableChainAskEvidence[],
  policy: AskTextPolicy,
  options: AskBuildOptions = {}
): ChainAskBuildResult {
  const limits = {
    textMaxChars: options.textMaxChars ?? 500,
    appMaxChars: options.appMaxChars ?? ASK_APP_MAX_CHARS,
    titleMaxChars: options.titleMaxChars ?? ASK_TITLE_MAX_CHARS,
    questionMaxChars: options.questionMaxChars ?? ASK_QUESTION_MAX_CHARS
  }

  const asked = guardText(policy, question, limits.questionMaxChars)
  const attachments = guardAttachments(options.attachments)
  const views: CloudChainAskEvidence[] = []
  const blockedSegmentIds: number[] = []
  const redactedSegmentIds: number[] = []

  for (const segment of evidence) {
    const app = guardText(policy, segment.app, limits.appMaxChars)
    const title = guardText(policy, segment.title, limits.titleMaxChars)
    const text = guardText(policy, segment.text, limits.textMaxChars)
    if (app.blocked || title.blocked || text.blocked) {
      blockedSegmentIds.push(segment.segmentId)
      continue
    }
    if (app.redacted || title.redacted || text.redacted) redactedSegmentIds.push(segment.segmentId)
    views.push({
      segmentId: segment.segmentId,
      app: app.text,
      title: title.text,
      startTs: segment.startTs,
      endTs: segment.endTs,
      text: text.text,
      truncated: segment.truncated ?? false,
      tags: (segment.tags ?? []).slice(0, ASK_TAGS_MAX).map((tag) => tag.slice(0, ASK_TAG_MAX_CHARS)),
      links: (segment.links ?? []).slice(0, ASK_TAGS_MAX).map((link) => link.slice(0, ASK_TAG_MAX_CHARS))
    })
  }

  return {
    payload: {
      question: asked.blocked ? '' : asked.text,
      evidence: views,
      ...(attachments ? { attachments } : {})
    } as unknown as ChainAskPayload,
    questionBlocked: asked.blocked,
    blockedSegmentIds,
    redactedSegmentIds
  }
}

/* ------------------------------------------------------------------ */
/* 工具循环载荷                                                         */
/* ------------------------------------------------------------------ */

/**
 * 参数键名过策略（键名也是模型生成的，与值同一口径）：返回 null 表示阻断，
 * 整条键值对丢弃——执行器本来就只读已知键，丢一条不影响功能。
 */
function guardArgsKey(policy: AskTextPolicy, key: string): string | null {
  const result = policy.redact(normalizeText(key))
  return result.blocked ? null : result.text.slice(0, ASK_LOOP_ARGS_KEY_MAX_CHARS)
}

/**
 * 工具参数里的一棵值树逐个过策略（模型输出不可信：schema 是平的，
 * 模型完全可能塞嵌套结构）。
 * - string → 策略处理，阻断替换为空串；
 * - 数组 → 逐项递归（数组里的对象也要进去），最多留 32 项；
 * - 纯对象 → **键名与值都过策略**（键名阻断的整条丢），最多留 32 个键；
 * - number / boolean / null → 原样（**别把 limit 脱成字符串**）；
 * - 超过深度上限的容器整体折成固定标记（fail-safe）。
 */
function guardArgsValue(policy: AskTextPolicy, value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    const result = policy.redact(value)
    return result.blocked ? '' : result.text
  }
  if (typeof value !== 'object' || value === null) return value
  if (depth >= ASK_LOOP_ARGS_MAX_DEPTH) return '[嵌套过深]'
  if (Array.isArray(value)) {
    return value.slice(0, ASK_LOOP_ARGS_MAX_ITEMS).map((item) => guardArgsValue(policy, item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, ASK_LOOP_ARGS_MAX_ITEMS)) {
    const safeKey = guardArgsKey(policy, key)
    if (safeKey === null) continue
    out[safeKey] = guardArgsValue(policy, item, depth + 1)
  }
  return out
}

function guardLoopArgs(policy: AskTextPolicy, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args).slice(0, ASK_LOOP_ARGS_MAX_ITEMS)) {
    const safeKey = guardArgsKey(policy, key)
    if (safeKey === null) continue
    out[safeKey] = guardArgsValue(policy, value, 0)
  }
  return out
}

/** 工具名也是模型生成的：过策略再截断（阻断折成 unknown） */
function guardToolName(policy: AskTextPolicy, name: string): string {
  const result = policy.redact(normalizeText(name))
  return result.blocked ? 'unknown' : result.text.slice(0, 40)
}

/** tags / links：逐条过策略，阻断的单条丢弃（不连坐整段），再按条数与长度截断 */
function guardLoopNames(policy: AskTextPolicy, names: readonly string[]): string[] {
  const views: string[] = []
  for (const name of names.slice(0, ASK_TAGS_MAX)) {
    const result = policy.redact(normalizeText(name))
    if (result.blocked) continue
    views.push(result.text.slice(0, ASK_TAG_MAX_CHARS))
    if (views.length >= ASK_TAGS_MAX) break
  }
  return views
}

/** 段内网址：逐条过策略，阻断的整条丢弃 */
function guardLoopUrls(policy: AskTextPolicy, urls: readonly string[]): string[] {
  const views: string[] = []
  for (const url of urls) {
    const result = policy.redact(normalizeText(url))
    if (result.blocked) continue
    views.push(result.text.slice(0, ASK_LOOP_URL_MAX_CHARS))
    if (views.length >= ASK_LOOP_URLS_MAX) break
  }
  return views
}

/** 一条命中摘要 → 载荷视图；阻断（如 app 命中密码类词）整条不出云，返回 null */
function guardLoopHit(
  policy: AskTextPolicy,
  hit: RedactableAskLoopHit
): { segmentId: number; at: string; app: string; title: string; snippet: string; tags: string[]; links: string[]; urls: string[] } | null {
  const app = guardText(policy, hit.app, ASK_APP_MAX_CHARS)
  const title = guardText(policy, hit.title, ASK_TITLE_MAX_CHARS)
  const snippet = guardText(policy, hit.snippet, ASK_LOOP_SNIPPET_MAX_CHARS)
  if (app.blocked || title.blocked || snippet.blocked) return null
  return {
    segmentId: hit.segmentId,
    at: hit.at,
    app: app.text,
    title: title.text,
    snippet: snippet.text,
    tags: guardLoopNames(policy, hit.tags),
    links: guardLoopNames(policy, hit.links),
    urls: guardLoopUrls(policy, hit.urls)
  }
}

/** 每轮工具结果后面最多带几张截图（每张约 1024 token；给一张就够判断 OCR 糊没糊） */
const TURN_IMAGE_MAX = 2
/** 单张 data URL 的字符上限（4MB 文件 → base64 ≈ 5.3MB；留余量） */
const TURN_IMAGE_DATA_URL_MAX_CHARS = 8 * 1024 * 1024
const TURN_IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,/i

/** 截图 data URL 的协议校验：只收图片 data URL，条数与长度都钳死 */
function guardTurnImages(images: readonly string[] | undefined): string[] {
  if (!images || images.length === 0) return []
  const out: string[] = []
  for (const url of images) {
    if (typeof url !== 'string' || url.length > TURN_IMAGE_DATA_URL_MAX_CHARS) continue
    if (!TURN_IMAGE_DATA_URL_RE.test(url)) continue
    out.push(url)
    if (out.length >= TURN_IMAGE_MAX) break
  }
  return out
}

/* ------------------------------------------------------------------ */
/* <now>：系统给的处境事实（不是用户说的话）                            */
/* ------------------------------------------------------------------ */

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 'yyyy-mm-dd HH:mm' → 本地毫秒；解析不了返回 null（调用方只给字符串时的回退） */
function parseSystemTimeMs(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/u.exec(text)
  if (!match) return null
  const ts = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  ).getTime()
  return Number.isFinite(ts) ? ts : null
}

/** 毫秒 → 'yyyy-mm-dd HH:mm'（与 system 里同格式，便于模型对齐） */
function readableTime(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 毫秒 → 'HH:mm'（最近一段证据只报时刻） */
function clockTime(ts: number): string {
  const date = new Date(ts)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** token 数 → `310K` / `820`（生命行给量级就够，不报个位） */
function formatTokenAmount(value: number): string {
  const tokens = Math.max(0, Math.round(value))
  if (tokens < 1000) return String(tokens)
  return `${Math.round(tokens / 1000)}K`
}

/**
 * 本轮 `<now>` 正文。只拼已经过策略的字段（opening / recent），本地时间不是隐私；
 * 没有屏幕工具就不写数据边界 / 最近段（与 D62 的模式口径一致）。
 */
function renderNowText(
  input: ChainAskLoopBuildInput,
  opening: CloudAskOpening | undefined,
  recent: AskRecentSegment | undefined
): string {
  const ms = input.systemTimeMs ?? parseSystemTimeMs(input.systemTime)
  const lines: string[] = [
    `当前时间：${input.systemTime}${ms === null ? '' : `（毫秒时间戳 ${ms}，相对时间先按它换算）`}`
  ]
  if (opening?.facts !== undefined && opening.facts !== '') {
    lines.push(`此刻：${opening.facts}`)
  }
  // 生命（M3）：当前节点还剩多少上下文额度。让它自己知道「快想不动了」，
  // 而不是等 /compact 或冻结时才发现；数字来自最近一次请求的 usage。
  if (input.life !== undefined) {
    const limit = Math.max(1, input.life.limit)
    const remaining = Math.max(0, Math.min(limit, limit - input.life.used))
    const percent = Math.round((remaining / limit) * 100)
    lines.push(`生命：还剩 ${percent}%（${formatTokenAmount(remaining)} token）`)
  }
  if (opening?.remembered !== undefined && opening.remembered.length > 0) {
    lines.push('你想到的（只是联想，不一定对；想核对就用 recall_diary / read_diary）：')
    for (const item of opening.remembered) lines.push(`- [${item.day}] ${item.snippet}`)
  }
  const groups = input.tools ?? ASK_TOOL_NAMES
  if (hasScreenTools(groups)) {
    const latest = input.freshness.latestEvidenceTs
    lines.push(
      `数据边界：信息链最新证据到 ${latest === null ? '还没有任何数据（空库）' : `${readableTime(latest)}（毫秒时间戳 ${latest}）`}；采集${input.freshness.captureRunning ? '正在运行' : '当前没有在运行'}。`
    )
    if (recent !== undefined) {
      lines.push(
        `最近一段证据：${clockTime(recent.at)} 的〈${recent.app}〉${recent.title ? `《${recent.title}》` : ''}——只当「这个界面 / 刚才那个」的指代线索，不是证据。`
      )
    }
  }
  return lines.join('\n')
}

/**
 * 循环载荷的组装。问题与单发口径完全一致（先剥后截、阻断整次不出云）；
 * 每一轮的 toolResult 按 kind 过策略——search_info 的命中被阻断就整条剔掉
 * 并上报 `blockedSegmentIds`（诊断字段；驱动层按载荷里实际可见的命中集合收缩白名单）。
 * 工具参数（名称 / 键名 / 值树）全部过策略：模型输出不可信。
 */
export function buildAskLoopPayload(
  input: ChainAskLoopBuildInput,
  policy: AskTextPolicy
): ChainAskLoopBuildResult {
  const asked = guardText(policy, input.question, ASK_QUESTION_MAX_CHARS)
  const attachments = guardAttachments(input.attachments)
  const opening = guardOpening(policy, input.opening)

  // 历史轮：问题与答复都是上一轮的屏幕文本（再送一次要再过策略）；阻断就整轮丢掉
  const history: Array<{ question: string; answer: string }> = []
  for (const turn of (input.history ?? []).slice(-ASK_LOOP_HISTORY_MAX_TURNS)) {
    const question = policy.redact(normalizeText(turn.question))
    const answer = policy.redact(normalizeText(turn.answer))
    if (question.blocked || answer.blocked) continue
    history.push({
      question: question.text.slice(0, ASK_LOOP_QUESTION_MAX_CHARS),
      answer: answer.text.slice(0, ASK_LOOP_HISTORY_ANSWER_MAX_CHARS)
    })
  }

  // 会话回放：有会话存储就用它（已过策略，逐字节原样）；没有就用历史问答播种。
  // 注意：播种只带问答、不带工具轮——第一问没缓存可命中，之后由会话存储接管。
  // 已有 digest（更早的轮次被裁过）时不再用 history 播种，避免和摘要重复。
  const conversation: CloudAskConversationTurn[] =
    input.conversation !== undefined && input.conversation.length > 0
      ? [...input.conversation]
      : input.digest !== undefined && input.digest !== ''
        ? []
        : history.map((turn) => ({ question: turn.question, now: '', turns: [], answer: turn.answer }))

  // 最近一段证据：只当指代线索（app / 标题都过策略；命中阻断的整条不给，免得把密码类标题送出去）
  let recent: AskRecentSegment | undefined
  if (input.recent) {
    const app = guardText(policy, input.recent.app, ASK_APP_MAX_CHARS)
    const title = guardText(policy, input.recent.title, ASK_TITLE_MAX_CHARS)
    if (!app.blocked && !title.blocked) {
      recent = { app: app.text, title: title.text, at: input.recent.at }
    }
  }

  // <now>：本轮处境事实（时间 / 此刻 / 想到的 / 数据边界 / 最近段），追加在 user 之后
  const now = renderNowText(input, opening, recent)

  const turns: CloudAskLoopTurn[] = []
  const blockedSegmentIds: number[] = []
  for (const turn of input.turns) {
    const result = turn.toolResult
    /** 这一轮允许带给模型的截图；read_segment 且文本没被脱敏时才放行 */
    let images: string[] | undefined
    let view: Record<string, unknown>
    switch (result.kind) {
      case 'search_info': {
        const hits: Array<ReturnType<typeof guardLoopHit>> = []
        for (const hit of result.hits) {
          const guarded = guardLoopHit(policy, hit)
          if (guarded === null) {
            blockedSegmentIds.push(hit.segmentId)
            continue
          }
          hits.push(guarded)
        }
        view = { kind: 'search_info', freshness: result.freshness, hits, stats: result.stats }
        break
      }
      case 'ask_history': {
        const entries: Array<{ time: string; question: string; kind: string; session?: 'current' | 'other' }> = []
        for (const entry of result.entries) {
          const question = policy.redact(normalizeText(entry.question))
          if (question.blocked) continue // 单条丢，不连坐
          entries.push({
            time: entry.time, // 本地时刻由工具层生成，不含屏幕文本
            question: question.text.slice(0, ASK_LOOP_QUESTION_MAX_CHARS),
            kind: entry.kind,
            ...(entry.session !== undefined ? { session: entry.session } : {})
          })
        }
        view = { kind: 'ask_history', freshness: result.freshness, entries }
        break
      }
      case 'get_freshness': {
        view = { kind: 'get_freshness', freshness: result.freshness }
        break
      }
      case 'read_segment': {
        // 先对整段正文过策略，再切 offset/limit：避免把密钥截成半段导致漏检
        const app = guardText(policy, result.app, ASK_APP_MAX_CHARS)
        const title = guardText(policy, result.title, ASK_TITLE_MAX_CHARS)
        const text = guardText(policy, result.text, Number.MAX_SAFE_INTEGER)
        if (app.blocked || title.blocked || text.blocked) {
          view = { kind: 'error', message: '这一段包含敏感内容，不能展开' }
          break
        }
        // 截图没法脱敏：正文里命中过脱敏规则就不附图（宁可少给，不让原图绕过去）
        const redacted = app.redacted || title.redacted || text.redacted
        if (!redacted) images = guardTurnImages(turn.images)
        const full = text.text
        const offset = Math.min(full.length, Math.max(0, Math.trunc(result.offset)))
        const limit = Math.min(
          ASK_LOOP_READ_MAX_CHARS,
          Math.max(ASK_LOOP_READ_MIN_CHARS, Math.trunc(result.limit))
        )
        view = {
          kind: 'read_segment',
          freshness: result.freshness,
          segmentId: result.segmentId,
          at: result.at,
          app: app.text,
          title: title.text,
          text: full.slice(offset, offset + limit),
          urls: guardLoopUrls(policy, result.urls),
          offset,
          totalChars: full.length,
          truncated: offset + limit < full.length,
          shotCount: images?.length ?? 0
        }
        break
      }
      case 'recall_diary': {
        const hits: Array<{
          itemId: number
          day: string
          kind: string
          snippet: string
          tags: string[]
          refs: string[]
          reasons: string[]
        }> = []
        for (const hit of result.hits) {
          const snippet = guardText(policy, hit.snippet, ASK_LOOP_DIARY_SNIPPET_MAX_CHARS)
          if (snippet.blocked) continue
          hits.push({
            itemId: hit.itemId,
            day: hit.day,
            kind: hit.kind,
            snippet: snippet.text,
            tags: guardLoopNames(policy, hit.tags),
            refs: guardLoopNames(policy, hit.refs),
            reasons: guardLoopNames(policy, hit.reasons)
          })
        }
        view = { kind: 'recall_diary', freshness: result.freshness, hits, stats: result.stats }
        break
      }
      case 'read_diary': {
        const text = guardText(policy, result.text, Number.MAX_SAFE_INTEGER)
        if (text.blocked) {
          view = { kind: 'error', message: '这一天的日记包含敏感内容，不能展开' }
          break
        }
        const full = text.text
        const offset = Math.min(full.length, Math.max(0, Math.trunc(result.offset)))
        const limit = Math.min(
          ASK_LOOP_READ_MAX_CHARS,
          Math.max(ASK_LOOP_READ_MIN_CHARS, Math.trunc(result.limit))
        )
        const items: Array<{ itemId: number; section: string; text: string }> = []
        for (const item of result.items) {
          const itemText = guardText(policy, item.text, ASK_LOOP_DIARY_SNIPPET_MAX_CHARS * 3)
          if (itemText.blocked) continue
          items.push({ itemId: item.itemId, section: item.section, text: itemText.text })
        }
        view = {
          kind: 'read_diary',
          freshness: result.freshness,
          day: result.day,
          text: full.slice(offset, offset + limit),
          items,
          offset,
          totalChars: full.length,
          truncated: offset + limit < full.length
        }
        break
      }
      case 'memory_profile': {
        const observations: Array<{ topic: string; statement: string }> = []
        for (const item of result.observations) {
          const statement = guardText(policy, item.statement, ASK_LOOP_DIARY_QUOTE_MAX_CHARS * 2)
          if (statement.blocked) continue
          observations.push({ topic: item.topic, statement: statement.text })
        }
        view = { kind: 'memory_profile', freshness: result.freshness, stats: result.stats, observations }
        break
      }
      case 'conceive_daughter': {
        const nickname = policy.redact(normalizeText(result.nickname))
        const message = policy.redact(normalizeText(result.message))
        view = {
          kind: 'conceive_daughter',
          freshness: result.freshness,
          born: result.born === true,
          nickname: nickname.blocked ? '' : nickname.text.slice(0, 60),
          message: message.blocked ? '传承完成' : message.text.slice(0, 240)
        }
        break
      }
      default: {
        const message = policy.redact(normalizeText(result.message))
        view = { kind: 'error', message: message.blocked ? '工具执行失败' : message.text.slice(0, 120) }
        break
      }
    }
    turns.push({
      toolCall: {
        name: guardToolName(policy, turn.toolCall.name),
        arguments: guardLoopArgs(policy, turn.toolCall.arguments)
      },
      toolResult: view,
      ...(images && images.length > 0 ? { images } : {}),
      // 思维链是模型基于**已脱敏**的工具结果产出的，原样回传（不回传会 400）；
      // 不裁剪：DeepSeek 要求把 CoT 完整带回去。
      ...(typeof turn.reasoning === 'string' && turn.reasoning !== ''
        ? { reasoning: turn.reasoning }
        : {})
    })
  }

  return {
    payload: {
      question: asked.blocked ? '' : asked.text,
      systemTime: input.systemTime,
      freshness: input.freshness,
      turns,
      history,
      now,
      ...(conversation.length > 0 ? { conversation } : {}),
      ...(input.digest !== undefined && input.digest !== '' ? { digest: input.digest } : {}),
      ...(recent ? { recent } : {}),
      ...(opening ? { opening } : {}),
      ...(input.life !== undefined ? { life: input.life } : {}),
      ...(attachments ? { attachments } : {})
    } as unknown as ChainAskLoopPayload,
    questionBlocked: asked.blocked,
    blockedSegmentIds
  }
}

/* ------------------------------------------------------------------ */
/* 策略实现：本机直通（云端实现见 understand/cloud/ask-outbound.ts）    */
/* ------------------------------------------------------------------ */

export const passThroughAskPolicy: AskTextPolicy = {
  redact: (text) => ({ text, redacted: false, blocked: false })
}

/** `/compact` 摘要载荷：整段先过策略再截断；被挡就空文本（调用方不出云） */
function buildAskSummaryPayload(text: string, policy: AskTextPolicy): AskSummaryBuildResult {
  const redacted = policy.redact(text ?? '')
  const trimmed = redacted.text.slice(0, ASK_SUMMARY_MAX_CHARS)
  return {
    payload: { text: redacted.blocked ? '' : trimmed },
    chars: redacted.blocked ? 0 : trimmed.length,
    blocked: redacted.blocked
  }
}

/** 用指定策略组装载荷（云端 / 本机共用同一套协议实现） */
export function createAskOutbound(policy: AskTextPolicy): AskOutbound {
  return {
    buildAsk: (question, evidence, options) => buildAskPayload(question, evidence, policy, options),
    buildLoop: (input) => buildAskLoopPayload(input, policy),
    buildSummary: (text) => buildAskSummaryPayload(text, policy)
  }
}

/** 本机模型 / 测试用：不脱敏、不拦问题，只做协议组装与截断 */
export function createLocalAskOutbound(): AskOutbound {
  return createAskOutbound(passThroughAskPolicy)
}
