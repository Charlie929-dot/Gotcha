/**
 * 新主题命名（P2 在线化 S4；docs/m2-graph-redesign.md §9.1 第 3 段 / §9.3）
 *
 * 在线路径里 LLM 只剩两件事：给新主题命名、确认模糊归属（`theme-confirm.ts`）。
 * 本模块只管命名：
 * - 输入是一个主题的代表时刻（已脱敏，走 `buildThemeNamingPayload()` 唯一出口）；
 * - 输出 `{ title ≤24（建议）, summary ≤80, type }`，由 `validateThemeName()` 手写校验；
 * - **失败不阻塞**：没配置客户端 / 载荷被敏感规则剔空 / 输出非法 / 请求失败，都退到
 *   本地兜底标题（代表时刻的窗口标题），主题照样能建——命名是展示层，不该让归属卡住；
 * - 不做修复重试：失败代价只是「标题不好看」，多调一次既贵又不可靠（temperature=0 的教训）；
 * - 取消（暂停 / 退出）必须外抛 `LlmAbortError`，由调用方按 D18 丢弃结果。
 *
 * 错误文案只含字段名与长度上限，不含事件原文。
 */

import { LLM_DEFAULTS } from './cloud/constants'
import { LlmAbortError, type LlmClient, type LlmUsage } from './cloud/llm-client'
import { buildThemeNamingPayload, type RedactableMoment } from './cloud/redact'
import { truncateWithEllipsis, type NodeType } from './structure/schema'

export interface ThemeName {
  title: string
  summary: string
  type: NodeType
}

/** 命名结果来源：`llm` 模型给的；`fallback` 本地兜底（原因见 `reason`） */
export type ThemeNamingSource = 'llm' | 'fallback'

export type ThemeNamingFallbackReason =
  | 'no-client'
  | 'no-context'
  | 'invalid-output'
  | 'llm-error'

export interface ThemeNamingOutcome {
  name: ThemeName
  source: ThemeNamingSource
  /** 仅 `source='fallback'` 时给出，供日志 / 状态行说明原因（不进节点正文） */
  reason?: ThemeNamingFallbackReason
  usage?: LlmUsage
  /** 因敏感规则没出云的事件 id（调用方只需计数 / 日志，不含正文） */
  blockedEventIds: number[]
}

export type ThemeNameValidation =
  | { ok: true; name: ThemeName }
  | { ok: false; errors: string[] }

export interface ThemeNameLimits {
  /** 存库硬上限（缺省 40 / 80；24 是 prompt 建议值，与归纳节点同一口径） */
  titleMaxChars?: number
  summaryMaxChars?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 校验命名输出。
 * 与批量归纳不同：**未知字段忽略而不判死**——命名失败的代价是兜底标题（质量下降），
 * 为模型多写一个无害字段丢掉一次成功的命名不划算；真正判死的是缺字段 / 长度以外的类型错误。
 */
export function validateThemeName(json: unknown, limits: ThemeNameLimits = {}): ThemeNameValidation {
  const titleMax = limits.titleMaxChars ?? LLM_DEFAULTS.nodeTitleHardMaxChars
  const summaryMax = limits.summaryMaxChars ?? LLM_DEFAULTS.nodeSummaryHardMaxChars
  const errors: string[] = []

  if (!isRecord(json)) return { ok: false, errors: ['根节点必须是 json 对象'] }

  let title = ''
  if (!isNonEmptyString(json.title)) {
    errors.push('title 必须是非空字符串')
  } else {
    title = truncateWithEllipsis(json.title, titleMax)
  }

  let summary = ''
  if (!isNonEmptyString(json.summary)) {
    errors.push('summary 必须是非空字符串')
  } else {
    summary = truncateWithEllipsis(json.summary, summaryMax)
  }

  const type = json.type
  if (type !== 'knowledge' && type !== 'activity') errors.push('type 只能是 knowledge / activity')

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, name: { title, summary, type: type as NodeType } }
}

/**
 * 本地兜底命名：代表时刻的窗口标题 → app → 固定文案。
 * 只读本地字段，不再出云；摘要明说「本地兜底」，避免把兜底结果伪装成模型命名。
 */
export function fallbackThemeName(moments: readonly RedactableMoment[]): ThemeName {
  const first = moments[0]
  const rawTitle = (first?.title ?? '').trim()
  const app = (first?.app ?? '').trim()
  const title = rawTitle !== '' ? rawTitle : app !== '' ? app : '未命名主题'
  const summary = `${app !== '' ? app : '未知应用'} · ${moments.length} 个时刻（本地兜底命名）`
  return {
    title: truncateWithEllipsis(title, LLM_DEFAULTS.nodeTitleHardMaxChars),
    summary: truncateWithEllipsis(summary, LLM_DEFAULTS.nodeSummaryHardMaxChars),
    type: 'activity'
  }
}

export interface NameThemeOptions extends ThemeNameLimits {
  signal?: AbortSignal
  maxTokens?: number
}

/**
 * 命名一个主题；永不因模型 / 网络 / 校验失败抛错（取消除外）。
 * `client` 传 null = 未配置密钥或未确认出网（D24 门），直接兜底、零请求。
 */
export async function nameTheme(
  client: LlmClient | null,
  moments: readonly RedactableMoment[],
  options: NameThemeOptions = {}
): Promise<ThemeNamingOutcome> {
  const built = buildThemeNamingPayload(moments)
  const blockedEventIds = built.blockedIds

  if (!client) {
    return { name: fallbackThemeName(moments), source: 'fallback', reason: 'no-client', blockedEventIds }
  }
  if (built.payload.moments.length === 0 || moments.length === 0) {
    return { name: fallbackThemeName(moments), source: 'fallback', reason: 'no-context', blockedEventIds }
  }

  let usage: LlmUsage | undefined
  try {
    const result = await client.completeNaming(built.payload, {
      signal: options.signal,
      maxTokens: options.maxTokens ?? LLM_DEFAULTS.namingMaxTokens
    })
    usage = result.usage
    const validation = validateThemeName(result.json, options)
    if (validation.ok) {
      return { name: validation.name, source: 'llm', usage, blockedEventIds }
    }
    return {
      name: fallbackThemeName(moments),
      source: 'fallback',
      reason: 'invalid-output',
      usage,
      blockedEventIds
    }
  } catch (error) {
    // 暂停 / 退出：结果一律丢弃，交给上层按 D18 处理
    if (error instanceof LlmAbortError) throw error
    return {
      name: fallbackThemeName(moments),
      source: 'fallback',
      reason: 'llm-error',
      usage,
      blockedEventIds
    }
  }
}
