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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

/* ------------------------------------------------------------------ *
 * 出站图片（D96 / PR2）：ta 发出去的图 / 表情
 *
 * 口径（设计文档 §6.4）：长边 ≤1600、JPEG 85、≤3MB；GIF 且 ≤3MB 原样发（重编码会
 * 把动图变成静图）；不放大。重编码要 Electron 的 `nativeImage`（同步、在主进程），
 * 所以这里用注入的编码器：核心逻辑（要不要转、转完多大算超）纯函数，单测好跑。
 * ------------------------------------------------------------------ */

/** 出站图片长边上限 */
export const QQ_OUTBOUND_MAX_SIDE = 1600
/** 出站图片字节上限 */
export const QQ_OUTBOUND_MAX_BYTES = 3 * 1024 * 1024

/** 图片编码器（生产实现是 `nativeImage`；单测注入假的） */
export type QqImageEncoder = (input: {
  bytes: Buffer
  mime: string
  maxSide: number
}) => { bytes: Buffer; mime: string } | null

export type QqOutboundImage =
  | { ok: true; bytes: Buffer; mime: string; dataUrl: string }
  | { ok: false; error: string }

/**
 * 一张图 → 可以交给 QQ 的字节 / data URL。
 * - GIF：≤3MB 原样（保留动画）；超了就如实拒绝；
 * - 其它：有编码器就转（统一压到 ≤1600 / JPEG 85）；编码器失败或没接时，
 *   原图 ≤3MB 就照发（不因为一次转码失败把图吞掉），否则拒绝。
 */
