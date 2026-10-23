/**
 * LLM 供应商配置（M2 / D21）
 *
 * 形态参照 harness 模型配置：`{ active, providers: [{ id, label, baseUrl, model, apiKeyEnv }] }`。
 * - 预设 DeepSeek；可加任意 OpenAI 兼容供应商（自定义 baseUrl / model）；
 * - 只存环境变量名，密钥值从进程环境 / `userData/.env` 读取，不进 settings、不落日志；
 * - 配置源是 settings（`llm.providers`），本模块只做纯解析与解析，读写由上层负责。
 */

import { LLM_DEFAULTS } from './constants'

export interface LlmProvider {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKeyEnv: string
}

export interface LlmProvidersConfig {
  active: string
  providers: LlmProvider[]
}

export const DEFAULT_PROVIDER: LlmProvider = {
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: LLM_DEFAULTS.baseUrl,
  model: LLM_DEFAULTS.model,
  apiKeyEnv: LLM_DEFAULTS.apiKeyEnv
}

export const DEFAULT_PROVIDERS_CONFIG: LlmProvidersConfig = {
  active: DEFAULT_PROVIDER.id,
  providers: [DEFAULT_PROVIDER]
}

export type ResolvedLlmProvider =
  | { ok: true; provider: LlmProvider; apiKey: string }
  | { ok: false; reason: 'unknown-provider'; providerId: string }
  | { ok: false; reason: 'missing-key'; providerId: string; apiKeyEnv: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 校验单个供应商；非法项返回 null（由调用方跳过，不整体失败） */
export function parseProvider(raw: unknown): LlmProvider | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  if (
    !isNonEmptyString(item.id) ||
    !isNonEmptyString(item.label) ||
    !isNonEmptyString(item.baseUrl) ||
    !isNonEmptyString(item.model) ||
    !isNonEmptyString(item.apiKeyEnv) ||
    !isValidHttpUrl(item.baseUrl)
  ) {
    return null
  }
  return {
    id: item.id.trim(),
    label: item.label.trim(),
    baseUrl: item.baseUrl.trim().replace(/\/+$/, ''),
    model: item.model.trim(),
    apiKeyEnv: item.apiKeyEnv.trim()
  }
}

/** 默认配置的副本：避免调用方改到共享常量 */
function defaultProvidersConfig(): LlmProvidersConfig {
  return { active: DEFAULT_PROVIDER.id, providers: [{ ...DEFAULT_PROVIDER }] }
}

/** 解析 settings 里的 `llm.providers`；缺失 / 非法 / 空列表 → 默认 DeepSeek 预设 */
export function parseProvidersConfig(raw: string | null | undefined): LlmProvidersConfig {
  if (!raw) return defaultProvidersConfig()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultProvidersConfig()
  }
  if (typeof parsed !== 'object' || parsed === null) return defaultProvidersConfig()
  const value = parsed as { active?: unknown; providers?: unknown }
  if (!Array.isArray(value.providers)) return defaultProvidersConfig()
  const providers: LlmProvider[] = []
  for (const item of value.providers) {
    const provider = parseProvider(item)
    // 同 id 去重：先出现者生效，避免重复键导致不可预期选择
    if (provider && !providers.some((p) => p.id === provider.id)) providers.push(provider)
  }
  if (providers.length === 0) return defaultProvidersConfig()
  const active = isNonEmptyString(value.active) ? value.active : providers[0].id
  return { active, providers }
}

/**
 * 解析「当前生效供应商 + 密钥」。密钥优先级：进程环境变量 > `userData/.env`。
 * 未知 active / 缺密钥都返回原因（不静默回退到默认供应商，避免用户以为换成功了）。
 */
export function resolveLlmProvider(
  config: LlmProvidersConfig,
  env: Record<string, string | undefined>,
  fileEnv: Record<string, string> = {}
): ResolvedLlmProvider {
  const provider = config.providers.find((item) => item.id === config.active)
  if (!provider) return { ok: false, reason: 'unknown-provider', providerId: config.active }
  const apiKey = env[provider.apiKeyEnv] ?? fileEnv[provider.apiKeyEnv] ?? ''
  if (!apiKey) return { ok: false, reason: 'missing-key', providerId: provider.id, apiKeyEnv: provider.apiKeyEnv }
  return { ok: true, provider, apiKey }
}
