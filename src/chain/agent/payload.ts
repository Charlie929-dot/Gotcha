/**
 * 信息链 · 问记忆的送云载荷（核心侧）
 *
 * **边界**：本模块只做「协议组装 + 截断 + 品牌」——问题、证据、工具结果怎么排成
 * 一份载荷是核心功能；哪些文本不许出云是安全策略，由调用方注入 `AskTextPolicy`。
 * 云端实现见 `understand/cloud/ask-outbound.ts`（`createCloudAskOutbound()`），
 * 本机模型 / 测试可用 `createLocalAskOutbound()` 直通。
 *
 * 这样核心功能（检索、工具循环、问答）不 import `understand/cloud/redact`，
 * 安全规则坏掉 / 还没配好时不会把「问记忆」整条链路卡死；只有真正要出网时，
 * 组合根（`main/index.ts`）才把云端策略接进来。
 */

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
}

/** 续问时带上的一轮对话（问题 + 最终答复 / 澄清问题） */
export interface RedactableAskLoopConversationTurn {
  question: string
  answer: string
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
      text: string
      urls: readonly string[]
      offset: number
      limit: number
    }
  /** 执行器兜底：参数不合法 / 未知工具 / 执行抛错（message 是固定文案或已过策略的工具名） */
  | { kind: 'error'; message: string }

/** 循环里的一次往返：模型发起的调用 + 执行器给出的摘要 */
export interface RedactableAskLoopTurn {
  toolCall: { name: string; arguments: Record<string, unknown> }
  toolResult: RedactableAskLoopToolResult
}

/** 策略处理后的工具调用（arguments 里的字符串叶子已过策略） */
export interface CloudAskLoopTurn {
  readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> }
  readonly toolResult: Record<string, unknown>
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
  readonly [chainAskLoopBrand]: true
}

export interface ChainAskLoopBuildInput {
  question: string
  systemTime: string
  freshness: AskLoopFreshness
  turns: readonly RedactableAskLoopTurn[]
  /** 同一会话之前的几轮（新对话不传） */
  history?: readonly RedactableAskLoopConversationTurn[]
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

/** 出云载荷组装端口：核心只依赖这个接口，不依赖任何具体安全实现 */
export interface AskOutbound {
  buildAsk(
    question: string,
    evidence: readonly RedactableChainAskEvidence[],
    options?: AskBuildOptions
  ): ChainAskBuildResult
  buildLoop(input: ChainAskLoopBuildInput): ChainAskLoopBuildResult
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
      evidence: views
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

  const turns: CloudAskLoopTurn[] = []
  const blockedSegmentIds: number[] = []
  for (const turn of input.turns) {
    const result = turn.toolResult
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
        const entries: Array<{ time: string; question: string; kind: string }> = []
        for (const entry of result.entries) {
          const question = policy.redact(normalizeText(entry.question))
          if (question.blocked) continue // 单条丢，不连坐
          entries.push({
            time: entry.time, // 本地时刻由工具层生成，不含屏幕文本
            question: question.text.slice(0, ASK_LOOP_QUESTION_MAX_CHARS),
            kind: entry.kind
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
          truncated: offset + limit < full.length
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
      toolResult: view
    })
  }

  return {
    payload: {
      question: asked.blocked ? '' : asked.text,
      systemTime: input.systemTime,
      freshness: input.freshness,
      turns,
      history
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

/** 用指定策略组装载荷（云端 / 本机共用同一套协议实现） */
export function createAskOutbound(policy: AskTextPolicy): AskOutbound {
  return {
    buildAsk: (question, evidence, options) => buildAskPayload(question, evidence, policy, options),
    buildLoop: (input) => buildAskLoopPayload(input, policy)
  }
}

/** 本机模型 / 测试用：不脱敏、不拦问题，只做协议组装与截断 */
export function createLocalAskOutbound(): AskOutbound {
  return createAskOutbound(passThroughAskPolicy)
}
