/**
 * 出云唯一出口（M2 / D19；security.md「三层脱敏墙」）
 *
 * - 只输出必要字段：id / ts 区间 / app / 截断后的标题与 OCR 摘要 / event_ids，
 *   且三个文本字段全部过同一脱敏函数；
 * - `sensitive=1` 事件：命中片段替换为 `[已脱敏]` 后二次扫描；
 *   仍命中（含密码类规则）→ 整条（整「时刻」）不出云（excludedIds，由归纳层生成本地占位节点）；
 * - `CloudPayload` 带 nominal brand：LLM 客户端只接受本模块产出的载荷，
 *   业务代码无法直接拼 messages 绕过脱敏（审查发现「唯一出口可绕过」）。
 */

import { redactSensitive } from '../sanitize'
import { LLM_DEFAULTS } from './constants'

export interface RedactableEvent {
  id: number
  ts: number
  app: string
  windowTitle?: string | null
  ocrText?: string | null
  sensitive?: number
}

/** 取批产出的「时刻」（Phase 1）：多个事件合并后作为一个出云条目 */
export interface RedactableMoment {
  app: string
  title: string
  startTs: number
  endTs: number
  ocr: string
  eventIds: readonly number[]
  sensitive?: boolean
}

export interface CloudEvent {
  /** 代表事件 id（时刻内第一条），用于稳定排序 / 剪枝 */
  readonly id: number
  /** 时刻起始 ts（毫秒） */
  readonly ts: number
  /** 时刻结束 ts（毫秒）；单事件时等于 ts */
  readonly tsEnd: number
  readonly app: string
  readonly title: string
  readonly ocr: string
  /** 时刻覆盖的事件 id（LLM 输出的 event_ids 必须来自这里） */
  readonly eventIds: readonly number[]
}

declare const cloudPayloadBrand: unique symbol

/** 只能由 `buildCloudPayload()` / `buildCloudMomentPayload()` 产生；brand 只存在于类型层，不参与序列化 */
export interface CloudPayload {
  readonly events: readonly CloudEvent[]
  readonly [cloudPayloadBrand]: true
}

export interface CloudBuildResult {
  payload: CloudPayload
  /** 经过剥离（有片段被替换）的事件 id */
  redactedIds: number[]
  /** 无法安全剥离、整条不出云的事件 id（本地占位） */
  excludedIds: number[]
}

/* ------------------------------------------------------------------ *
 * P2 在线化 S4：LLM 只剩两件事（新主题命名 / 模糊归属确认）
 *
 * 这两类载荷同样只能由本模块产出（brand 在类型层，业务代码拼不出 messages）：
 * - 命名：一个「新主题」的代表时刻（已脱敏）；
 * - 确认：模糊时刻 + 它的候选主题（只给候选主题的标题 / 摘要，不给向量）。
 * 命中敏感规则且无法剥离的条目一律不出发（时刻留到下一轮 / 本地兜底），
 * 不在这里重写正文、也不回显原文。
 * ------------------------------------------------------------------ */

/** 命名载荷里的一个「时刻」（字段与 `CloudEvent` 同形，避免多一套形状） */
export interface NamingMoment {
  readonly eventIds: readonly number[]
  readonly ts: number
  readonly tsEnd: number
  readonly app: string
  readonly title: string
  readonly ocr: string
}

declare const themeNamingBrand: unique symbol

/** 新主题命名载荷（只能由 `buildThemeNamingPayload()` 产生） */
export interface ThemeNamingPayload {
  readonly moments: readonly NamingMoment[]
  readonly [themeNamingBrand]: true
}

export interface NamingBuildResult {
  payload: ThemeNamingPayload
  /** 经过剥离（有片段被替换）的事件 id */
  redactedIds: number[]
  /** 无法安全剥离、整条不出云的事件 id（调用方用本地标题兜底） */
  blockedIds: number[]
}

/** 模糊确认载荷里的一条时刻（只带候选主题 id，模型不能自由挑） */
export interface AssignmentMoment {
  readonly momentId: number
  readonly app: string
  readonly title: string
  readonly ocr: string
  readonly candidateThemeIds: readonly number[]
}

