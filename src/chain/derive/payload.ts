/**
 * 信息链 · 派生层的送云载荷（核心侧）
 *
 * **边界**：本模块只做协议组装 + 截断 + 品牌；哪些文本允许出云由注入的
 * `DeriveTextPolicy` 决定。云端实现见 `understand/cloud/derive-outbound.ts`，
 * 本机模型 / 测试可用 `createLocalDeriveOutbound()` 直通。
 *
 * 与问记忆（`chain/agent/payload.ts`）同一模式：核心不 import 脱敏实现。
 */

/** 双链合并提问里的一对名字（`kind` 只用来提示模型，不参与判定） */
export type ChainPairKind = 'link' | 'tag'

export interface DeriveTextRedaction {
  text: string
  redacted: boolean
  blocked: boolean
}

export interface DeriveTextPolicy {
  redact(text: string): DeriveTextRedaction
}

/** 一段正文的送云视图 */
export interface CloudChainSegment {
  readonly segmentId: number
  readonly app: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
}

declare const chainExtractBrand: unique symbol

/** 抽取载荷（只能由载荷组装产出） */
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

/** 模糊带合并载荷（只能由载荷组装产出） */
export interface ChainMergePayload {
  readonly pairs: readonly CloudChainPair[]
  readonly [chainMergeBrand]: true
}

export interface ChainMergeBuildResult {
  payload: ChainMergePayload
  /** 被敏感规则挡下、不能发出去的对（下标是输入数组的下标） */
  blocked: number[]
}

/** 派生层载荷组装端口 */
export interface DeriveOutbound {
  buildExtract(
    segments: readonly RedactableChainSegment[],
    options?: ChainBuildOptions
  ): ChainExtractBuildResult
  buildMerge(pairs: readonly RedactableChainPair[]): ChainMergeBuildResult
}

const DERIVE_TEXT_MAX_CHARS = 6_000
const DERIVE_APP_MAX_CHARS = 80
const DERIVE_TITLE_MAX_CHARS = 120
const DERIVE_PAIR_MAX_CHARS = 40

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/** 先过策略（剥离）再截断：避免半截密钥漏检 */
function guardText(
  policy: DeriveTextPolicy,
  text: string | null | undefined,
  maxChars: number
): DeriveTextRedaction {
  const result = policy.redact(normalizeText(text))
  return {
    text: result.text.slice(0, maxChars),
    redacted: result.redacted,
    blocked: result.blocked
  }
}

export function buildExtractPayload(
  segments: readonly RedactableChainSegment[],
  policy: DeriveTextPolicy,
  options: ChainBuildOptions = {}
): ChainExtractBuildResult {
  const limits = {
    textMaxChars: options.textMaxChars ?? DERIVE_TEXT_MAX_CHARS,
    appMaxChars: options.appMaxChars ?? DERIVE_APP_MAX_CHARS,
    titleMaxChars: options.titleMaxChars ?? DERIVE_TITLE_MAX_CHARS
  }
  const payloadSegments: CloudChainSegment[] = []
  const blockedSegmentIds: number[] = []
  const redactedSegmentIds: number[] = []

  for (const segment of segments) {
    const app = guardText(policy, segment.app, limits.appMaxChars)
    const title = guardText(policy, segment.title, limits.titleMaxChars)
    const text = guardText(policy, segment.text, limits.textMaxChars)
    if (app.blocked || title.blocked || text.blocked) {
      blockedSegmentIds.push(segment.segmentId)
      continue
    }
    if (app.redacted || title.redacted || text.redacted) redactedSegmentIds.push(segment.segmentId)
    payloadSegments.push({
      segmentId: segment.segmentId,
      app: app.text,
      title: title.text,
      text: text.text,
      truncated: segment.truncated ?? false
    })
  }

  return {
    payload: { segments: payloadSegments } as unknown as ChainExtractPayload,
    blockedSegmentIds,
    redactedSegmentIds
  }
}

export function buildMergePayload(
  pairs: readonly RedactableChainPair[],
  policy: DeriveTextPolicy
): ChainMergeBuildResult {
  const views: CloudChainPair[] = []
  const blocked: number[] = []
  pairs.forEach((pair, index) => {
    const candidate = guardText(policy, pair.candidate, DERIVE_PAIR_MAX_CHARS)
    const existing = guardText(policy, pair.existing, DERIVE_PAIR_MAX_CHARS)
    if (candidate.blocked || existing.blocked) {
      blocked.push(index)
      return
    }
    views.push({
      index,
      candidate: candidate.text,
      existing: existing.text,
      kind: pair.kind
    })
  })
  return {
    payload: { pairs: views } as unknown as ChainMergePayload,
    blocked
  }
}

export const passThroughDerivePolicy: DeriveTextPolicy = {
  redact: (text) => ({ text, redacted: false, blocked: false })
}

export function createDeriveOutbound(policy: DeriveTextPolicy): DeriveOutbound {
  return {
    buildExtract: (segments, options) => buildExtractPayload(segments, policy, options),
    buildMerge: (pairs) => buildMergePayload(pairs, policy)
  }
}

/** 本机模型 / 测试用：不脱敏、不阻断，只做协议组装与截断 */
export function createLocalDeriveOutbound(): DeriveOutbound {
  return createDeriveOutbound(passThroughDerivePolicy)
}
