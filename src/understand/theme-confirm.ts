/**
 * 模糊归属确认（P2 在线化 S4；docs/m2-graph-redesign.md §5.2 / §9.1 / §9.3）
 *
 * 本地 embedding 给出 `assignMoment()` 的 `ambiguous` 时刻（top1/top2 不是近重复、gap 很小），
 * 才交 LLM 在**候选主题**里挑；模型不能自由编 id：
 * - 输入走 `buildThemeAssignmentPayload()`（时刻文本 + 候选主题标题 / 摘要，全部脱敏）；
 * - 输出 `{ assignments: [{ moment_id, theme_ids[0..3], new_title? }] }`，逐条校验：
 *   未知 moment_id / 未知 theme_id 丢弃，主题 id 去重并裁到 3 个，new_title 裁到 24 字；
 * - **失败不整批失败**：请求失败 / 输出不合法 / 没有候选，本轮这些时刻一律「暂不归属」，
 *   留到下一轮（`pendingMomentIds`），已有归属不受影响；
 * - 单次最多 20 个时刻（§9.1），超出的留给下一轮；
 * - 取消除外：暂停要立刻停下，不能悄悄吞掉 `LlmAbortError`（D18 零出网）。
 *
 * 错误文案只含下标 / 字段名 / 上限，不含事件原文（与归纳校验同一口径）。
 */

import { LLM_DEFAULTS } from './cloud/constants'
import { LlmAbortError, type LlmClient, type LlmUsage } from './cloud/llm-client'
import {
  buildThemeAssignmentPayload,
  type RedactableAssignmentMoment
} from './cloud/redact'

/** 单批最多确认的时刻数（§9.1） */
export const CONFIRM_BATCH_MAX = 20

/** 单个时刻最多接受几个主题（主归属 + 次归属，§5.2） */
export const MAX_THEME_IDS_PER_MOMENT = 3

/** 新主题标题上限（与命名建议值一致） */
const NEW_TITLE_MAX_CHARS = 24

export interface ConfirmMoment extends RedactableAssignmentMoment {}

/** 候选主题：id 用 themeId（与图谱侧命名一致），载荷层再映射成 `RedactableTheme.id` */
export interface ConfirmTheme {
  themeId: number
  title: string
  summary: string
}

/** 模型给出的归属决定；`newTitle` 非空 = 候选都不合适、建议新建主题 */
export interface AssignmentDecision {
  momentId: number
  themeIds: number[]
  newTitle?: string
}

export interface AssignmentValidation {
  /** false = 根结构非法（整次确认作废）；true 时可能仍有被丢弃的单条 */
  ok: boolean
  decisions: AssignmentDecision[]
  errors: string[]
  /** 被丢弃的条数（未知时刻 / 未知主题 id / 空归属 / 重复时刻） */
  dropped: number
  /** 超过每个时刻上限被裁掉的主题 id 数 */
  trimmed: number
}

export interface AssignmentValidationInput {
  /** momentId → 该时刻允许的候选主题 id（来自已脱敏载荷） */
  candidates: ReadonlyMap<number, ReadonlySet<number>>
  maxThemeIds?: number
  newTitleMaxChars?: number
}

const MAX_ERRORS = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * 校验模糊确认输出。
 * 根结构非法 → `ok:false`（整次作废，调用方全部留到下一轮）；
 * 单条非法 → 丢弃该条并计数，其余照收——「不编造 id」是硬约束，但一条坏数据不该拖垮整批。
 */
