/**
 * QQ 通道 · 表情包池（D96 / PR2）
 *
 * 一本**本机**的表情相册：用户导入的、ta 自己收藏的，都落在
 * `<userData>/qq/stickers/`，用一份 `index.json` 记住每张的标签 / 描述 / 用过几次。
 *
 * 为什么要落盘而不是只放内存：表情要跨重启（今天收藏的，明天还能发）；
 * 图鉴要能按标签找（ta 挑图靠 `label` / `desc`，不是靠字节）。
 *
 * 目录：
 * ```
 * index.json
 * library/<id>.<ext>    正式收藏
 * candidate/<id>.<ext>  顺手收的、还没整理的（可选层）
 * trash/<id>.<ext>      回收站（软删；满 50 张按最旧物理删）
 * ```
 *
 * 纪律：
 * - 只收 png / jpg / gif / webp，单张 ≤2MB；GIF 原样保留（重编码会把动图变静图）；
 * - `id` = 图片字节 SHA-256 前 12 位：同一张图永远同一个 id，天然去重；
 * - 上限 library 200 / candidate 100 / trash 50 / 总 50MB；超上限**只软删进回收站**，
 *   只有回收站超限才物理删；总容量不够时如实拒绝新图，不偷偷删用户的收藏；
 * - 只在本机：文件不进 git、不进日志正文、不出网（发送是通道的事）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { imageMimeOf } from './media'

/** 表情所在的层 */
export type QqStickerLayer = 'library' | 'candidate' | 'trash'
/** 只收这四种（NapChat 发送也认这四种） */
export type QqStickerExt = 'png' | 'jpg' | 'gif' | 'webp'

/** index.json 里的一条（同时也是给界面 / 模型看的视图） */
export interface QqStickerEntry {
  /** 图片字节 SHA-256 前 12 位 */
  id: string
  layer: QqStickerLayer
  /** 完整 sha256（校验 / 将来换算法时用；不进上下文） */
  hash: string
  ext: QqStickerExt
  bytes: number
  /** 标签：ta / 用户起的一句话（≤20 字） */
  label: string
  /** 描述：什么时候用（≤100 字） */
  desc: string
  tags: readonly string[]
  useCount: number
  addedAt: number
  lastUsedAt: number
}

export interface QqStickerStoreOptions {
  /** 池根目录（`<userData>/qq/stickers`） */
  root: string
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
  now?: () => number
  maxLibrary?: number
  maxCandidate?: number
  maxTrash?: number
  maxTotalBytes?: number
  maxFileBytes?: number
}

/** 单张上限：2MB（表情不需要更大；大了发出去也慢） */
export const QQ_STICKER_MAX_FILE_BYTES = 2 * 1024 * 1024
/** 各层条目上限 */
export const QQ_STICKER_MAX_LIBRARY = 200
export const QQ_STICKER_MAX_CANDIDATE = 100
export const QQ_STICKER_MAX_TRASH = 50
/** 整个池的字节上限：50MB */
export const QQ_STICKER_MAX_TOTAL_BYTES = 50 * 1024 * 1024
/** 标签 / 描述长度上限（模型与界面共用同一口径） */
export const QQ_STICKER_LABEL_MAX_CHARS = 20
export const QQ_STICKER_DESC_MAX_CHARS = 100
/** 图鉴一次最多列几条（`send_sticker` 不带 id 时给模型看的规模） */
export const QQ_STICKER_CATALOG_MAX = 40

const INDEX_VERSION = 1

const EXT_OF_MIME: Readonly<Record<string, QqStickerExt>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/** 扩展名 → MIME（界面 `<img>` 的 data URL 用） */
export function mimeOfStickerExt(ext: QqStickerExt): string {
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

/** 字节 → 表情条目要的扩展名；不是这四种返回 null */
export function stickerExtOfBytes(bytes: Buffer): QqStickerExt | null {
  const mime = imageMimeOf(bytes)
  return mime === null ? null : (EXT_OF_MIME[mime] ?? null)
}

/** 截断到字数上限（不劈坏 emoji） */
function clipChars(text: string, maxChars: number): string {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim())
  return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('')
}

