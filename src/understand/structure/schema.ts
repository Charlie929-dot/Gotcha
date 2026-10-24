/**
 * 归纳输出校验（M2 Phase 1；m2-plan §3 Phase 1「校验」）
 *
 * 手写校验器（不引 zod 等依赖）：
 * - 根节点只允许 `nodes` / `edges`，节点/边字段只允许契约内字段（拒绝未知字段、控制 prompt 注入面）；
 * - `nodes` 非空；`type` 只能是 knowledge / activity；
 * - 文本长度是**展示约束不是错误**：超过硬上限（标题 40 / 摘要 80 / evidence 120）确定性截断
 *   （优先在标点处切，补 `…`）并计数，不再让整批失败——模型偶尔写 26–30 字的标题是可用的
 *   语义标题，悬停与侧栏显示完整，画布只显示前 18 字；
 * - `event_ids` 必须是整数、来自本批输入，且不能跨节点重复归属；本批输入 id 必须被全部覆盖
 *   （节点可下钻；校验失败走 1 次修复重试，仍失败整批失败、游标不动）；
 * - `edges` 的 from / to 是本次 nodes 下标，不可自环，weight ∈ [0,1]。
 *
 * 错误文案只含字段名 / 下标 / id / 上限，不含事件原文（日志与修复提示都不暴露正文）。
 */

import { LLM_DEFAULTS } from '../cloud/constants'

export type NodeType = 'knowledge' | 'activity'

export interface InductionNode {
  title: string
  summary: string
  type: NodeType
  eventIds: number[]
}

export interface InductionEdge {
  from: number
  to: number
  weight: number
  evidence: string
}

export interface InductionResult {
  nodes: InductionNode[]
  edges: InductionEdge[]
}

/** 本次被截断的字段计数（长度超硬上限；不阻断落库，只记账） */
export interface InductionTruncation {
  titles: number
  summaries: number
  evidence: number
}

export type InductionValidation =
  | { ok: true; result: InductionResult; truncated: InductionTruncation }
  | { ok: false; errors: string[] }

export interface ValidateInductionOptions {
  /** 硬上限（超过即截断）；缺省用 LLM_DEFAULTS 的 *HardMaxChars */
  titleMaxChars?: number
  summaryMaxChars?: number
  evidenceMaxChars?: number
}

const ROOT_KEYS = ['nodes', 'edges']
const NODE_KEYS = ['title', 'summary', 'type', 'event_ids']
const EDGE_KEYS = ['from', 'to', 'weight', 'evidence']

/** 标点 / 空白：截断时优先切在这些字符上，避免砍断词 */
const BOUNDARY_CHARS = ['，', '。', '、', '；', '：', '！', '？', ' ', ',', '.', ';', ':', '!', '?', '·', '—', '/', '|']

/**
 * 确定性截断：结果总长 ≤ max（含省略号）。
 * 若切点足够靠后（≥ 60% 上限）优先在标点 / 空白处切，否则硬切，避免只剩一两个字符 + `…`。
 */
