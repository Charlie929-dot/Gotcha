/**
 * 图谱设置读写与校验（M2 Phase 2；D21/D22）
 *
 * - 归纳参数 / 供应商 / 热键全部存 settings（不建新表），默认值沿用 `db/settings.ts`
 *   与 `hotkeys.ts` / `providers.ts` 的既有默认，不在这里另写一份；
 * - 读：`Db | null`（无库 = 默认值 + 空用量），不触发建库（A3）；
 * - 写：只接受白名单字段并逐项校验，非法值整单拒绝（不静默回退）；
 * - 密钥永不进 settings：patch 里出现 apiKey 类字段直接报错；供应商只存 apiKeyEnv 名。
 */

import type { Db } from '../db'
import { getNumberSetting, getSetting, setSetting } from '../db/settings'
import { readUsage } from '../understand/induction'
import {
  DEFAULT_ACTIVE_PROVIDER,
  DEFAULT_PROVIDER,
  parseProvider,
  parseProvidersConfig,
  type LlmProvider
} from '../understand/cloud/providers'
import { DEFAULT_HOTKEYS, isSupportedAccelerator, type HotkeyBindings } from './hotkeys'
import {
  GRAPH_THRESHOLD_DEFAULTS,
  GRAPH_THRESHOLD_KEYS,
  parseThresholdPatch,
  readGraphThresholds,
  type GraphThresholds
} from '../understand/graph-thresholds'

export const GRAPH_SETTING_KEYS = {
  auto: 'graph.auto',
  intervalMinutes: 'graph.interval_minutes',
  budgetTokensPerDay: 'graph.budget_tokens_per_day',
  retryBackoffMinutes: 'graph.retry_backoff_minutes',
  batchMaxMoments: 'graph.batch_max_moments',
  maxTokens: 'graph.max_tokens',
  /** 日历日格热力的「满量」：当天事件数占它的比例决定颜色深浅（P3-b） */
  dayHeatMax: 'graph.day_heat_max',
  /** 图谱「时刻过多」提示的阈值：可见时刻数超过它就在顶部提示收窄（P3-b） */
  scaleHintMoments: 'graph.scale_hint_moments',
  activeProvider: 'llm.active_provider',
  providers: 'llm.providers',
  outboundConsent: 'graph.outbound_consent'
} as const

/**
 * 日格热力满量默认值：一天全在使用约 3–4k 事件（2026-10-25 拍板人口径），
 * 先按 4000 当「满格」，之后在设置抽屉里可调。
 */
export const DEFAULT_DAY_HEAT_MAX = 4_000

/**
 * 「时刻过多」提示的默认阈值：§12 首屏口径是「超过约 2k 个时刻提示收窄」。
 * 2k / 3k 在 §16 里还挂着待拍板，所以做成设置（默认 2k，抽屉里可调），
 * 不把拍板结果硬编码进渲染层。
 */
export const DEFAULT_SCALE_HINT_MOMENTS = 2_000

export interface GraphUsageView {
  calls: number
  promptTokens: number
  completionTokens: number
}

export interface GraphSettingsView {
  auto: boolean
  intervalMinutes: number
  budgetTokensPerDay: number
  retryBackoffMinutes: string
  batchMaxMoments: number
  maxTokens: number
  /** 日历日格热力满量（事件/天）；当天事件占它的比例决定颜色深浅 */
  dayHeatMax: number
  /** 可见时刻数超过它就提示先切「只看主题」；默认 2k */
  scaleHintMoments: number
  activeProvider: string
  providers: LlmProvider[]
  providersInvalid: boolean
  hotkeys: HotkeyBindings
  outboundConsent: boolean
  /** 相似度阈值（§5.2；P3 才在设置面板暴露，这里先保证可读写/可标定） */
  thresholds: GraphThresholds
  usage: GraphUsageView
}

export interface GraphSettingsPatch {
  auto?: boolean
  intervalMinutes?: number
  budgetTokensPerDay?: number
  /** 分钟列表（与 settings 的 `1,5,15` 文本互转） */
  retryBackoffMinutes?: number[]
  batchMaxMoments?: number
  maxTokens?: number
  dayHeatMax?: number
  scaleHintMoments?: number
  activeProvider?: string
  providers?: LlmProvider[]
  hotkeys?: Partial<HotkeyBindings>
  outboundConsent?: boolean
  thresholds?: Partial<GraphThresholds>
}

export type GraphSettingsSaveResult =
  | { ok: true; settings: GraphSettingsView }
  | { ok: false; error: string }