/** 一组标签：去空、去重、最多 8 个、每个 ≤12 字 */
function normalizeTags(raw: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const item of raw ?? []) {
    if (typeof item !== 'string') continue
    const tag = clipChars(item, 12)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= 8) break
  }
  return out
}

function isLayer(value: unknown): value is QqStickerLayer {
  return value === 'library' || value === 'candidate' || value === 'trash'
}

function positiveInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : NaN
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback
}

export interface QqStickerAddInput {
  bytes: Buffer
  /** 标签（必填；ta 收藏时自己写，界面导入时用户写） */
  label: string
  desc?: string
  tags?: readonly string[]
  /** 默认进正式收藏 */
  layer?: QqStickerLayer
}

export type QqStickerAddResult =
  | { ok: true; entry: QqStickerEntry; duplicate: boolean }
  | { ok: false; error: string }

/**
 * 本机表情包池。同步读写（表情是小文件、操作不频繁），不做后台队列。
 */
export class QqStickerStore {
  private readonly root: string
  private readonly log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
  private readonly now: () => number
  private readonly maxLibrary: number
  private readonly maxCandidate: number
  private readonly maxTrash: number
  private readonly maxTotalBytes: number
  private readonly maxFileBytes: number
  /** id → 条目（含回收站里的） */
  private entries = new Map<string, QqStickerEntry>()
  private loaded = false

  constructor(options: QqStickerStoreOptions) {
    this.root = options.root
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.maxLibrary = Math.max(1, Math.trunc(options.maxLibrary ?? QQ_STICKER_MAX_LIBRARY))
    this.maxCandidate = Math.max(1, Math.trunc(options.maxCandidate ?? QQ_STICKER_MAX_CANDIDATE))
    this.maxTrash = Math.max(1, Math.trunc(options.maxTrash ?? QQ_STICKER_MAX_TRASH))
    this.maxTotalBytes = Math.max(1, Math.trunc(options.maxTotalBytes ?? QQ_STICKER_MAX_TOTAL_BYTES))
    this.maxFileBytes = Math.max(1, Math.trunc(options.maxFileBytes ?? QQ_STICKER_MAX_FILE_BYTES))
  }

  /** 池根目录（诊断用；不要把文件内容打出来） */
  path(): string {
    return this.root
  }

  /** 收一张图：同图去重（返回已有 id），超上限按最旧软删 */
  add(input: QqStickerAddInput): QqStickerAddResult {
    this.ensureLoaded()
    const bytes = input.bytes
    if (bytes.length === 0) return { ok: false, error: '这张图是空的' }
    if (bytes.length > this.maxFileBytes) {
      return {
        ok: false,
        error: `图太大了（${Math.round(bytes.length / 1024)}KB，单张最多 ${Math.round(this.maxFileBytes / 1024)}KB）`
      }
    }
    const ext = stickerExtOfBytes(bytes)
    if (ext === null) return { ok: false, error: '只收 png / jpg / gif / webp' }
    const label = clipChars(input.label, QQ_STICKER_LABEL_MAX_CHARS)
    if (label === '') return { ok: false, error: '要起个标签（≤20 字），以后挑图就看它' }
    const layer = input.layer ?? 'library'
    const hash = createHash('sha256').update(bytes).digest('hex')
    const id = hash.slice(0, 12)
    const desc = clipChars(input.desc ?? '', QQ_STICKER_DESC_MAX_CHARS)
    const tags = normalizeTags(input.tags)
    const at = this.now()

    const existing = this.entries.get(id)
    if (existing !== undefined) {
      // 同一张图只存一份：把新标签 / 描述贴上去，回收站里的顺手捞回来
      const next: QqStickerEntry = {
        ...existing,
        layer: existing.layer === 'trash' ? layer : existing.layer,
        label: label !== '' ? label : existing.label,
        desc: desc !== '' ? desc : existing.desc,
        tags: tags.length > 0 ? tags : existing.tags,
        bytes: bytes.length
      }
      this.entries.set(id, next)
      this.writeFileOf(next, bytes)
      this.persist()
      return { ok: true, entry: next, duplicate: true }
    }

    // 总容量：先清回收站；还放不下就如实拒绝（不删用户收藏）
    if (this.totalBytes() + bytes.length > this.maxTotalBytes) {
      this.purgeTrashUntil(this.maxTotalBytes - bytes.length)
      if (this.totalBytes() + bytes.length > this.maxTotalBytes) {
        return { ok: false, error: '表情包池满了（总上限 50MB）：先删几张再收' }
      }
    }

    const entry: QqStickerEntry = {
      id,
      layer,
      hash,
      ext,
      bytes: bytes.length,
      label,
      desc,
      tags,
      useCount: 0,
      addedAt: at,
      lastUsedAt: 0
    }
    this.writeFileOf(entry, bytes)
    this.entries.set(id, entry)
    this.enforceLayerLimits()
    this.persist()
    return { ok: true, entry, duplicate: false }
  }