export function prepareOutboundImage(bytes: Buffer, encoder?: QqImageEncoder): QqOutboundImage {
  if (bytes.length === 0) return { ok: false, error: '这张图是空的' }
  const mime = imageMimeOf(bytes)
  if (mime === null) return { ok: false, error: '这张图认不出来（只认 png / jpg / gif / webp）' }
  if (mime === 'image/gif') {
    if (bytes.length > QQ_OUTBOUND_MAX_BYTES) {
      return { ok: false, error: '动图太大了（超过 3MB），发不出去' }
    }
    return {
      ok: true,
      bytes,
      mime,
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}`
    }
  }
  let out = { bytes, mime }
  if (encoder !== undefined) {
    try {
      const encoded = encoder({ bytes, mime, maxSide: QQ_OUTBOUND_MAX_SIDE })
      if (encoded !== null && encoded.bytes.length > 0) out = encoded
    } catch {
      // 编码器抛错：按原图走，下面还有大小闸门
    }
  }
  if (out.bytes.length > QQ_OUTBOUND_MAX_BYTES) {
    return { ok: false, error: '这张图压到 3MB 还是太大，发不出去' }
  }
  const outMime = imageMimeOf(out.bytes) ?? out.mime
  return {
    ok: true,
    bytes: out.bytes,
    mime: outMime,
    dataUrl: `data:${outMime};base64,${out.bytes.toString('base64')}`
  }
}

/**
 * 发图闸门（D96 §6.4）：同一张表情 24h 内不连发；表情 / 图片各每日 ≤20。
 *
 * 计数落盘（`<userData>/qq/media-usage.json`）：重启不该把当天额度清零，
 * 否则「重启一下就能继续刷图」——那正是风控最烦的行为。
 * `allow()` 通过时**就地记一次**（返回 true 就算发出去要发了）；发送失败不再退额度，
 * 宁可少发，也不让计数跟真实发出量对不上。
 */
export interface QqMediaGateOptions {
  file: string
  now?: () => number
  /** 每天最多几张表情（默认 20） */
  stickerPerDay?: number
  /** 每天最多几张图片（默认 20） */
  imagePerDay?: number
  /** 同一张表情多久内不连发（默认 24h） */
  stickerRepeatMs?: number
  log?: (level: 'warn', message: string, data?: Record<string, unknown>) => void
}

export type QqMediaKind = 'sticker' | 'image'

export interface QqMediaGateView {
  /** 本地日期 `YYYY-MM-DD` */
  day: string
  stickers: number
  images: number
}

const MEDIA_GATE_VERSION = 1
const MEDIA_STICKER_HISTORY_MAX = 200

function dayKeyOf(at: number): string {
  const date = new Date(at)
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${date.getFullYear()}-${month < 10 ? `0${month}` : month}-${day < 10 ? `0${day}` : day}`
}

export class QqMediaGate {
  private readonly file: string
  private readonly now: () => number
  private readonly stickerPerDay: number
  private readonly imagePerDay: number
  private readonly stickerRepeatMs: number
  private readonly log: (level: 'warn', message: string, data?: Record<string, unknown>) => void
  private day: string
  private stickers = 0
  private images = 0
  /** 表情 id → 上次发出的时刻（跨重启保留，防「重启绕过 24h」） */
  private stickerLastAt = new Map<string, number>()
  private loaded = false

  constructor(options: QqMediaGateOptions) {
    this.file = options.file
    this.now = options.now ?? Date.now
    this.stickerPerDay = Math.max(0, Math.trunc(options.stickerPerDay ?? 20))
    this.imagePerDay = Math.max(0, Math.trunc(options.imagePerDay ?? 20))
    this.stickerRepeatMs = Math.max(0, Math.trunc(options.stickerRepeatMs ?? 24 * 60 * 60_000))
    this.log = options.log ?? (() => {})
    this.day = dayKeyOf(this.now())
  }

  /** 这张还能不能发；true 时顺手记一次额度 */
  allow(kind: QqMediaKind, ref?: string): boolean {
    this.ensureLoaded()
    const at = this.now()
    this.rollDay(at)
    if (kind === 'sticker') {
      if (this.stickers >= this.stickerPerDay) return false
      const id = typeof ref === 'string' ? ref.trim() : ''
      if (id !== '') {
        const last = this.stickerLastAt.get(id)
        if (last !== undefined && at - last < this.stickerRepeatMs) return false
        this.stickerLastAt.set(id, at)
        this.trimHistory()
      }
      this.stickers += 1
      this.persist()
      return true
    }
    if (this.images >= this.imagePerDay) return false
    this.images += 1
    this.persist()
    return true
  }

  view(): QqMediaGateView {
    this.ensureLoaded()
    this.rollDay(this.now())
    return { day: this.day, stickers: this.stickers, images: this.images }
  }

  flush(): void {
    this.persist()
  }

  dispose(): void {
    this.flush()
  }

  private rollDay(at: number): void {
    const day = dayKeyOf(at)
    if (day === this.day) return
    this.day = day
    this.stickers = 0
    this.images = 0
    this.persist()
  }

  private trimHistory(): void {
    if (this.stickerLastAt.size <= MEDIA_STICKER_HISTORY_MAX) return
    const sorted = [...this.stickerLastAt.entries()].sort((a, b) => a[1] - b[1])
    for (const [id] of sorted.slice(0, this.stickerLastAt.size - MEDIA_STICKER_HISTORY_MAX)) {
      this.stickerLastAt.delete(id)
    }
  }

  private persist(): void {
    const body = JSON.stringify({
      version: MEDIA_GATE_VERSION,
      day: this.day,
      stickers: this.stickers,
      images: this.images,
      stickerLastAt: Object.fromEntries(this.stickerLastAt)
    })
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('warn', 'qq media gate write failed', { error: String(error) })
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown
        day?: unknown
        stickers?: unknown
        images?: unknown
        stickerLastAt?: unknown
      }
      if (parsed.version !== MEDIA_GATE_VERSION) return
      if (typeof parsed.day !== 'string') return
      this.day = parsed.day
      this.stickers = typeof parsed.stickers === 'number' ? Math.max(0, Math.trunc(parsed.stickers)) : 0
      this.images = typeof parsed.images === 'number' ? Math.max(0, Math.trunc(parsed.images)) : 0
      if (typeof parsed.stickerLastAt === 'object' && parsed.stickerLastAt !== null) {
        for (const [id, at] of Object.entries(parsed.stickerLastAt as Record<string, unknown>)) {
          if (typeof at === 'number' && Number.isFinite(at)) this.stickerLastAt.set(id, at)
        }
      }
    } catch {
      this.log('warn', 'qq media gate corrupt: unreadable json, starting fresh')
    }
  }
}