const LIMITS = {
  intervalMinutes: { min: 1, max: 1_440 },
  budgetTokensPerDay: { min: 1_000, max: 100_000_000 },
  batchMaxMoments: { min: 1, max: 100 },
  maxTokens: { min: 256, max: 8_192 },
  dayHeatMax: { min: 100, max: 200_000 },
  // 下限给到 1：阈值只是「什么时候提示」，设 1 等于常驻提示（排查 / 演示用），不做额外限制
  scaleHintMoments: { min: 1, max: 20_000 },
  retryBackoff: { min: 1, max: 1_440, maxItems: 5 },
  providers: { min: 1, max: 20 }
} as const

const PROVIDER_KEYS = ['id', 'label', 'baseUrl', 'model', 'apiKeyEnv'] as const
/** 精确字段名（不要用 includes：hotkeys 会误中 key） */
const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'key',
  'secret',
  'token',
  'password',
  'access_token',
  'refresh_token',
  'client_secret'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function parseBackoffText(raw: string): string {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part))
    .map(Number)
    .filter((value) => value >= LIMITS.retryBackoff.min && value <= LIMITS.retryBackoff.max)
  return parts.length > 0 ? parts.slice(0, LIMITS.retryBackoff.maxItems).join(',') : '1,5,15'
}

/** 库里的日格满量：非整数 / 越界一律回退默认，不做静默夹取 */
function clampDayHeatMax(value: number): number {
  const limits = LIMITS.dayHeatMax
  if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_DAY_HEAT_MAX
  if (value < limits.min || value > limits.max) return DEFAULT_DAY_HEAT_MAX
  return value
}

/** 同 dayHeatMax：坏值回退默认，不猜用户意图 */
function clampScaleHintMoments(value: number): number {
  const limits = LIMITS.scaleHintMoments
  if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_SCALE_HINT_MOMENTS
  if (value < limits.min || value > limits.max) return DEFAULT_SCALE_HINT_MOMENTS
  return value
}

export function readGraphSettings(db: Db | null, now = Date.now()): GraphSettingsView {
  if (!db) {
    return {
      auto: true,
      intervalMinutes: 10,
      budgetTokensPerDay: 1_000_000,
      retryBackoffMinutes: '1,5,15',
      batchMaxMoments: 20,
      maxTokens: 2_000,
      dayHeatMax: DEFAULT_DAY_HEAT_MAX,
      scaleHintMoments: DEFAULT_SCALE_HINT_MOMENTS,
      activeProvider: DEFAULT_ACTIVE_PROVIDER,
      providers: [{ ...DEFAULT_PROVIDER }],
      providersInvalid: false,
      hotkeys: { ...DEFAULT_HOTKEYS },
      outboundConsent: false,
      thresholds: { ...GRAPH_THRESHOLD_DEFAULTS },
      usage: { calls: 0, promptTokens: 0, completionTokens: 0 }
    }
  }

  const parsed = parseProvidersConfig(getSetting(db, GRAPH_SETTING_KEYS.providers))
  const usage = readUsage(db, now)
  return {
    auto: getSetting(db, GRAPH_SETTING_KEYS.auto) === '1',
    intervalMinutes: getNumberSetting(db, GRAPH_SETTING_KEYS.intervalMinutes, 10),
    budgetTokensPerDay: getNumberSetting(db, GRAPH_SETTING_KEYS.budgetTokensPerDay, 1_000_000),
    retryBackoffMinutes: parseBackoffText(getSetting(db, GRAPH_SETTING_KEYS.retryBackoffMinutes)),
    batchMaxMoments: getNumberSetting(db, GRAPH_SETTING_KEYS.batchMaxMoments, 20),
    maxTokens: getNumberSetting(db, GRAPH_SETTING_KEYS.maxTokens, 2_000),
    dayHeatMax: clampDayHeatMax(
      getNumberSetting(db, GRAPH_SETTING_KEYS.dayHeatMax, DEFAULT_DAY_HEAT_MAX)
    ),
    scaleHintMoments: clampScaleHintMoments(
      getNumberSetting(db, GRAPH_SETTING_KEYS.scaleHintMoments, DEFAULT_SCALE_HINT_MOMENTS)
    ),
    activeProvider: getSetting(db, GRAPH_SETTING_KEYS.activeProvider) || DEFAULT_ACTIVE_PROVIDER,
    providers: parsed.providers,
    providersInvalid: parsed.invalid,
    hotkeys: {
      toggleCapture:
        getSetting(db, 'hotkey.toggle_capture').trim() || DEFAULT_HOTKEYS.toggleCapture,
      openGraph: getSetting(db, 'hotkey.open_graph').trim() || DEFAULT_HOTKEYS.openGraph
    },
    outboundConsent: getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1',
    thresholds: readGraphThresholds(db),
    usage: {
      calls: usage.calls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens
    }
  }
}

