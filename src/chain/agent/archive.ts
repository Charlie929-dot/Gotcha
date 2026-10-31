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

/** 归档里的一条：图片（data URL，最多拿一张）或文本文件正文 */
export interface RecalledAttachment {
  id: string
  media: 'image' | 'file'
  /** media=image 时给原图 data URL */
  images?: readonly string[]
  /** media=file 时给正文 */
  text?: string
  /** 原始文件名（有就带上） */
  name?: string
}

/** 模型给的 id 可能是 `#a1b2c3d4` 或带引号：归一成 8 位 hex，不合法返回 null */export function normalizeArchiveId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["'#\s]+|["'\s]+$/gu, '').toLowerCase()
  if (trimmed === '') return null
  // 只认 hex；长度不卡死（以后可能换成更长的 id），但至少 4 位
  if (!/^[a-f0-9]{4,64}$/u.test(trimmed)) return null
  return trimmed
}
