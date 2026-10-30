/**
 * 问记忆 · 会话存储（主进程，D64 / memory-life M1）
 *
 * 两套实现：
 * - `createAskConversationStore()`：纯内存（单测与「记忆仓不可用」的退化路径）；
 * - `createAskConversationFileStore()`：落 `memory-repo/conversations/<会话 id>.jsonl`，
 *   图片不进 JSONL 文本，而是按内容哈希存 `conversations/assets/<sha256>.<ext>` 二进制，
 *   读回来时再转 base64 data URL —— 仓里是二进制、发送时才是 base64，格式可换。
 *
 * 为什么图片不直接存 data URL：
 * - base64 比原始二进制大 33%，而且是每张图都重复存一遍；
 * - 内容哈希天然去重（同一张图贴两次只存一份），也不会在 diff 里滚出一屏字符。
 *
 * 纪律：
 * - 写文件「临时文件 + rename」原子替换；写失败只记日志，不影响这一轮回答；
 * - 读不到 / 结构不认识的行跳过并记日志，不让一个坏文件卡死整个会话；
 * - 图片找不到（仓被手改 / 资产被删）就丢掉这一张，文本照常回放——
 *   宁可少一张图，也不要因为缺资产整条会话加载失败。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  emptyAskConversation,
  type AskConversationPort,
  type CloudAskConversation,
  type CloudAskConversationTurn
} from '../chain/agent/conversation'
import type { CloudAskAttachments, CloudAskLoopTurn } from '../chain/agent/payload'

/** 同时保留多少个会话（桌面最近窗口 + QQ 白名单用户，32 足够） */
export const ASK_CONVERSATION_MAX_SESSIONS = 32

export type AskConversationLog = (
  level: 'warn',
  message: string,
  data?: Record<string, unknown>
) => void