  /** 全部条目；给 layer 就只要那一层。默认按「用过几次 / 最近用过」排（图鉴把常用的放前面） */
  list(layer?: QqStickerLayer): QqStickerEntry[] {
    this.ensureLoaded()
    const all = [...this.entries.values()].filter(
      (entry) => layer === undefined || entry.layer === layer
    )
    return all.sort((a, b) => {
      if (b.useCount !== a.useCount) return b.useCount - a.useCount
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt
      return b.addedAt - a.addedAt
    })
  }

  /** 只列正式收藏（图鉴口径；回收站与候选层不发给模型挑） */
  catalog(limit = QQ_STICKER_CATALOG_MAX): QqStickerEntry[] {
    return this.list('library').slice(0, Math.max(1, Math.trunc(limit)))
  }

  get(id: string): QqStickerEntry | null {
    this.ensureLoaded()
    return this.entries.get(id.trim()) ?? null
  }

  /** 读字节（发图 / 界面缩略图用）；文件丢了按 null（不假装还在） */
  read(id: string): { entry: QqStickerEntry; bytes: Buffer } | null {
    const entry = this.get(id)
    if (entry === null) return null
    try {
      const bytes = readFileSync(this.fileOf(entry))
      if (bytes.length === 0) return null
      return { entry, bytes }
    } catch {
      return null
    }
  }

  /** 记一次「用过」：`send_sticker` 挑中时调用（挑中就算，不等发送结果） */
  touch(id: string): QqStickerEntry | null {
    const entry = this.get(id)
    if (entry === null) return null
    const next: QqStickerEntry = {
      ...entry,
      useCount: entry.useCount + 1,
      lastUsedAt: this.now()
    }
    this.entries.set(entry.id, next)
    this.persist()
    return next
  }

  /** 改标签 / 描述 / 标签组（界面与 ta 都能改） */
  update(
    id: string,
    patch: { label?: string; desc?: string; tags?: readonly string[] }
  ): { ok: true; entry: QqStickerEntry } | { ok: false; error: string } {
    const entry = this.get(id)
    if (entry === null) return { ok: false, error: '没有这张表情' }
    const label = patch.label === undefined ? entry.label : clipChars(patch.label, QQ_STICKER_LABEL_MAX_CHARS)
    if (label === '') return { ok: false, error: '标签不能为空' }
    const next: QqStickerEntry = {
      ...entry,
      label,
      desc: patch.desc === undefined ? entry.desc : clipChars(patch.desc, QQ_STICKER_DESC_MAX_CHARS),
      tags: patch.tags === undefined ? entry.tags : normalizeTags(patch.tags)
    }
    this.entries.set(entry.id, next)
    this.persist()
    return { ok: true, entry: next }
  }

  /** 换层：移入回收站 / 从回收站还原 / 放进候选层 */
  move(id: string, layer: QqStickerLayer): { ok: true; entry: QqStickerEntry } | { ok: false; error: string } {
    const entry = this.get(id)
    if (entry === null) return { ok: false, error: '没有这张表情' }
    if (entry.layer === layer) return { ok: true, entry }
    const next: QqStickerEntry = { ...entry, layer }
    const bytes = this.readBytesOrNull(entry)
    if (bytes === null) {
      // 文件没了：只把索引挪过去没有意义
      this.entries.delete(entry.id)
      this.persist()
      return { ok: false, error: '这张表情的文件找不到了，已从图鉴里清掉' }
    }
    this.entries.set(entry.id, next)
    this.writeFileOf(next, bytes)
    this.removeFileOf(entry)
    this.enforceLayerLimits()
    this.persist()
    return { ok: true, entry: this.entries.get(entry.id) ?? next }
  }

