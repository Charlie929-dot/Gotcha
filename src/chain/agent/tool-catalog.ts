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
 * `give_birth` 是生命周期工具（persona 分支常驻，生命用过 15% 起可调用），不进目录、不给 /tool 管。
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
/** 任务记忆（自调用 v0.2 §6）：共建计划与自主任务共用一张表，`origin` 区分 */
export const ASK_TOOL_TASK_NAMES = [
  'schedule_task',
  'search_tasks',
  'update_task',
  'cancel_task'
] as const
/** 小本本（自调用 v0.2 §7 / §12.2）：自己的当前理解，增改删都走这一个工具 */
export const ASK_TOOL_NOTEBOOK_NAMES = ['update_notebook'] as const
/** 成长档案（自调用 v0.2 §8 / §12.3）：ta 自己的日记 / 周记，一天 / 一周一篇 */
export const ASK_TOOL_GROWTH_NAMES = ['write_growth'] as const

/**
 * QQ 专属工具（D96 / PR1–PR2）：只在 QQ 通道挂载，**不进** `ASK_TOOL_NAMES` 与分支
 * `/tool` 白名单——桌面看不到，也不会被 `/tool` 改动。
 */
export const QQ_TOOL_NAMES = ['quote_message', 'send_sticker', 'save_sticker', 'send_image'] as const
export type QqToolName = (typeof QQ_TOOL_NAMES)[number]
export const QQ_TOOL_LABELS: Readonly<Record<QqToolName, string>> = {
  quote_message: '引用这次聊天里的一条消息再回答（消息短号）',
  send_sticker: '发一张表情包（不带 id 只看图鉴）',
  save_sticker: '把这次收到 / 看到的图收进表情包',
  send_image: '把这次会话里的一张图发给对方'
}

export type AskToolName =
  | (typeof ASK_TOOL_SCREEN_NAMES)[number]
  | (typeof ASK_TOOL_DIARY_NAMES)[number]
  | (typeof ASK_TOOL_LETTER_NAMES)[number]
  | (typeof ASK_TOOL_TASK_NAMES)[number]
  | (typeof ASK_TOOL_NOTEBOOK_NAMES)[number]
  | (typeof ASK_TOOL_GROWTH_NAMES)[number]

export const ASK_TOOL_SETS: readonly AskToolSet[] = [
  { id: 'screen', label: '屏幕记忆', tools: [...ASK_TOOL_SCREEN_NAMES] },
  { id: 'diary', label: '日记', tools: [...ASK_TOOL_DIARY_NAMES] },
  { id: 'letter', label: '信', tools: [...ASK_TOOL_LETTER_NAMES] },
  { id: 'task', label: '任务', tools: [...ASK_TOOL_TASK_NAMES] },
  { id: 'notebook', label: '小本本', tools: [...ASK_TOOL_NOTEBOOK_NAMES] },
  { id: 'growth', label: '成长档案', tools: [...ASK_TOOL_GROWTH_NAMES] }
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
  read_letter: '读一封信（不传 id = 最新未读）',
  schedule_task: '记下一个计划或自己想做的事（到点会被叫醒）',
  search_tasks: '查任务：未完成 / 某一天 / 往后 / 按事项关键词',
  update_task: '改一条任务的时间 / 说明 / 重复 / 交付方式',
  cancel_task: '取消一条任务',
  update_notebook: '改自己的小本本：补一条 / 修正 / 放下（编号在小本本里）',
  write_growth: '写日记 / 周记 / 月末总结 / 年终总结（写进自己的成长档案）'
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

/** 这组工具里有没有任务工具（决定要不要接任务后端） */
export function hasTaskTools(tools: readonly string[]): boolean {
  return tools.some((name) => (ASK_TOOL_TASK_NAMES as readonly string[]).includes(name))
}

/** 这组工具里有没有小本本工具（决定要不要接小本本后端） */
export function hasNotebookTools(tools: readonly string[]): boolean {
  return tools.some((name) => (ASK_TOOL_NOTEBOOK_NAMES as readonly string[]).includes(name))
}

/** 这组工具里有没有成长档案工具（决定要不要接成长档案后端） */
export function hasGrowthTools(tools: readonly string[]): boolean {
  return tools.some((name) => (ASK_TOOL_GROWTH_NAMES as readonly string[]).includes(name))
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