/** 纯内存实现：单测默认，也是记忆仓不可用时的退化路径 */
export function createAskConversationStore(): AskConversationPort {
  let state: CloudAskConversation = emptyAskConversation()
  return {
    load: () => state,
    save: (next) => {
      state = { digest: next.digest, turns: [...next.turns] }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 落盘：JSONL + 图片二进制                                             */
/* ------------------------------------------------------------------ */

interface StoredMeta {
  v: 1
  digest: string
}

interface StoredTurn extends Omit<CloudAskConversationTurn, 'turns' | 'attachments'> {
  turns: StoredLoopTurn[]
  attachments?: { images: string[]; files: { name: string; text: string }[] }
}

type StoredLoopTurn = Omit<CloudAskLoopTurn, 'images'> & { images?: string[] }

const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i
const IMAGE_FORMATS: Record<string, { ext: string; mime: string }> = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
  gif: { ext: 'gif', mime: 'image/gif' }
}
const ASSET_REF_RE = /^assets\/([a-f0-9]{64})\.([a-z]+)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话 id → 文件名：只放行安全字符，其余按哈希落名（避免路径穿越） */
export function conversationFileName(conversationId: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) return conversationId
  const hash = createHash('sha1').update(conversationId).digest('hex').slice(0, 16)
  return `h-${hash}`
}

export function conversationFilePath(root: string, conversationId: string): string {
  return join(root, 'conversations', `${conversationFileName(conversationId)}.jsonl`)
}

function assetsDir(root: string): string {
  return join(root, 'conversations', 'assets')
}

/**
 * data URL → 仓里的资产引用。同一张图（同字节）只写一份。
 * 不是认识的 data URL（理论上游已过滤）就原样保留，宁大勿丢。
 */
function encodeImage(url: string, root: string, log?: AskConversationLog): string {
  const matched = IMAGE_DATA_URL_RE.exec(url)
  if (matched === null) return url
  const format = IMAGE_FORMATS[matched[1].toLowerCase()]
  if (format === undefined) return url
  try {
    const bytes = Buffer.from(matched[2], 'base64')
    if (bytes.length === 0) return url
    const hash = createHash('sha256').update(bytes).digest('hex')
    const dir = assetsDir(root)
    const target = join(dir, `${hash}.${format.ext}`)
    if (!existsSync(target)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(target, bytes)
    }
    return `assets/${hash}.${format.ext}`
  } catch (error) {
    log?.('warn', 'memory asset write failed', { error: String(error) })
    return url
  }
}

/** 资产引用 → data URL；读不到返回 null（这一张丢掉） */
function decodeImage(ref: string, root: string, log?: AskConversationLog): string | null {
  const matched = ASSET_REF_RE.exec(ref)
  if (matched === null) return null
  const ext = matched[2]
  const format = Object.values(IMAGE_FORMATS).find((item) => item.ext === ext)
  if (format === undefined) return null
  try {
    const bytes = readFileSync(join(root, 'conversations', matched[0]))
    return `data:${format.mime};base64,${bytes.toString('base64')}`
  } catch (error) {
    log?.('warn', 'memory asset missing', { error: String(error) })
    return null
  }
}

function encodeImages(images: readonly string[], root: string, log?: AskConversationLog): string[] {
  return images.map((url) => encodeImage(url, root, log))
}

function decodeImages(
  refs: readonly string[],
  root: string,
  log?: AskConversationLog
): string[] {
  const out: string[] = []
  for (const ref of refs) {
    const url = decodeImage(ref, root, log)
    if (url !== null) out.push(url)
  }
  return out
}

function encodeTurn(turn: CloudAskConversationTurn, root: string, log?: AskConversationLog): StoredTurn {
  const stored: StoredTurn = {
    question: turn.question,
    now: turn.now,
    turns: turn.turns.map((item) => {
      const { images, ...rest } = item
      return {
        ...rest,
        ...(images !== undefined && images.length > 0 ? { images: encodeImages(images, root, log) } : {})
      }
    }),
    answer: turn.answer
  }
  if (turn.attachments !== undefined && turn.attachments.images.length > 0) {
    const attachments: CloudAskAttachments = {
      images: encodeImages(turn.attachments.images, root, log),
      files: turn.attachments.files
    }
    stored.attachments = {
      images: [...attachments.images],
      files: attachments.files.map((file) => ({ name: file.name, text: file.text }))
    }
  } else if (turn.attachments !== undefined && turn.attachments.files.length > 0) {
    stored.attachments = { images: [], files: turn.attachments.files.map((file) => ({ ...file })) }
  }
  return stored
}

function decodeTurn(raw: unknown, root: string, log?: AskConversationLog): CloudAskConversationTurn | null {
  if (!isRecord(raw)) return null
  if (typeof raw.question !== 'string' || typeof raw.answer !== 'string') return null
  const now = typeof raw.now === 'string' ? raw.now : ''
  const turns: CloudAskLoopTurn[] = []
  if (Array.isArray(raw.turns)) {
    for (const item of raw.turns) {
      if (!isRecord(item)) continue
      const toolCall = isRecord(item.toolCall) ? item.toolCall : null
      if (toolCall === null || typeof toolCall.name !== 'string') continue
      if (!isRecord(item.toolResult)) continue
      const reasoning = typeof item.reasoning === 'string' && item.reasoning !== '' ? item.reasoning : undefined
      const refs = Array.isArray(item.images)
        ? item.images.filter((image): image is string => typeof image === 'string')
        : []
      const images = refs.length > 0 ? decodeImages(refs, root, log) : []
      turns.push({
        toolCall: {
          name: toolCall.name,
          arguments: isRecord(toolCall.arguments) ? toolCall.arguments : {}
        },
        toolResult: item.toolResult,
        ...(images.length > 0 ? { images } : {}),
        ...(reasoning !== undefined ? { reasoning } : {})
      })
    }
  }
  let attachments: CloudAskAttachments | undefined
  if (isRecord(raw.attachments)) {
    const refs = Array.isArray(raw.attachments.images)
      ? raw.attachments.images.filter((image): image is string => typeof image === 'string')
      : []
    const images = refs.length > 0 ? decodeImages(refs, root, log) : []
    const files: { name: string; text: string }[] = []
    if (Array.isArray(raw.attachments.files)) {
      for (const file of raw.attachments.files) {
        if (isRecord(file) && typeof file.name === 'string' && typeof file.text === 'string') {
          files.push({ name: file.name, text: file.text })
        }
      }
    }
    if (images.length > 0 || files.length > 0) attachments = { images, files }
  }
  return {
    question: raw.question,
    now,
    turns,
    answer: raw.answer,
    ...(attachments !== undefined ? { attachments } : {})
  }
}

function loadFromDisk(
  root: string,
  conversationId: string,
  log?: AskConversationLog
): CloudAskConversation {
  const file = conversationFilePath(root, conversationId)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return emptyAskConversation()
  }
  let digest = ''
  const turns: CloudAskConversationTurn[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      log?.('warn', 'memory conversation line skipped', { conversationId })
      continue
    }
    if (isRecord(parsed) && parsed.v === 1 && typeof parsed.digest === 'string') {
      digest = parsed.digest
      continue
    }
    const turn = decodeTurn(parsed, root, log)
    if (turn === null) {
      log?.('warn', 'memory conversation turn skipped', { conversationId })
      continue
    }
    turns.push(turn)
  }
  return { digest, turns }
}