/** 模糊确认载荷里的一个候选主题（标题 / 摘要已脱敏） */
export interface AssignmentTheme {
  readonly themeId: number
  readonly title: string
  readonly summary: string
}

declare const themeAssignmentBrand: unique symbol

/** 模糊归属确认载荷（只能由 `buildThemeAssignmentPayload()` 产生） */
export interface ThemeAssignmentPayload {
  readonly moments: readonly AssignmentMoment[]
  readonly themes: readonly AssignmentTheme[]
  readonly [themeAssignmentBrand]: true
}

/** 确认载荷的输入：时刻 + 本地算出的候选主题（§5.2 top-k） */
export interface RedactableAssignmentMoment {
  momentId: number
  app: string
  title: string
  ocr: string
  /** 本地 embedding 选出的候选主题 id（按相似度降序） */
  candidateThemeIds: readonly number[]
}

export interface RedactableTheme {
  id: number
  title: string
  summary: string
}

export interface AssignmentBuildResult {
  payload: ThemeAssignmentPayload
  /** 命中敏感规则、整条不出云的时刻（留到下一轮，不归属） */
  blockedMomentIds: number[]
  /** 命中敏感规则、不作为候选主题的主题 id */
  blockedThemeIds: number[]
  /** 候选主题全被剔掉（或本来就没候选）的时刻，无法确认 */
  noCandidateMomentIds: number[]
}

export interface BuildCloudPayloadOptions {
  appMaxChars?: number
  titleMaxChars?: number
  ocrMaxChars?: number
}

function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

interface RedactedTexts {
  app: string
  title: string
  ocr: string
  redacted: boolean
  blocked: boolean
}

/**
 * 三个文本字段走同一脱敏函数；先剥离再截断（避免半截密钥漏检）。
 * app 也走脱敏（审查：app 曾漏脱敏；命中密码类词如 1Password.exe 会整条不出云，按 D19 属预期）。
 */
function redactEventTexts(
  raw: { app: string | null | undefined; title: string | null | undefined; ocr: string | null | undefined },
  limits: { appMaxChars: number; titleMaxChars: number; ocrMaxChars: number }
): RedactedTexts {
  const app = redactSensitive(normalize(raw.app))
  const title = redactSensitive(normalize(raw.title))
  const ocr = redactSensitive(normalize(raw.ocr))
  return {
    app: truncate(app.text, limits.appMaxChars),
    title: truncate(title.text, limits.titleMaxChars),
    ocr: truncate(ocr.text, limits.ocrMaxChars),
    redacted: app.redacted || title.redacted || ocr.redacted,
    blocked: app.blocked || title.blocked || ocr.blocked
  }
}

/** 原始事件 → 出云条目（兼容 Phase 0 路径：一事件一条目） */
export function buildCloudPayload(
  events: readonly RedactableEvent[],
  options: BuildCloudPayloadOptions = {}
): CloudBuildResult {
  const limits = {
    appMaxChars: options.appMaxChars ?? LLM_DEFAULTS.appMaxChars,
    titleMaxChars: options.titleMaxChars ?? LLM_DEFAULTS.titleMaxChars,
    ocrMaxChars: options.ocrMaxChars ?? LLM_DEFAULTS.ocrMaxChars
  }
  const payloadEvents: CloudEvent[] = []
  const redactedIds: number[] = []
  const excludedIds: number[] = []

  for (const event of events) {
    const texts = redactEventTexts(
      { app: event.app, title: event.windowTitle, ocr: event.ocrText },
      limits
    )
    if (texts.blocked) {
      excludedIds.push(event.id)
      continue
    }
    if (texts.redacted) redactedIds.push(event.id)
    payloadEvents.push({
      id: event.id,
      ts: event.ts,
      tsEnd: event.ts,
      app: texts.app,
      title: texts.title,
      ocr: texts.ocr,
      eventIds: [event.id]
    })
  }

  return { payload: { events: payloadEvents } as unknown as CloudPayload, redactedIds, excludedIds }
}