export function validateAssignments(
  json: unknown,
  input: AssignmentValidationInput
): AssignmentValidation {
  const maxThemeIds = input.maxThemeIds ?? MAX_THEME_IDS_PER_MOMENT
  const newTitleMax = input.newTitleMaxChars ?? NEW_TITLE_MAX_CHARS
  const errors: string[] = []
  const pushError = (message: string): void => {
    if (errors.length < MAX_ERRORS) errors.push(message)
  }

  if (!isRecord(json)) {
    return { ok: false, decisions: [], errors: ['根节点必须是 json 对象'], dropped: 0, trimmed: 0 }
  }
  if (!Array.isArray(json.assignments)) {
    return { ok: false, decisions: [], errors: ['assignments 必须是数组'], dropped: 0, trimmed: 0 }
  }

  let dropped = 0
  let trimmed = 0
  const seen = new Set<number>()
  const decisions: AssignmentDecision[] = []

  json.assignments.forEach((raw, index) => {
    const label = `assignments[${index}]`
    if (!isRecord(raw)) {
      dropped += 1
      pushError(`${label} 必须是对象`)
      return
    }
    const momentId = raw.moment_id
    if (!isInteger(momentId) || !input.candidates.has(momentId)) {
      dropped += 1
      pushError(`${label}.moment_id 不是本批时刻`)
      return
    }
    if (seen.has(momentId)) {
      dropped += 1
      pushError(`${label}.moment_id 重复出现`)
      return
    }
    seen.add(momentId)

    const allowed = input.candidates.get(momentId)!
    const rawThemeIds = raw.theme_ids
    let themeIds: number[] = []
    if (rawThemeIds !== undefined && !Array.isArray(rawThemeIds)) {
      pushError(`${label}.theme_ids 必须是数组`)
    } else if (Array.isArray(rawThemeIds)) {
      const kept: number[] = []
      const seenTheme = new Set<number>()
      for (const id of rawThemeIds) {
        if (!isInteger(id) || !allowed.has(id)) {
          dropped += 1
          pushError(`${label}.theme_ids 含非候选 id`)
          continue
        }
        if (seenTheme.has(id)) {
          dropped += 1
          continue
        }
        seenTheme.add(id)
        kept.push(id)
      }
      if (kept.length > maxThemeIds) {
        trimmed += kept.length - maxThemeIds
        kept.length = maxThemeIds
      }
      themeIds = kept
    }

    let newTitle: string | undefined
    if (raw.new_title !== undefined) {
      if (typeof raw.new_title !== 'string' || raw.new_title.trim() === '') {
        pushError(`${label}.new_title 必须是非空字符串`)
      } else {
        newTitle = raw.new_title.trim().slice(0, newTitleMax)
      }
    }

    if (themeIds.length === 0 && newTitle === undefined) {
      // 模型既没选主题也没给新标题：这一条等于「不归属」，留到下一轮
      dropped += 1
      pushError(`${label} 既没有 theme_ids 也没有 new_title`)
      return
    }

    decisions.push(
      newTitle === undefined ? { momentId, themeIds } : { momentId, themeIds, newTitle }
    )
  })

  decisions.sort((a, b) => a.momentId - b.momentId)
  return { ok: true, decisions, errors, dropped, trimmed }
}

export type ConfirmFallbackReason = 'no-client' | 'no-candidates' | 'invalid-output' | 'llm-error'

export interface ConfirmOutcome {
  decisions: AssignmentDecision[]
  /** true = 整次确认不可用（无客户端 / 无候选 / 请求失败 / 输出非法），调用方整批留到下一轮 */
  failed: boolean
  reason?: ConfirmFallbackReason
  usage?: LlmUsage
  /** 本轮没定下来的时刻（敏感 / 无候选 / 模型没选 / 超出批量），按升序 */
  pendingMomentIds: number[]
  /** 非致命问题（字段名 / 下标 / 上限，可进日志） */
  errors: string[]
}

function uniqueSorted(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

/**
 * 确认一批模糊时刻的归属；永不因模型 / 网络 / 校验失败抛错（取消除外）。
 * `client` 传 null = 未配置密钥或未确认出网（D24 门）：零请求，整批 pending。
 */
export async function confirmThemeAssignments(
  client: LlmClient | null,
  moments: readonly ConfirmMoment[],
  themes: readonly ConfirmTheme[],
  options: { signal?: AbortSignal; maxTokens?: number } = {}
): Promise<ConfirmOutcome> {
  const allIds = moments.map((moment) => moment.momentId)
  const batch = moments.slice(0, CONFIRM_BATCH_MAX)
  const overflowIds = moments.slice(CONFIRM_BATCH_MAX).map((moment) => moment.momentId)

  if (!client) {
    return { decisions: [], failed: true, reason: 'no-client', pendingMomentIds: uniqueSorted(allIds), errors: [] }
  }

  const built = buildThemeAssignmentPayload(
    batch,
    themes.map((theme) => ({ id: theme.themeId, title: theme.title, summary: theme.summary }))
  )
  const excludedIds = [
    ...built.blockedMomentIds,
    ...built.noCandidateMomentIds,
    ...overflowIds
  ]
  if (built.payload.moments.length === 0) {
    return {
      decisions: [],
      failed: true,
      reason: 'no-candidates',
      pendingMomentIds: uniqueSorted([...excludedIds, ...allIds]),
      errors: []
    }
  }

  const candidates = new Map<number, Set<number>>()
  for (const moment of built.payload.moments) {
    candidates.set(moment.momentId, new Set(moment.candidateThemeIds))
  }

  let usage: LlmUsage | undefined
  try {
    const result = await client.completeAssignments(built.payload, {
      signal: options.signal,
      maxTokens: options.maxTokens ?? LLM_DEFAULTS.assignmentMaxTokens
    })
    usage = result.usage
    const validation = validateAssignments(result.json, { candidates })
    if (!validation.ok) {
      return {
        decisions: [],
        failed: true,
        reason: 'invalid-output',
        usage,
        pendingMomentIds: uniqueSorted(allIds),
        errors: validation.errors
      }
    }
    const decided = new Set(validation.decisions.map((decision) => decision.momentId))
    const pending = allIds.filter((id) => !decided.has(id) || excludedIds.includes(id))
    return {
      decisions: validation.decisions,
      failed: false,
      usage,
      pendingMomentIds: uniqueSorted(pending),
      errors: validation.errors
    }
  } catch (error) {
    if (error instanceof LlmAbortError) throw error
    return {
      decisions: [],
      failed: true,
      reason: 'llm-error',
      usage,
      pendingMomentIds: uniqueSorted(allIds),
      errors: []
    }
  }
}