export function truncateWithEllipsis(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const head = text.slice(0, Math.max(1, max - 1))
  let boundary = -1
  for (const char of BOUNDARY_CHARS) boundary = Math.max(boundary, head.lastIndexOf(char))
  const minBoundary = Math.max(1, Math.floor(max * 0.6))
  const cut = boundary >= minBoundary ? boundary : head.length
  return `${head.slice(0, cut).trimEnd()}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

/** 校验 LLM 输出的归纳结果；失败返回全部（最多 10 条）错误，供修复重试提示 */
export function validateInduction(
  json: unknown,
  allowedEventIds: ReadonlySet<number>,
  options: ValidateInductionOptions = {}
): InductionValidation {
  const titleMax = options.titleMaxChars ?? LLM_DEFAULTS.nodeTitleHardMaxChars
  const summaryMax = options.summaryMaxChars ?? LLM_DEFAULTS.nodeSummaryHardMaxChars
  const evidenceMax = options.evidenceMaxChars ?? LLM_DEFAULTS.edgeEvidenceHardMaxChars
  const errors: string[] = []
  const truncated: InductionTruncation = { titles: 0, summaries: 0, evidence: 0 }
  const fail = (): InductionValidation => ({ ok: false, errors: errors.slice(0, 10) })

  if (!isRecord(json)) return { ok: false, errors: ['根节点必须是 json 对象'] }
  // 不回显未知字段名：字段名来自模型输出，拼进修复提示会变成 prompt 注入通道
  if (unknownKeys(json, ROOT_KEYS).length > 0) errors.push('根节点含契约外字段')

  if (!Array.isArray(json.nodes) || json.nodes.length === 0) {
    errors.push('nodes 必须是非空数组')
    return fail()
  }

  const nodes: InductionNode[] = []
  const usedIds = new Set<number>()

  json.nodes.forEach((raw, index) => {
    const label = `nodes[${index}]`
    if (!isRecord(raw)) {
      errors.push(`${label} 必须是对象`)
      return
    }
    if (unknownKeys(raw, NODE_KEYS).length > 0) errors.push(`${label} 含契约外字段`)

    const title = raw.title
    let safeTitle = ''
    if (!isNonEmptyString(title)) {
      errors.push(`${label}.title 必须是非空字符串`)
    } else {
      safeTitle = truncateWithEllipsis(title, titleMax)
      if (safeTitle !== title) truncated.titles += 1
    }

    const summary = raw.summary
    let safeSummary = ''
    if (!isNonEmptyString(summary)) {
      errors.push(`${label}.summary 必须是非空字符串`)
    } else {
      safeSummary = truncateWithEllipsis(summary, summaryMax)
      if (safeSummary !== summary) truncated.summaries += 1
    }

    const type = raw.type
    if (type !== 'knowledge' && type !== 'activity') errors.push(`${label}.type 只能是 knowledge / activity`)

    const eventIds: number[] = []
    if (!Array.isArray(raw.event_ids) || raw.event_ids.length === 0) {
      errors.push(`${label}.event_ids 必须是非空数组`)
    } else {
      raw.event_ids.forEach((id, idIndex) => {
        if (typeof id !== 'number' || !Number.isInteger(id)) {
          errors.push(`${label}.event_ids[${idIndex}] 必须是整数`)
          return
        }
        if (!allowedEventIds.has(id)) {
          errors.push(`${label}.event_ids[${idIndex}] 不是本批事件 id`)
          return
        }
        if (usedIds.has(id)) {
          errors.push(`${label}.event_ids[${idIndex}] 重复归属（id ${id}）`)
          return
        }
        usedIds.add(id)
        eventIds.push(id)
      })
    }

    nodes.push({ title: safeTitle, summary: safeSummary, type: type as NodeType, eventIds })
  })

  for (const id of allowedEventIds) {
    if (!usedIds.has(id)) errors.push(`事件 ${id} 未被任何节点覆盖`)
  }

  const edges: InductionEdge[] = []
  if (json.edges !== undefined) {
    if (!Array.isArray(json.edges)) {
      errors.push('edges 必须是数组')
    } else {
      json.edges.forEach((raw, index) => {
        const label = `edges[${index}]`
        if (!isRecord(raw)) {
          errors.push(`${label} 必须是对象`)
          return
        }
        if (unknownKeys(raw, EDGE_KEYS).length > 0) errors.push(`${label} 含契约外字段`)
        const { from, to, weight, evidence } = raw
        if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || from >= nodes.length) {
          errors.push(`${label}.from 必须是本次 nodes 下标`)
        }
        if (typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to >= nodes.length) {
          errors.push(`${label}.to 必须是本次 nodes 下标`)
        }
        if (from === to) errors.push(`${label} 不允许自环`)
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) {
          errors.push(`${label}.weight 必须在 0–1 之间`)
        }
        let safeEvidence = String(evidence)
        if (!isNonEmptyString(evidence)) {
          errors.push(`${label}.evidence 必须是非空字符串`)
        } else {
          safeEvidence = truncateWithEllipsis(evidence, evidenceMax)
          if (safeEvidence !== evidence) truncated.evidence += 1
        }
        edges.push({
          from: typeof from === 'number' ? from : -1,
          to: typeof to === 'number' ? to : -1,
          weight: typeof weight === 'number' ? weight : 0,
          evidence: safeEvidence
        })
      })
    }
  }

  if (errors.length > 0) return fail()
  return { ok: true, result: { nodes, edges }, truncated }
}