/** 取批时刻 → 出云条目（Phase 1 主路径）；被整条排除时把其 eventIds 全部记入 excludedIds */
export function buildCloudMomentPayload(
  moments: readonly RedactableMoment[],
  options: BuildCloudPayloadOptions = {}
): CloudBuildResult {
  const limits = {
    appMaxChars: options.appMaxChars ?? LLM_DEFAULTS.appMaxChars,
    titleMaxChars: options.titleMaxChars ?? LLM_DEFAULTS.titleMaxChars,
    ocrMaxChars: options.ocrMaxChars ?? LLM_DEFAULTS.ocrMaxChars
  }
  const payloadEvents: CloudEvent[] = []
  const redactedIds: number[] = []
  const excludedIds: number[] = []

  for (const moment of moments) {
    const texts = redactEventTexts({ app: moment.app, title: moment.title, ocr: moment.ocr }, limits)
    if (texts.blocked) {
      excludedIds.push(...moment.eventIds)
      continue
    }
    if (texts.redacted) redactedIds.push(...moment.eventIds)
    if (moment.eventIds.length === 0) continue
    payloadEvents.push({
      id: moment.eventIds[0],
      ts: moment.startTs,
      tsEnd: moment.endTs,
      app: texts.app,
      title: texts.title,
      ocr: texts.ocr,
      eventIds: [...moment.eventIds]
    })
  }

  return { payload: { events: payloadEvents } as unknown as CloudPayload, redactedIds, excludedIds }
}

/**
 * 新主题命名载荷（S4）：只带代表时刻的脱敏文本。
 * 敏感命中且无法剥离的时刻整条剔掉——命名宁可少一段上下文，也不能把原文发出去；
 * 剔空的载荷由调用方用本地标题兜底（`theme-naming.ts`）。
 */
export function buildThemeNamingPayload(
  moments: readonly RedactableMoment[],
  options: BuildCloudPayloadOptions = {}
): NamingBuildResult {
  const limits = {
    appMaxChars: options.appMaxChars ?? LLM_DEFAULTS.appMaxChars,
    titleMaxChars: options.titleMaxChars ?? LLM_DEFAULTS.titleMaxChars,
    ocrMaxChars: options.ocrMaxChars ?? LLM_DEFAULTS.ocrMaxChars
  }
  const payloadMoments: NamingMoment[] = []
  const redactedIds: number[] = []
  const blockedIds: number[] = []

  for (const moment of moments) {
    const texts = redactEventTexts({ app: moment.app, title: moment.title, ocr: moment.ocr }, limits)
    if (texts.blocked) {
      blockedIds.push(...moment.eventIds)
      continue
    }
    if (texts.redacted) redactedIds.push(...moment.eventIds)
    if (moment.eventIds.length === 0) continue
    payloadMoments.push({
      eventIds: [...moment.eventIds],
      ts: moment.startTs,
      tsEnd: moment.endTs,
      app: texts.app,
      title: texts.title,
      ocr: texts.ocr
    })
  }

  return {
    payload: { moments: payloadMoments } as unknown as ThemeNamingPayload,
    redactedIds,
    blockedIds
  }
}

/**
 * 模糊归属确认载荷（S4）：时刻 + 候选主题（标题 / 摘要脱敏）。
 * 候选主题被剔掉后没有候选的时刻无法确认——单独列出来，调用方留到下一轮。
 */
export function buildThemeAssignmentPayload(
  moments: readonly RedactableAssignmentMoment[],
  themes: readonly RedactableTheme[],
  options: BuildCloudPayloadOptions = {}
): AssignmentBuildResult {
  const limits = {
    appMaxChars: options.appMaxChars ?? LLM_DEFAULTS.appMaxChars,
    titleMaxChars: options.titleMaxChars ?? LLM_DEFAULTS.titleMaxChars,
    ocrMaxChars: options.ocrMaxChars ?? LLM_DEFAULTS.ocrMaxChars
  }
  const themeViews: AssignmentTheme[] = []
  const blockedThemeIds: number[] = []
  const allowedThemeIds = new Set<number>()

  for (const theme of themes) {
    const texts = redactEventTexts({ app: '', title: theme.title, ocr: theme.summary }, limits)
    if (texts.blocked) {
      blockedThemeIds.push(theme.id)
      continue
    }
    themeViews.push({ themeId: theme.id, title: texts.title, summary: texts.ocr })
    allowedThemeIds.add(theme.id)
  }

  const momentViews: AssignmentMoment[] = []
  const blockedMomentIds: number[] = []
  const noCandidateMomentIds: number[] = []

  for (const moment of moments) {
    const texts = redactEventTexts({ app: moment.app, title: moment.title, ocr: moment.ocr }, limits)
    if (texts.blocked) {
      blockedMomentIds.push(moment.momentId)
      continue
    }
    const candidates = [...new Set(moment.candidateThemeIds)].filter((id) => allowedThemeIds.has(id))
    if (candidates.length === 0) {
      noCandidateMomentIds.push(moment.momentId)
      continue
    }
    momentViews.push({
      momentId: moment.momentId,
      app: texts.app,
      title: texts.title,
      ocr: texts.ocr,
      candidateThemeIds: candidates
    })
  }

  return {
    payload: { moments: momentViews, themes: themeViews } as unknown as ThemeAssignmentPayload,
    blockedMomentIds,
    blockedThemeIds,
    noCandidateMomentIds
  }
}

