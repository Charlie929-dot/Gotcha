/**
 * 问记忆 · 模式（2026-10-30，D62）
 *
 * 拍板人原话：「界面可以选择模式，问记忆模式（给工具，无人格卡）、聊天模式（人格卡，
 * 无电脑使用的记忆工具）、提问模式（无工具和人格卡），可以组合选择……不会每次都全量注入」。
 *
 * 三个预设只是起点，底下是三个独立开关：
 * - `screen`：屏幕记忆工具（search_info / read_segment / ask_history / get_freshness）
 * - `diary` ：日记工具（recall_diary / read_diary / memory_profile）
 * - `card`  ：人格卡（整张卡注入 system）
 *
 * 这个模块只做「模式 → 开关」的纯映射，不碰提示词、不碰 IPC：
 * 主进程按它决定传哪些依赖，链层按它决定发不发工具，云端策略按它拼 system 段。
 */

export interface AskModeConfig {
  /** 屏幕记忆工具 */
  screen: boolean
  /** 日记工具 */
  diary: boolean
  /** 人格卡 */
  card: boolean
}

/** 工具组（链层 / 云端只需要这两个开关；卡不影响工具） */
export interface AskToolGroups {
  screen: boolean
  diary: boolean
}

/** 预设：问记忆 = 屏幕 + 日记；聊天 = 日记 + 卡；提问 = 全关 */
export const ASK_MODE_PRESETS = {
  memory: { screen: true, diary: true, card: false },
  chat: { screen: false, diary: true, card: true },
  plain: { screen: false, diary: false, card: false }
} as const satisfies Record<string, AskModeConfig>

export type AskModePreset = keyof typeof ASK_MODE_PRESETS

/** 界面按这个顺序展示预设（也是「新会话沿用上次」的合法值） */
export const ASK_MODE_PRESET_ORDER: readonly AskModePreset[] = ['memory', 'chat', 'plain']

export const DEFAULT_ASK_MODE: AskModeConfig = { ...ASK_MODE_PRESETS.memory }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把渲染层 / 持久化里存的模式钳成合法值：**不做静默升级**——
 * 不是对象就回落默认（问记忆），对象里缺的字段按关处理（用户确实只勾了那几项）。
 */
export function normalizeAskMode(raw: unknown): AskModeConfig {
  if (!isPlainObject(raw)) return { ...DEFAULT_ASK_MODE }
  return { screen: raw.screen === true, diary: raw.diary === true, card: raw.card === true }
}

/** 这个模式是否正好等于某个预设（界面按钮高亮用） */
export function askModePresetOf(mode: AskModeConfig): AskModePreset | null {
  for (const name of ASK_MODE_PRESET_ORDER) {
    const preset = ASK_MODE_PRESETS[name]
    if (
      preset.screen === mode.screen &&
      preset.diary === mode.diary &&
      preset.card === mode.card
    ) {
      return name
    }
  }
  return null
}

/** 有没有任何工具（没有 = 单轮请求，不进工具循环） */
export function hasAskTools(mode: AskModeConfig): boolean {
  return mode.screen || mode.diary
}

/** 工具组：模式里卡不影响工具 */
export function askToolGroupsOf(mode: AskModeConfig): AskToolGroups {
  return { screen: mode.screen, diary: mode.diary }
}

/** 这个模式要不要注入开场（「此刻」/「想到的」）：纯提问不需要，否则会显得它知道你的记忆 */
export function asksMemoryContext(mode: AskModeConfig): boolean {
  return mode.screen || mode.card
}