function writeToDisk(
  root: string,
  conversationId: string,
  conversation: CloudAskConversation,
  log?: AskConversationLog
): void {
  const file = conversationFilePath(root, conversationId)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const meta: StoredMeta = { v: 1, digest: conversation.digest }
    const lines = [JSON.stringify(meta)]
    for (const turn of conversation.turns) {
      lines.push(JSON.stringify(encodeTurn(turn, root, log)))
    }
    const text = `${lines.join('\n')}\n`
    const tmp = `${file}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    log?.('warn', 'memory conversation write failed', { conversationId, error: String(error) })
  }
}

/** 文件实现：内存缓存 + 首次读盘 / 每次保存落盘 */
export function createAskConversationFileStore(options: {
  root: string
  conversationId: string
  log?: AskConversationLog
}): AskConversationPort {
  const { root, conversationId, log } = options
  let state: CloudAskConversation | null = null
  return {
    load: () => {
      state ??= loadFromDisk(root, conversationId, log)
      return state
    },
    save: (next) => {
      state = { digest: next.digest, turns: [...next.turns] }
      writeToDisk(root, conversationId, state, log)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 注册表：按会话 id 取存储（LRU）                                      */
/* ------------------------------------------------------------------ */

export interface AskConversationRegistry {
  /** 取（或新建）某个会话的存储；最近用过的排到最后，超上限淘汰最久未用的 */
  for(conversationId: string): AskConversationPort
  /**
   * 只清内存缓存（M2：切节点后用）：下次 `for()` 从盘上重读。
   * 不删文件——checkout 已经把 `conversations/` 整份换成目标节点的版本了。
   */
  reload(): void
  /**
   * 清空全部会话：内存缓存全丢；接记忆仓时连仓里的 `conversations/*.jsonl`
   * 与图片资产一起删（调用方负责先提交一次，删了还能从 git 历史找回）。
   */
  clear(): void
  size(): number
}

export interface AskConversationRegistryOptions {
  maxSessions?: number
  /** 记忆仓根目录；不给就是纯内存（单测 / 降级） */
  root?: string
  log?: AskConversationLog
}

export function createAskConversationRegistry(
  options: AskConversationRegistryOptions = {}
): AskConversationRegistry {
  const maxSessions = Math.max(1, options.maxSessions ?? ASK_CONVERSATION_MAX_SESSIONS)
  const root = options.root
  const log = options.log
  const stores = new Map<string, AskConversationPort>()
  return {
    for(conversationId) {
      const existing = stores.get(conversationId)
      if (existing !== undefined) {
        // LRU：重新插入到最后
        stores.delete(conversationId)
        stores.set(conversationId, existing)
        return existing
      }
      const store =
        root !== undefined
          ? createAskConversationFileStore({ root, conversationId, log })
          : createAskConversationStore()
      stores.set(conversationId, store)
      while (stores.size > maxSessions) {
        const oldest = stores.keys().next().value
        if (oldest === undefined) break
        stores.delete(oldest)
      }
      return store
    },
    reload() {
      stores.clear()
    },
    clear() {
      stores.clear()
      if (root === undefined) return
      // 清空问答历史 = 连 ta 的记忆一起清（已由调用方先提交一次，git 历史里还能找回）
      const dir = join(root, 'conversations')
      try {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.jsonl')) continue
          try {
            unlinkSync(join(dir, name))
          } catch (error) {
            log?.('warn', 'memory conversation clear failed', { name, error: String(error) })
          }
        }
      } catch {
        // 目录不存在 = 本来就没有会话
      }
      try {
        rmSync(assetsDir(root), { recursive: true, force: true })
      } catch (error) {
        log?.('warn', 'memory assets clear failed', { error: String(error) })
      }
    },
    size() {
      return stores.size
    }
  }
}