/* ------------------------------------------------------------------ *
 * 信息链派生层（v0.8 / D45）：段正文 → 抽标签 / 双链
 *
 * 与上面三条载荷同一纪律：文本一律过 `redactSensitive`，命中密码类规则整段剔掉
 * （`blockedSegmentIds` / `blocked`），有片段被替换就记 `redacted*` 并在日志里计数。
 * 段正文由 `src/chain/derive/text.ts` 先去重 / 截断——这里再做一次上限兜底，
 * 防止调用方忘了传上限把整篇 2 万字送出去。
 * ------------------------------------------------------------------ */

/** 双链合并提问里的一对名字（`kind` 只用来提示模型，不参与判定） */
export type ChainPairKind = 'link' | 'tag'

/** 一段正文的送云视图 */
export interface CloudChainSegment {
  readonly segmentId: number
  readonly app: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
}

declare const chainExtractBrand: unique symbol

/** 抽取载荷（只能由 `buildChainExtractPayload()` 产生） */
export interface ChainExtractPayload {
  readonly segments: readonly CloudChainSegment[]
  readonly [chainExtractBrand]: true
}

export interface RedactableChainSegment {
  segmentId: number
  app: string
  title: string
  /** 已去重 / 已截断的正文（链上 `buildDeriveText()` 的产物） */
  text: string
  /** 是否已在上游按上限截断（告诉模型「这不是全文」） */
  truncated?: boolean
}

export interface ChainExtractBuildResult {
  payload: ChainExtractPayload
  /** 脱敏后仍命中敏感规则、整段不出云的段 id */
  blockedSegmentIds: number[]
  /** 有片段被替换为 `[已脱敏]` 的段 id */
  redactedSegmentIds: number[]
}

export interface ChainBuildOptions {
  /** 正文兜底上限（字符）；默认 6000，与 `chain/derive/text.ts` 的上限一致 */
  textMaxChars?: number
  appMaxChars?: number
  titleMaxChars?: number
}

export function buildChainExtractPayload(
  segments: readonly RedactableChainSegment[],
  options: ChainBuildOptions = {}
): ChainExtractBuildResult {
  const limits = {
    textMaxChars: options.textMaxChars ?? 6_000,
    appMaxChars: options.appMaxChars ?? LLM_DEFAULTS.appMaxChars,
    titleMaxChars: options.titleMaxChars ?? LLM_DEFAULTS.titleMaxChars
  }
  const payloadSegments: CloudChainSegment[] = []
  const blockedSegmentIds: number[] = []
  const redactedSegmentIds: number[] = []

  for (const segment of segments) {
    const texts = redactEventTexts(
      { app: segment.app, title: segment.title, ocr: segment.text },
      {
        appMaxChars: limits.appMaxChars,
        titleMaxChars: limits.titleMaxChars,
        ocrMaxChars: limits.textMaxChars
      }
    )
    if (texts.blocked) {
      blockedSegmentIds.push(segment.segmentId)
      continue
    }
    if (texts.redacted) redactedSegmentIds.push(segment.segmentId)
    payloadSegments.push({
      segmentId: segment.segmentId,
      app: texts.app,
      title: texts.title,
      text: texts.ocr,
      truncated: segment.truncated ?? false
    })
  }

  return {
    payload: { segments: payloadSegments } as unknown as ChainExtractPayload,
    blockedSegmentIds,
    redactedSegmentIds
  }
}