/** 校验单个供应商：只允许 5 个契约字段，apiKeyEnv 只存名字 */
function validateProvider(raw: unknown, index: number): { ok: true; provider: LlmProvider } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `providers[${index}] 必须是对象` }
  for (const key of Object.keys(raw)) {
    if ((PROVIDER_KEYS as readonly string[]).includes(key)) continue
    if (SECRET_KEYS.has(key.toLowerCase())) {
      return { ok: false, error: '密钥不能写入设置，请用环境变量或 userData/.env' }
    }
    return { ok: false, error: `providers[${index}] 含未知字段` }
  }
  const provider = parseProvider(raw)
  if (!provider) {
    return {
      ok: false,
      error: `providers[${index}] 非法（baseUrl 仅 https 或本机 http；id/label/model/apiKeyEnv 必填）`
    }
  }
  return { ok: true, provider }
}

function validatePatch(input: unknown): { ok: true; patch: GraphSettingsPatch } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: '设置必须是对象' }
  const allowed = [
    'auto',
    'intervalMinutes',
    'budgetTokensPerDay',
    'retryBackoffMinutes',
    'batchMaxMoments',
    'maxTokens',
    'dayHeatMax',
    'scaleHintMoments',
    'activeProvider',
    'providers',
    'hotkeys',
    'outboundConsent',
    'thresholds'
  ]
  for (const key of Object.keys(input)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      return { ok: false, error: '密钥不能写入设置，请用环境变量或 userData/.env' }
    }
    if (!allowed.includes(key)) return { ok: false, error: `未知设置项：${key}` }
  }

  const patch: GraphSettingsPatch = {}

  if ('auto' in input) {
    if (typeof input.auto !== 'boolean') return { ok: false, error: 'auto 必须是布尔值' }
    patch.auto = input.auto
  }
  if ('outboundConsent' in input) {
    if (typeof input.outboundConsent !== 'boolean') {
      return { ok: false, error: 'outboundConsent 必须是布尔值' }
    }
    patch.outboundConsent = input.outboundConsent
  }
  for (const field of ['intervalMinutes', 'budgetTokensPerDay', 'batchMaxMoments', 'maxTokens', 'dayHeatMax', 'scaleHintMoments'] as const) {
    if (!(field in input)) continue
    const limits = LIMITS[field]
    if (!isIntInRange(input[field], limits.min, limits.max)) {
      return { ok: false, error: `${field} 必须在 ${limits.min}–${limits.max} 之间` }
    }
    patch[field] = input[field] as number
  }
  if ('retryBackoffMinutes' in input) {
    const value = input.retryBackoffMinutes
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > LIMITS.retryBackoff.maxItems ||
      !value.every((item) =>
        isIntInRange(item, LIMITS.retryBackoff.min, LIMITS.retryBackoff.max)
      )
    ) {
      return {
        ok: false,
        error: `retryBackoffMinutes 必须是 1–${LIMITS.retryBackoff.maxItems} 个 1–${LIMITS.retryBackoff.max} 的整数`
      }
    }
    patch.retryBackoffMinutes = [...value]
  }
  if ('activeProvider' in input) {
    if (!isNonEmptyString(input.activeProvider)) return { ok: false, error: 'activeProvider 必须是非空字符串' }
    patch.activeProvider = input.activeProvider.trim()
  }
  if ('providers' in input) {
    const value = input.providers
    if (
      !Array.isArray(value) ||
      value.length < LIMITS.providers.min ||
      value.length > LIMITS.providers.max
    ) {
      return { ok: false, error: `providers 必须是 ${LIMITS.providers.min}–${LIMITS.providers.max} 个供应商` }
    }
    const providers: LlmProvider[] = []
    for (let index = 0; index < value.length; index += 1) {
      const checked = validateProvider(value[index], index)
      if (!checked.ok) return checked
      if (providers.some((provider) => provider.id === checked.provider.id)) {
        return { ok: false, error: `providers[${index}] id 重复（${checked.provider.id}）` }
      }
      providers.push(checked.provider)
    }
    patch.providers = providers
  }
  if ('hotkeys' in input) {
    const value = input.hotkeys
    if (!isRecord(value)) return { ok: false, error: 'hotkeys 必须是对象' }
    const hotkeys: Partial<HotkeyBindings> = {}
    for (const key of Object.keys(value)) {
      if (key !== 'toggleCapture' && key !== 'openGraph') {
        return { ok: false, error: `未知快捷键项：${key}` }
      }
      const accelerator = value[key]
      if (!isSupportedAccelerator(accelerator)) {
        return { ok: false, error: `快捷键 ${key} 不合法` }
      }
      hotkeys[key as keyof HotkeyBindings] = accelerator.trim()
    }
    if (hotkeys.toggleCapture && hotkeys.openGraph) {
      if (hotkeys.toggleCapture.toLowerCase() === hotkeys.openGraph.toLowerCase()) {
        return { ok: false, error: '两个快捷键不能相同' }
      }
    }
    patch.hotkeys = hotkeys
  }
  if ('thresholds' in input) {
    const checked = parseThresholdPatch(input.thresholds)
    if (!checked.ok) return checked
    patch.thresholds = checked.patch
  }

  return { ok: true, patch }
}