  /** 彻底删（物理删文件；界面「彻底删」按钮） */
  remove(id: string): boolean {
    const entry = this.get(id)
    if (entry === null) return false
    this.removeFileOf(entry)
    this.entries.delete(entry.id)
    this.persist()
    return true
  }

  /** 池子现状（界面一行字：几张、多少 MB） */
  stats(): { library: number; candidate: number; trash: number; bytes: number } {
    this.ensureLoaded()
    const counts = { library: 0, candidate: 0, trash: 0 }
    let bytes = 0
    for (const entry of this.entries.values()) {
      counts[entry.layer] += 1
      bytes += entry.bytes
    }
    return { ...counts, bytes }
  }
  /** 立即写索引（退出 / 测试用） */
  flush(): void {
    this.persist()
  }

  dispose(): void {
    this.flush()
  }

  /* ------------------------------------------------------------------ */

  private fileOf(entry: QqStickerEntry): string {
    return join(this.root, entry.layer, `${entry.id}.${entry.ext}`)
  }

  private readBytesOrNull(entry: QqStickerEntry): Buffer | null {
    try {
      return readFileSync(this.fileOf(entry))
    } catch {
      return null
    }
  }

  private writeFileOf(entry: QqStickerEntry, bytes: Buffer): void {
    const file = this.fileOf(entry)
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, bytes)
    } catch (error) {
      this.log('warn', 'qq sticker write failed', { error: String(error) })
    }
  }

  private removeFileOf(entry: QqStickerEntry): void {
    try {
      rmSync(this.fileOf(entry), { force: true })
    } catch {
      // 删不掉就算了：索引里已经不指向它，下次按最旧淘汰时会再试
    }
  }

  private totalBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.bytes
    return total
  }

  /**
   * 某一层超上限：最旧的软删进回收站（用户在界面能还原）；
   * 回收站本身超限才物理删。顺序固定：先收 library / candidate，最后收 trash。
   */
  private enforceLayerLimits(): void {
    this.evictLayer('library', this.maxLibrary, 'trash')
    this.evictLayer('candidate', this.maxCandidate, 'trash')
    this.evictLayer('trash', this.maxTrash, 'delete')
  }

  private evictLayer(layer: QqStickerLayer, max: number, action: 'trash' | 'delete'): void {
    const items = [...this.entries.values()]
      .filter((entry) => entry.layer === layer)
      .sort((a, b) => a.addedAt - b.addedAt)
    let overflow = items.length - max
    for (const entry of items) {
      if (overflow <= 0) break
      if (action === 'delete') {
        this.removeFileOf(entry)
        this.entries.delete(entry.id)
      } else {
        const next: QqStickerEntry = { ...entry, layer: 'trash' }
        const bytes = this.readBytesOrNull(entry)
        if (bytes !== null) {
          this.entries.set(entry.id, next)
          this.writeFileOf(next, bytes)
          this.removeFileOf(entry)
        } else {
          this.entries.delete(entry.id)
        }
      }
      overflow -= 1
    }
  }

  /** 总容量不够时按最旧物理清回收站，直到回到 `budget` 以下（能清多少算多少） */
  private purgeTrashUntil(budget: number): void {
    if (this.totalBytes() <= budget) return
    let removed = false
    const trashed = [...this.entries.values()]
      .filter((entry) => entry.layer === 'trash')
      .sort((a, b) => a.addedAt - b.addedAt)
    for (const entry of trashed) {
      if (this.totalBytes() <= budget) break
      this.removeFileOf(entry)
      this.entries.delete(entry.id)
      removed = true
    }
    if (removed) this.persist()
  }

  private indexFile(): string {
    return join(this.root, 'index.json')
  }

  private persist(): void {
    const body = JSON.stringify({
      version: INDEX_VERSION,
      entries: [...this.entries.values()]
    })
    const file = this.indexFile()
    const tmp = `${file}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      this.log('warn', 'qq sticker index write failed', { error: String(error) })
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.indexFile(), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.log('warn', 'qq sticker index corrupt: unreadable json, starting empty')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.log('warn', 'qq sticker index corrupt: not an object, starting empty')
      return
    }
    const root = parsed as { version?: unknown; entries?: unknown }
    if (root.version !== INDEX_VERSION) {
      this.log('warn', 'qq sticker index version mismatch, starting empty', { version: root.version })
      return
    }
    if (!Array.isArray(root.entries)) return
    for (const item of root.entries as unknown[]) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const id = typeof row['id'] === 'string' ? row['id'].trim().toLowerCase() : ''
      if (!/^[a-f0-9]{12}$/u.test(id)) continue
      const layer = row['layer']
      if (!isLayer(layer)) continue
      const ext = row['ext']
      if (ext !== 'png' && ext !== 'jpg' && ext !== 'gif' && ext !== 'webp') continue
      const entry: QqStickerEntry = {
        id,
        layer,
        hash: typeof row['hash'] === 'string' ? row['hash'] : '',
        ext,
        bytes: positiveInt(row['bytes']),
        label: clipChars(typeof row['label'] === 'string' ? row['label'] : '', QQ_STICKER_LABEL_MAX_CHARS),
        desc: clipChars(typeof row['desc'] === 'string' ? row['desc'] : '', QQ_STICKER_DESC_MAX_CHARS),
        tags: normalizeTags(Array.isArray(row['tags']) ? (row['tags'] as string[]) : []),
        useCount: positiveInt(row['useCount']),
        addedAt: positiveInt(row['addedAt']),
        lastUsedAt: positiveInt(row['lastUsedAt'])
      }
      // 文件不在就当没这条（不把幽灵条目发给模型）
      if (this.readBytesOrNull(entry) === null) continue
      // 文件大小以磁盘为准（索引被手改过也不怕）
      try {
        entry.bytes = statSync(this.fileOf(entry)).size
      } catch {
        // ignore
      }
      this.entries.set(id, entry)
    }
    // 载入后按同一口径收敛一次（旧版本留下的超量 / 幽灵文件）
    this.enforceLayerLimits()
    this.persist()
  }
}

/* ------------------------------------------------------------------ */
/* 设置抽屉的视图（D96 / PR2）                                          */
/* ------------------------------------------------------------------ */

/** 缩略图只给「小图」：一次 IPC 别搬几十 MB */
export const QQ_STICKER_THUMB_MAX_BYTES = 256 * 1024
/** 最多给几张缩略图（其余的只列标签，点开才看图） */
export const QQ_STICKER_THUMB_MAX_ITEMS = 32

/** 界面里的一张表情（不含路径；缩略图是小图才有） */
export interface QqStickerListItem {
  id: string
  layer: QqStickerLayer
  label: string
  desc: string
  tags: readonly string[]
  bytes: number
  useCount: number
  addedAt: number
  /** `data:image/...;base64,...`（只有 ≤256KB 的前 32 张才有） */
  thumb?: string
}

export interface QqStickerListView {
  ok: true
  items: readonly QqStickerListItem[]
  stats: { library: number; candidate: number; trash: number; bytes: number }
}

/** 池子 → 设置抽屉视图：按常用度排，缩略图只给小的前几张 */
export function buildQqStickerListView(store: QqStickerStore): QqStickerListView {
  const all = store.list()
  const items: QqStickerListItem[] = []
  let thumbs = 0
  for (const entry of all) {
    let thumb: string | undefined
    if (thumbs < QQ_STICKER_THUMB_MAX_ITEMS && entry.bytes <= QQ_STICKER_THUMB_MAX_BYTES) {
      const found = store.read(entry.id)
      if (found !== null) {
        thumb = `data:${mimeOfStickerExt(found.entry.ext)};base64,${found.bytes.toString('base64')}`
        thumbs += 1
      }
    }
    items.push({
      id: entry.id,
      layer: entry.layer,
      label: entry.label,
      desc: entry.desc,
      tags: [...entry.tags],
      bytes: entry.bytes,
      useCount: entry.useCount,
      addedAt: entry.addedAt,
      ...(thumb !== undefined ? { thumb } : {})
    })
  }
  return { ok: true, items, stats: store.stats() }
}
