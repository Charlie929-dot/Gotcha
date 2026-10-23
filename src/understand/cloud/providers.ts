/**
 * LLM 供应商配置（M2 / D21）
 *
 * settings 契约（已拍板）：`llm.active_provider`（独立键）+ `llm.providers`（JSON 数组）。
 * - 预设 DeepSeek；可加自定义 OpenAI 兼容供应商（baseUrl / model）；
 * - 只存环境变量名，密钥值从进程环境 / `userData/.env` 读取，不进 settings、不落日志；
 * - URL 只允许 https；本地网关（localhost / 127.0.0.1 / ::1）允许 http；拒绝 URL 内凭据、
 *   query、fragment（审查发现「自定义供应商允许任意 HTTP」与凭据回落风险）；
 * - providers 缺失 / `[]` → 默认 DeepSeek；非空但 JSON 坏 / 结构非法 → `invalid-providers`
 *   （不静默回退默认远端，避免把数据发给用户以为已替换掉的供应商）。
 */

import { LLM_DEFAULTS } from './constants'

export interface LlmProvider {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKeyEnv: string
}

export interface LlmProvidersSettings {
  active?: string | null
  providers?: string | null
}

export const DEFAULT_PROVIDER: LlmProvider = {
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: LLM_DEFAULTS.baseUrl,
  model: LLM_DEFAULTS.model,
  apiKeyEnv: LLM_DEFAULTS.apiKeyEnv
}

export const DEFAULT_ACTIVE_PROVIDER = DEFAULT_PROVIDER.id

export type ResolvedLlmProvider =
  | { ok: true; provider: LlmProvider; apiKey: string }
  | { ok: false; reason: 'unknown-provider'; providerId: string }
  | { ok: false; reason: 'invalid-providers' }
  | { ok: false; reason: 'missing-key'; providerId: string; apiKeyEnv: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** 规范化并校验 baseUrl：https（或本地 http）、无凭据、无 query/fragment */
export function normalizeBaseUrl(value: string): string | null {
  if (!isNonEmptyString(value)) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  if (url.search !== '' || url.hash !== '') return null
  const secure = url.protocol === 'https:'
  const localHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname)
  if (!secure && !localHttp) return null
  return url.toString().replace(/\/+$/, '')
}

/** 校验单个供应商；非法项返回 null（由调用方跳过，不整体失败） */
export function parseProvider(raw: unknown): LlmProvider | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  if (
    !isNonEmptyString(item.id) ||
    !isNonEmptyString(item.label) ||
    !isNonEmptyString(item.model) ||
    !isNonEmptyString(item.apiKeyEnv)
  ) {
    return null
  }
  const baseUrl = normalizeBaseUrl(item.baseUrl as string)
  if (!baseUrl) return null
  return {
    id: item.id.trim(),
    label: item.label.trim(),
    baseUrl,
    model: item.model.trim(),
    apiKeyEnv: item.apiKeyEnv.trim()
  }
}

export interface ProvidersConfigResult {
  providers: LlmProvider[]
  /** true = 配置存在但无法解析（调用方必须报配置错误，不得静默回退默认远端供应商） */
  invalid: boolean
}

/**
 * 解析 settings.llm.providers（JSON 数组）。
 * - 缺失 / 空串 / `[]` → 默认 DeepSeek 预设（未配置即默认，属正常路径）；
 * - 非空但 JSON 坏 / 不是数组 / 所有项都非法 → `invalid: true`：用户明明配了供应商却解析失败，
 *   静默回落 DeepSeek 会把数据发给用户以为已替换掉的远端（PR #23 复审 finding）。
 */
export function parseProvidersConfig(raw: string | null | undefined): ProvidersConfigResult {
  if (raw == null || raw.trim() === '') return { providers: [{ ...DEFAULT_PROVIDER }], invalid: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { providers: [], invalid: true }
  }
  if (!Array.isArray(parsed)) return { providers: [], invalid: true }
  const providers: LlmProvider[] = []
  for (const item of parsed) {
    const provider = parseProvider(item)
    // 同 id 去重：先出现者生效，避免重复键导致不可预期选择
    if (provider && !providers.some((p) => p.id === provider.id)) providers.push(provider)
  }
  if (providers.length === 0) {
    return parsed.length === 0
      ? { providers: [{ ...DEFAULT_PROVIDER }], invalid: false }
      : { providers: [], invalid: true }
  }
  return { providers, invalid: false }
}

/**
 * 解析「当前生效供应商 + 密钥」。密钥优先级：进程环境变量 > `userData/.env`。
 * 未知 active / 缺密钥都返回原因（不静默回退到默认供应商，避免用户以为换成功了）。
 */
export function resolveLlmProvider(
  activeProvider: string | null | undefined,
  providers: readonly LlmProvider[],
  env: Record<string, string | undefined>,
  fileEnv: Record<string, string> = {}
): ResolvedLlmProvider {
  const activeId =
    isNonEmptyString(activeProvider) && activeProvider.trim() !== ''
      ? activeProvider.trim()
      : (providers.some((p) => p.id === DEFAULT_ACTIVE_PROVIDER)
          ? DEFAULT_ACTIVE_PROVIDER
          : providers[0]?.id ?? DEFAULT_ACTIVE_PROVIDER)
  const provider = providers.find((item) => item.id === activeId)
  if (!provider) return { ok: false, reason: 'unknown-provider', providerId: activeId }
  const fromEnv = env[provider.apiKeyEnv]
  const fromFile = fileEnv[provider.apiKeyEnv]
  // 空字符串视同未设置：CI / shell 常见的 `FOO=` 不能遮蔽 .env 里的有效密钥
  const apiKey = isNonEmptyString(fromEnv) ? fromEnv.trim() : isNonEmptyString(fromFile) ? fromFile.trim() : ''
  if (!apiKey) {
    return {
      ok: false,
      reason: 'missing-key',
      providerId: provider.id,
      apiKeyEnv: provider.apiKeyEnv
    }
  }
  return { ok: true, provider, apiKey }
}

/**
 * 从 settings 两键直接解析（Phase 1 调度层用）。
 * providers JSON 坏 / 结构非法 → `invalid-providers`，不得回退默认供应商。
 */
export function resolveFromSettings(
  settings: LlmProvidersSettings,
  env: Record<string, string | undefined>,
  fileEnv: Record<string, string> = {}
): ResolvedLlmProvider {
  const parsed = parseProvidersConfig(settings.providers)
  if (parsed.invalid) return { ok: false, reason: 'invalid-providers' }
  return resolveLlmProvider(settings.active, parsed.providers, env, fileEnv)
}
