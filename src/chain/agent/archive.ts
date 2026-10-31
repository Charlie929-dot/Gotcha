/**
 * 归档附件（D88，2026-10-31）
 *
 * 图片只在「发出去的那一轮」有意义：下一轮再原样重发，既贵又没必要。
 * 这里给出两件事：
 *
 * - **id**：图片 / 文本按内容取哈希（前 8 位 hex）——同一张图在同一会话里 id 永远一样，
 *   历史轮次和 `recall` 取回都对得上；
 * - **占位符**：历史轮次里把图换成一两行字，模型需要看原图时用 `recall` 取回。
 *
 * 只做纯函数，不碰存储、不发请求；`assets/` 里的原图照旧保留（`/log` 能看）。
 *
 * D89（2026-10-31）把同一套口径推到**工具结果**：历史轮次的工具结果（读段正文、
 * 检索命中、日记全文…）下一轮也换成一两行字——记忆会模糊，想再看就 `recall`。
 * `error` 例外：那是「你刚才做错了」的反馈，模糊掉会重复犯错，而且都很短。
 */
import { createHash } from 'node:crypto'

/** 归档 id 的长度（sha256 前 8 位 hex；够 40 亿张不撞，也短到不占话） */
const ARCHIVE_ID_CHARS = 8

const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i

/** 图片 data URL → 归档 id；不是合法 data URL 返回 null */
export function archiveIdOfImage(dataUrl: string): string | null {
  const matched = IMAGE_DATA_URL_RE.exec(dataUrl.trim())
  if (matched === null) return null
  try {
    const bytes = Buffer.from(matched[1], 'base64')
    if (bytes.length === 0) return null
    return createHash('sha256').update(bytes).digest('hex').slice(0, ARCHIVE_ID_CHARS)
  } catch {
    return null
  }
}

/** 文本（附件正文）→ 归档 id */
export function archiveIdOfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, ARCHIVE_ID_CHARS)
}

/** 历史轮次里的图片占位符（模型据此知道「有张图，需要就 recall」） */
export function imagePlaceholder(id: string): string {
  return `[图片 #${id} 已归档，需要看原图用 recall({ id: "${id}" })]`
}

/** 历史轮次里的文本附件占位符 */
export function filePlaceholder(name: string, id: string): string {
  return `[文件 ${name} #${id} 已归档，需要读正文用 recall({ id: "${id}" })]`
}

/** 归档里的一条：图片（data URL，最多拿一张）、文本文件正文（D88）或工具结果（D89） */
export interface RecalledAttachment {
  id: string
  /** image = 取回原图；file = 用户附件正文；tool = 历史工具结果的原文（JSON） */
  media: 'image' | 'file' | 'tool'
  /** media=image 时给原图 data URL */
  images?: readonly string[]
  /** media=file / tool 时给正文 */
  text?: string
  /** 原始文件名 / 工具名（有就带上） */
  name?: string
  /** 这一条在历史里长什么样（`#id 用 X 查看了…`）；recall 回显用，防止模型看到陌生的自己 */
  label?: string
}

/** 模型给的 id 可能是 `#a1b2c3d4` 或带引号：归一成 8 位 hex，不合法返回 null */export function normalizeArchiveId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["'#\s]+|["'\s]+$/gu, '').toLowerCase()
  if (trimmed === '') return null
  // 只认 hex；长度不卡死（以后可能换成更长的 id），但至少 4 位
  if (!/^[a-f0-9]{4,64}$/u.test(trimmed)) return null
  return trimmed
}

/**
 * 同一条记忆被 `recall` 多少次之后不再模糊（D89，拍板人 2026-10-31 定）。
 * 反复取回同一条，说明它真的重要：从第 `LIMIT + 1` 次回想起，那次的结果不再占位，
 * 原文直接留在上下文里；更早的回显与原始占位符都不动（字节稳定，缓存不失效）。
 */
export const RECALL_PLACEHOLDER_LIMIT = 5

/** 工具结果的归档 id：整条结果的内容哈希（同一段记忆每次算出来一样，跨轮 / recall 都对得上） */
export function archiveIdOfToolResult(result: unknown): string {
  const json = JSON.stringify(result) ?? ''
  return createHash('sha256').update(json, 'utf8').digest('hex').slice(0, ARCHIVE_ID_CHARS)
}

/** 工具结果的 id：`recall` 回指的永远是原文那条记忆，所以沿用它的 id（不再套一层新 id） */
export function archiveIdOfTurnResult(tool: string, result: Record<string, unknown>): string {
  const recalled = result['id']
  if (tool === 'recall' && typeof recalled === 'string' && recalled !== '') return recalled
  return archiveIdOfToolResult(result)
}

/** 占位符里「看了什么」的那半句 + id（不含方括号）：recall 回显也是这一行 */
export function toolResultLabel(
  id: string,
  tool: string,
  args?: Record<string, unknown>,
  result?: Record<string, unknown>
): string {
  return `#${id} ${toolResultDescription(tool, args ?? {}, result ?? {})}`
}

/** 历史轮次里的工具结果占位符（模型据此知道「这条我看过，内容大概是那个」） */
export function toolResultPlaceholder(
  id: string,
  tool: string,
  args?: Record<string, unknown>,
  result?: Record<string, unknown>
): string {
  return `[${toolResultLabel(id, tool, args, result)}]`
}

/**
 * `recall` 自己的结果在后续轮次里的占位（D89）。
 * 必须说明「回想的是哪一段」——只写「又模糊了」等于让模型看到一个陌生的自己，它只会再查一次。
 */
export function recallPlaceholder(id: string, label?: string): string {
  const body = label === undefined || label.trim() === '' ? `#${id} 的内容` : label.trim()
  return `[回忆了 ${body}]`
}

/** 一句话说明「用这个工具看了什么」；取不到具体目标就退成一句模糊的 */
function toolResultDescription(
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>
): string {
  const titled = textOf(result['title']).slice(0, 60)
  const app = textOf(result['app']).slice(0, 40)
  const keywords = textOf(args['keywords']).slice(0, 40)
  const semantic = textOf(args['semantic']).slice(0, 40)
  const day = textOf(result['day']).slice(0, 20)
  switch (tool) {
    case 'read_segment':
      if (titled !== '' && app !== '') return `用 read_segment 查看了《${titled}》（${app}）的内容`
      if (titled !== '') return `用 read_segment 查看了《${titled}》的内容`
      if (app !== '') return `用 read_segment 查看了 ${app} 里的内容`
      return '用 read_segment 打开了一段'
    case 'search_info': {
      const words = keywords !== '' ? keywords : semantic
      return words === ''
        ? '用 search_info 检索了屏幕记忆'
        : `用 search_info 检索了「${words}」的结果`
    }
    case 'ask_history':
      return keywords === ''
        ? '用 ask_history 查了问答记录'
        : `用 ask_history 查了「${keywords}」相关的问答记录`
    case 'recall_diary':
      return keywords === ''
        ? '用 recall_diary 检索了日记'
        : `用 recall_diary 检索了「${keywords}」的日记`
    case 'read_diary':
      return day === '' ? '用 read_diary 打开了一天的日记' : `用 read_diary 打开了 ${day} 的日记`
    case 'memory_profile':
      return '用 memory_profile 看了「关于我」的统计'
    case 'list_letter':
      return '用 list_letter 看了信列表'
    case 'read_letter': {
      const id = textOf(result['id']).slice(0, 40)
      return id === '' ? '用 read_letter 读了一封信' : `用 read_letter 读了信 #${id}`
    }
    default:
      return `用 ${tool} 做了一件事`
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
