/**
 * QQ 通道 · 图片（D63 追加，2026-10-30）
 *
 * 只做「把 NapCat 给的图片变成 data URL」这一件事：
 * - 优先用 `get_image` 返回的 base64（不额外下载、无 SSRF）；
 * - 没有 base64 才退到 `url` 下载（15s 超时、6MB 上限、只认 http/https）。
 *
 * 纪律：
 * - 图片只当轮送模型，**不落盘**；
 * - 失败返回 null，调用方只按文字继续（占位符还在，模型知道这里本来有张图）；
 * - 日志只记计数，不记文件 id / url。
 */

import { Buffer } from 'node:buffer'

/**
 * 单张图片原始字节上限：4MB。
 * base64 后约 5.3MB，低于附件协议 6MB data URL 上限（`guardAttachImages`），不会被二次拒。
 */
export const QQ_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** 下载 url 的总超时 */
export const QQ_IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000

/** 从文件头判断图片类型；不认识的返回 null */
export function imageMimeOf(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * base64（可带 `data:image/...;base64,` 前缀）→ data URL。
 * 只认 png / jpeg / webp / gif；超 6MB 或空内容返回 null。
 */
export function imageDataUrlFromBase64(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const prefixed = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/is.exec(trimmed)
  const base64 = prefixed ? prefixed[2] : trimmed
  if (base64 === '') return null
  // 粗算：base64 长度 ≈ 4/3 原始字节；超上限直接拒，不先解码
  if (base64.length > Math.ceil((QQ_IMAGE_MAX_BYTES * 4) / 3) + 16) return null
  let buffer: Buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (buffer.length === 0 || buffer.length > QQ_IMAGE_MAX_BYTES) return null
  const mime = imageMimeOf(buffer) ?? (prefixed ? prefixed[1].toLowerCase() : null)
  if (mime === null) return null
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/** 下载兜底：只认 http/https，超时 / 超限 / 非图片都返回 null */
export async function downloadImageAsDataUrl(  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? QQ_IMAGE_DOWNLOAD_TIMEOUT_MS)
  const maxBytes = Math.max(1, options.maxBytes ?? QQ_IMAGE_MAX_BYTES)
  try {
    const response = await fetch(parsed, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return null
    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!type.startsWith('image/')) return null
    const length = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(length) && length > maxBytes) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > maxBytes) return null
    const mime = imageMimeOf(buffer)
    if (mime === null) return null
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 文件（D88，2026-10-31）：QQ 里以「文件」发来的图片 / 文本
 *
 * 实测：同一张图用「图片」发它就看得见，用「文件」发只留一个 `[文件]` 占位符。
 * 这里补一条兜底——按扩展名认出图片就取字节当图、认出文本就取正文当附件，
 * 都不是就只留占位符（模型会知道「这里有个东西，我没拿到内容」）。
 * ------------------------------------------------------------------ */

/** 单文件字节上限（与图片同口径） */
export const QQ_FILE_MAX_BYTES = 4 * 1024 * 1024
/** 文本文件最多取多少字（送云前附件协议还会再截断一次） */
export const QQ_TEXT_MAX_CHARS = 30_000

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const
const TEXT_EXTS = [
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonl',
  '.csv',
  '.log',
  '.yml',
  '.yaml',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.py',
  '.html',
  '.css',
  '.xml',
  '.ini',
  '.toml'
] as const

function extOf(name: string): string {
  const base = name.trim().toLowerCase().split(/[\\/]/u).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** 这个文件名像不像图片 */
export function isImageFile(name: string): boolean {
  return (IMAGE_EXTS as readonly string[]).includes(extOf(name))
}

/** 这个文件名像不像文本 */
export function isTextFile(name: string): boolean {
  return (TEXT_EXTS as readonly string[]).includes(extOf(name))
}

/** 字节 → 图片 data URL（按文件头认类型；不是图返回 null） */
export function imageDataUrlFromBytes(buffer: Buffer): string | null {
  if (buffer.length === 0 || buffer.length > QQ_IMAGE_MAX_BYTES) return null
  const mime = imageMimeOf(buffer)
  if (mime === null) return null
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/** 字节 → 文本（UTF-8；去 BOM；乱码太多就当不是文本；超上限截断并标注） */
export function textFromBytes(buffer: Buffer, maxChars = QQ_TEXT_MAX_CHARS): string | null {
  if (buffer.length === 0) return null
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const sample = text.slice(0, 4_000)
  const broken = (sample.match(/\uFFFD/gu) ?? []).length
  if (broken / Math.max(1, sample.length) > 0.1) return null
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n…（后面还有 ${text.length - maxChars} 字，已截断）`
    : text
}

/** 下载任意文件字节：只认 http/https，超时 / 超限返回 null（SSRF 口径与图片一致） */
export async function downloadFileBytes(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<Buffer | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? QQ_IMAGE_DOWNLOAD_TIMEOUT_MS)
  const maxBytes = Math.max(1, options.maxBytes ?? QQ_FILE_MAX_BYTES)
  try {
    const response = await fetch(parsed, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return null
    const length = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(length) && length > maxBytes) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > maxBytes) return null
    return buffer
  } catch {
    return null
  }
}