/**
 * 保存设置（单事务；任何一项校验失败整单拒绝）。
 * 交叉校验：activeProvider 必须存在于保存后的 providers；两个热键不能相同。
 */
export function saveGraphSettings(db: Db, input: unknown, now = Date.now()): GraphSettingsSaveResult {
  const validated = validatePatch(input)
  if (!validated.ok) return validated
  const patch = validated.patch

  try {
    db.transaction(() => {
      const current = readGraphSettings(db, now)
      let providers = current.providers
      if (patch.providers) {
        providers = patch.providers
        setSetting(db, GRAPH_SETTING_KEYS.providers, JSON.stringify(providers))
      } else if (current.providersInvalid) {
        throw new Error('当前供应商配置已损坏，请先重新保存 providers')
      }

      const activeProvider = patch.activeProvider ?? current.activeProvider
      if (!providers.some((provider) => provider.id === activeProvider)) {
        throw new Error(`activeProvider 不在供应商列表中：${activeProvider}`)
      }
      if (patch.activeProvider) setSetting(db, GRAPH_SETTING_KEYS.activeProvider, activeProvider)

      const hotkeys: HotkeyBindings = { ...current.hotkeys, ...patch.hotkeys }
      if (
        !isSupportedAccelerator(hotkeys.toggleCapture) ||
        !isSupportedAccelerator(hotkeys.openGraph)
      ) {
        throw new Error('快捷键不合法')
      }
      if (hotkeys.toggleCapture.toLowerCase() === hotkeys.openGraph.toLowerCase()) {
        throw new Error('两个快捷键不能相同')
      }
      if (patch.hotkeys) {
        setSetting(db, 'hotkey.toggle_capture', hotkeys.toggleCapture)
        setSetting(db, 'hotkey.open_graph', hotkeys.openGraph)
      }

      if (patch.auto !== undefined) setSetting(db, GRAPH_SETTING_KEYS.auto, patch.auto ? '1' : '0')
      if (patch.outboundConsent !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.outboundConsent, patch.outboundConsent ? '1' : '0')
      }
      if (patch.intervalMinutes !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.intervalMinutes, String(patch.intervalMinutes))
      }
      if (patch.budgetTokensPerDay !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.budgetTokensPerDay, String(patch.budgetTokensPerDay))
      }
      if (patch.retryBackoffMinutes !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.retryBackoffMinutes, patch.retryBackoffMinutes.join(','))
      }
      if (patch.batchMaxMoments !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.batchMaxMoments, String(patch.batchMaxMoments))
      }
      if (patch.maxTokens !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.maxTokens, String(patch.maxTokens))
      }
      if (patch.dayHeatMax !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.dayHeatMax, String(patch.dayHeatMax))
      }
      if (patch.scaleHintMoments !== undefined) {
        setSetting(db, GRAPH_SETTING_KEYS.scaleHintMoments, String(patch.scaleHintMoments))
      }
      if (patch.thresholds) {
        for (const [key, value] of Object.entries(patch.thresholds)) {
          if (value === undefined) continue
          const name = key as keyof GraphThresholds
          setSetting(
            db,
            GRAPH_THRESHOLD_KEYS[name],
            name === 'edgeMutual' ? (value ? '1' : '0') : String(value)
          )
        }
      }
    })()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, settings: readGraphSettings(db, now) }
}
