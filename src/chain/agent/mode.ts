/**
 * 问记忆 · 模式（2026-10-30，D72：「分支即模式」）
 *
 * 两档，落成两种分支：
 * - `ask`：纯模型（assistant 分支，不注入 persona、不读日记 / 屏幕记忆；
 *   工具可 `/tool add`，但默认全关）；
 * - `chat`：带 persona（persona 分支，人格卡或默认人设；工具默认全开）。
 *
 * 模式不再随每条消息传（旧 D62 的 `AskModeConfig` 已删）：主进程按**当前分支的 kind**
 * 现算，界面只显示、不决定。`/mode ask|chat` 是 `/use` 的语义化别名——切分支，
 * 会话上下文跟着分支走（会话文件在仓里，一个分支一份）。
 *
 * 这个模块只做「名字 ↔ 档位」和「这一档要不要注入记忆开场」的纯映射，不碰提示词、不碰 IPC。
 */

import type { AskToolName } from './tool-catalog'

export type AskModeKind = 'ask' | 'chat'

/** 界面上「当前模式」的完整描述（命令回执 / `ask:mode` 共用） */
export interface AskModeState {
  kind: AskModeKind
  /** 当前分支名（模式就是它） */
  branch: string
  /** 这个分支实际生效的工具（已按目录规范化） */
  tools: readonly AskToolName[]
}

/** 中文名（`/mode` 回执、模式条共用；不要在别处再抄一份） */
export const ASK_MODE_LABELS: Readonly<Record<AskModeKind, string>> = {
  ask: '纯模型',
  chat: '聊天'
}

/** 别名：命令行短英文 + 中文名都认；`mem` / `memory` / 问记忆 落到 chat（带 persona 的记忆模式） */
const ASK_MODE_ALIASES: Readonly<Record<string, AskModeKind>> = {
  ask: 'ask',
  pure: 'ask',
  '纯模型': 'ask',
  chat: 'chat',
  '聊天': 'chat',
  mem: 'chat',
  memory: 'chat',
  '问记忆': 'chat'
}

/** 命令里给的名字 → 档位；不认识返回 null（不静默回落） */
export function askModeKindFromName(raw: string): AskModeKind | null {
  const key = raw.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(ASK_MODE_ALIASES, key)
    ? ASK_MODE_ALIASES[key]
    : null
}

/** 分支 kind → 模式档位（life 主干按 persona 算：它是出生线，聊起来也是同一条鱼） */
export function askModeKindOfBranch(branchKind: 'persona' | 'assistant' | 'life'): AskModeKind {
  return branchKind === 'assistant' ? 'ask' : 'chat'
}

/**
 * 要不要注入「此刻 / 想到的」开场：只有 chat 要。
 * 纯模型档带这些会显得它知道你的记忆（D61 / D72）。
 */
export function asksMemoryContext(kind: AskModeKind): boolean {
  return kind === 'chat'
}

/** 一行摘要：`聊天（分支 ✨default · 7 个工具）`（D83：分支名是占位符，前面加 ✨） */
export function modeSummary(state: AskModeState): string {
  const tools = state.tools.length === 0 ? '无工具' : `${state.tools.length} 个工具`
  return `${ASK_MODE_LABELS[state.kind]}（分支 ✨${state.branch} · ${tools}）`
}
