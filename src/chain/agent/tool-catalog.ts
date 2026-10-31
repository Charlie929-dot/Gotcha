/**
 * 问记忆 · 工具目录（D72，2026-10-30）
 *
 * 「分支即模式」之后，工具不再由模式预设决定，而是**按分支**挂一份白名单：
 * `/tool add|rm` 改的就是这里列的元素。目录同时承担三件事：
 *
 * - 用户可见的「集合 / 元素」（`/tool set` / `/tool ele` 的编号与名字）；
 * - 发请求时的白名单（`askChain` → `deepseek` 只发命中的那几个）；
 * - 默认值（persona / life 分支沿用 D62 的老口径：全开；assistant 分支纯模型：全关）。
 *
 * 这里只放**名字与说明**，wire 格式（参数 schema）在 `understand/cloud/deepseek.ts`；
 * 两边各有一份清单，靠单测卡住「目录里有的，deepseek 必须也认识」。
 * `give_birth` 是生命周期工具（生命 ≤15% 自动出现），不进目录、不给 /tool 管。
 */

export interface AskToolSet {
  readonly id: string
  /** `/tool set` 里显示的名字 */
  readonly label: string
  readonly tools: readonly AskToolName[]
}

/**
 * 集合 = 老 D62 的两个工具组（屏幕记忆 / 日记）+ D81 的信。
 * 顺序就是 `/tool set` 的编号，也是 `/tool ele` 的分组顺序。
 */
export const ASK_TOOL_SCREEN_NAMES = [
  'search_info',
  'get_freshness',
  'read_segment',
  'recall',
  'ask_history'
] as const
export const ASK_TOOL_DIARY_NAMES = ['recall_diary', 'read_diary', 'memory_profile'] as const
export const ASK_TOOL_LETTER_NAMES = ['write_letter', 'list_letter', 'read_letter'] as const

export type AskToolName =
  | (typeof ASK_TOOL_SCREEN_NAMES)[number]
  | (typeof ASK_TOOL_DIARY_NAMES)[number]
  | (typeof ASK_TOOL_LETTER_NAMES)[number]

export const ASK_TOOL_SETS: readonly AskToolSet[] = [
  { id: 'screen', label: '屏幕记忆', tools: [...ASK_TOOL_SCREEN_NAMES] },
  { id: 'diary', label: '日记', tools: [...ASK_TOOL_DIARY_NAMES] },
  { id: 'letter', label: '信', tools: [...ASK_TOOL_LETTER_NAMES] }
]

/** 全部工具元素（顺序：先屏幕后日记，与 `ASK_TOOL_SETS` 一致） */
export const ASK_TOOL_NAMES: readonly AskToolName[] = ASK_TOOL_SETS.flatMap((set) => [
  ...set.tools
])

/** 一行说明（`/tool ele` 用；与 deepseek 的 tools 描述同义，不长篇复述参数） */
export const ASK_TOOL_LABELS: Readonly<Record<AskToolName, string>> = {
  search_info: '检索屏幕记忆段（时间 / 应用 / 标签 / 关键词 / 语义）',
  get_freshness: '查数据新鲜度（最新到哪一刻、采集在不在跑）',
  read_segment: '打开一段的界面文字与截图',
  recall: '回想归档的图片 / 文件 / 工具结果（占位符里 # 后面那串 id）',
  ask_history: '查最近的问答记录',
  recall_diary: '按关键词 / 日期 / 标签检索日记',
  read_diary: '打开某一天的日记全文',
  memory_profile: '看「关于我」的统计画像',
  write_letter: '写一封信（写给谁 / 写什么 / 写到哪）',
  list_letter: '看有哪些信（草稿 / 待寄 / 未读）',
  read_letter: '读一封信（不传 id = 最新未读）'
}

export function isAskToolName(value: string): value is AskToolName {
  return (ASK_TOOL_NAMES as readonly string[]).includes(value)
}

/** 某工具属于哪个集合（`/tool ele` 分组用）；不在目录里返回 null */
export function askToolSetOf(name: string): AskToolSet | null {
  return ASK_TOOL_SETS.find((set) => (set.tools as readonly string[]).includes(name)) ?? null
}

/** 这组工具里有没有屏幕记忆（决定 `<now>` 要不要写数据边界 / 最近段） */
export function hasScreenTools(tools: readonly string[]): boolean {
  return tools.some((name) => (ASK_TOOL_SCREEN_NAMES as readonly string[]).includes(name))
}

/** 这组工具里有没有日记（决定要不要接日记后端、开场「想到的」） */
export function hasDiaryTools(tools: readonly string[]): boolean {
  return tools.some((name) => (ASK_TOOL_DIARY_NAMES as readonly string[]).includes(name))
}

/** 这组工具里有没有信（决定 `<now>` 要不要报未读数、要不要接 letters 后端） */
export function hasLetterTools(tools: readonly string[]): boolean {
  return tools.some((name) => (ASK_TOOL_LETTER_NAMES as readonly string[]).includes(name))
}

/**
 * 规范化一份工具列表：不认识的丢掉、去重、按目录顺序排。
 * 家谱里存的是名字数组，读的时候一律过这里（旧 / 手改的文件不会把怪名字发给模型）。
 */
export function normalizeAskTools(raw: readonly unknown[]): AskToolName[] {
  const wanted = new Set<string>()
  for (const item of raw) {
    if (typeof item === 'string' && isAskToolName(item)) wanted.add(item)
  }
  return ASK_TOOL_NAMES.filter((name) => wanted.has(name))
}

/**
 * 分支的默认工具集：
 * - persona / life：全开（D62「问记忆」的老行为，别让老节点的日常提问突然查不到东西）；
 * - assistant：全关（档位定义就是「纯模型」；要工具由用户 `/tool add`）。
 */
export function defaultToolsForBranchKind(
  kind: 'persona' | 'assistant' | 'life'
): AskToolName[] {
  return kind === 'assistant' ? [] : [...ASK_TOOL_NAMES]
}