/** 合并提问的一对名字（`index` 指回调用方的候选下标，便于把答复对回原候选） */
export interface CloudChainPair {
  readonly index: number
  readonly candidate: string
  readonly existing: string
  readonly kind: ChainPairKind
}

export interface RedactableChainPair {
  candidate: string
  existing: string
  kind: ChainPairKind
}

declare const chainMergeBrand: unique symbol

/** 模糊带合并载荷（只能由 `buildChainMergePayload()` 产生） */
export interface ChainMergePayload {
  readonly pairs: readonly CloudChainPair[]
  readonly [chainMergeBrand]: true
}

export interface ChainMergeBuildResult {
  payload: ChainMergePayload
  /** 被敏感规则挡下、不能发出去的对（下标是输入数组的下标） */
  blocked: number[]
}

export function buildChainMergePayload(
  pairs: readonly RedactableChainPair[]
): ChainMergeBuildResult {
  const views: CloudChainPair[] = []
  const blocked: number[] = []
  pairs.forEach((pair, index) => {
    const candidate = redactSensitive(normalize(pair.candidate))
    const existing = redactSensitive(normalize(pair.existing))
    if (candidate.blocked || existing.blocked) {
      blocked.push(index)
      return
    }
    views.push({
      index,
      candidate: candidate.text.slice(0, 40),
      existing: existing.text.slice(0, 40),
      kind: pair.kind
    })
  })
  return {
    payload: { pairs: views } as unknown as ChainMergePayload,
    blocked
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

/** 问记忆载荷（只能由 `buildChainAskPayload()` 产生） */
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

export interface ChainAskBuildOptions extends ChainBuildOptions {
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

const ASK_TAG_MAX_CHARS = 40
const ASK_TAGS_MAX = 8

/**
 * 问记忆的送云载荷：问题 + 命中的段（都过同一套脱敏）。
 * 问题被挡就整次不出云——宁可答「没找到」，也不把敏感问题发出去。
 */
export function buildChainAskPayload(
  question: string,
  evidence: readonly RedactableChainAskEvidence[],
  options: ChainAskBuildOptions = {}
): ChainAskBuildResult {
  const limits = {
    textMaxChars: options.textMaxChars ?? 500,
    appMaxChars: options.appMaxChars ?? LLM_DEFAULTS.appMaxChars,
    titleMaxChars: options.titleMaxChars ?? LLM_DEFAULTS.titleMaxChars,
    questionMaxChars: options.questionMaxChars ?? 500
  }

  const asked = redactEventTexts(
    { app: '', title: '', ocr: question },
    { appMaxChars: 0, titleMaxChars: 0, ocrMaxChars: limits.questionMaxChars }
  )
  const views: CloudChainAskEvidence[] = []
  const blockedSegmentIds: number[] = []
  const redactedSegmentIds: number[] = []

  for (const segment of evidence) {
    const texts = redactEventTexts(
      { app: segment.app, title: segment.title, ocr: segment.text },
      {
        appMaxChars: limits.appMaxChars,
        titleMaxChars: limits.titleMaxChars,
        ocrMaxChars: limits.textMaxChars
      }
    )
    if (texts.blocked) {
      blockedSegmentIds.push(segment.segmentId)
      continue
    }
    if (texts.redacted) redactedSegmentIds.push(segment.segmentId)
    views.push({
      segmentId: segment.segmentId,
      app: texts.app,
      title: texts.title,
      startTs: segment.startTs,
      endTs: segment.endTs,
      text: texts.ocr,
      truncated: segment.truncated ?? false,
      tags: (segment.tags ?? []).slice(0, ASK_TAGS_MAX).map((tag) => tag.slice(0, ASK_TAG_MAX_CHARS)),
      links: (segment.links ?? []).slice(0, ASK_TAGS_MAX).map((link) => link.slice(0, ASK_TAG_MAX_CHARS))
    })
  }

  return {
    payload: {
      question: asked.blocked ? '' : asked.ocr,
      evidence: views
    } as unknown as ChainAskPayload,
    questionBlocked: asked.blocked,
    blockedSegmentIds,
    redactedSegmentIds
  }
}

