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
