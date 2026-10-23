/**
 * 出云唯一出口（M2 / D19；security.md「三层脱敏墙」）
 *
 * - 只输出必要字段：id / ts / app / 截断后的标题与 OCR 摘要；
 * - `sensitive=1` 事件：命中片段替换为 `[已脱敏]` 后二次扫描；
 *   仍命中（含密码类规则）→ 整条不出云（excludedIds，由归纳层生成本地占位节点）；
 * - 所有文本都过同一脱敏函数，业务代码不得绕过本模块直接请求 LLM。
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

export interface CloudEvent {
  id: number
  ts: number
  app: string
  title: string
  ocr: string
}

export interface CloudPayload {
  events: CloudEvent[]
}

export interface CloudBuildResult {
  payload: CloudPayload
  /** 经过剥离（有片段被替换）的事件 id */
  redactedIds: number[]
  /** 无法安全剥离、整条不出云的事件 id（本地占位） */
  excludedIds: number[]
}

export interface BuildCloudPayloadOptions {
  titleMaxChars?: number
  ocrMaxChars?: number
}

function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

export function buildCloudPayload(
  events: readonly RedactableEvent[],
  options: BuildCloudPayloadOptions = {}
): CloudBuildResult {
  const titleMaxChars = options.titleMaxChars ?? LLM_DEFAULTS.titleMaxChars
  const ocrMaxChars = options.ocrMaxChars ?? LLM_DEFAULTS.ocrMaxChars
  const payloadEvents: CloudEvent[] = []
  const redactedIds: number[] = []
  const excludedIds: number[] = []

  for (const event of events) {
    // 先剥离再截断：避免敏感串被截断后漏检、把半截密钥发出去
    const title = redactSensitive(normalize(event.windowTitle))
    const ocr = redactSensitive(normalize(event.ocrText))
    if (title.blocked || ocr.blocked) {
      excludedIds.push(event.id)
      continue
    }
    if (title.redacted || ocr.redacted) redactedIds.push(event.id)
    payloadEvents.push({
      id: event.id,
      ts: event.ts,
      app: event.app,
      title: truncate(title.text, titleMaxChars),
      ocr: truncate(ocr.text, ocrMaxChars)
    })
  }

  return { payload: { events: payloadEvents }, redactedIds, excludedIds }
}
