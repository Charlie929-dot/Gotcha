/**
 * QQ 聊天台账（D96 / PR1）
 *
 * 一张**本机**的小账本：每条收到的、每条发出的 QQ 消息都记一行，分配一个短号
 * （`#12`），并把原话一起落盘。用途只有两个：
 *
 * 1. 引用（`reply` 段）能解出被引用那条的正文——NapCat 的 `reply` 只带 message_id，
 *    不带原话；短号给人 / 模型看，真实哈希 id 只存在这里和出站报文里。
 * 2. 重启后还能引用旧消息：`<userData>/qq/chat-log.json` 是唯一来源；`get_msg` 只是兜底。
 *
 * 纪律：
 * - 只在本机：不进 git、不进日志正文、不出网；
 * - 每个会话最多 500 条、最多 20 个会话，超出丢最旧；
 * - 正文最多 500 字，只存文字与图片张数，**不存图片字节**；
 * - 写盘 tmp + rename（断电不会留半截文件）；500ms 合并，不每条都刷；
 * - 坏文件按空台账启动，只记一条 warn（不删用户的文件）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 台账里一条消息的来源：用户发来的 / ta 自己发出的 */
export type QqChatRole = 'user' | 'ta'

/** 台账里的一行（也是给短号查询的返回值） */
export interface QqChatRecord {
  /** 本地短号（每个会话独立、单调递增、不复用） */
  seq: number
  /** QQ 的 message_id（哈希值；只用来映射，不进上下文） */
  qqId: number
  role: QqChatRole
  /** 原话（≤500 字；引用时给模型看的就是它） */
  text: string
  /** 消息时刻（毫秒） */
  at: number
  /** 这条消息里的图片张数（不存字节） */
  imageCount: number
  /** 这条消息引用的是哪条（短号）；没引用就没有 */
  quoteSeq?: number
}

export interface QqChatAppendInput {
  qqId: number
  role: QqChatRole
  text: string
  at: number
  imageCount?: number
  quoteSeq?: number
}

export interface QqChatLogOptions {
  /** 台账文件（`<userData>/qq/chat-log.json`） */
  file: string
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
  now?: () => number
  /** 每个会话保留多少条（默认 500） */
  maxRecords?: number
  /** 最多保留几个会话（默认 20，与白名单上限同量级） */
  maxConversations?: number
  /** 合并写盘间隔（默认 500ms；测试传 0 = 每条直接写） */
  flushDelayMs?: number
}

/** 每条最多存多少字（引用要的是原话，不是全文归档） */
export const QQ_CHAT_TEXT_MAX_CHARS = 500
/** 给模型的「最近几条」上限（与设计文档 §5.6 一致） */
export const QQ_CHAT_RECENT_MAX = 6
/** 文件格式版本：将来改结构时靠它判断 */
const QQ_CHAT_LOG_VERSION = 1

interface StoredRecord {
  seq?: unknown
  qqId?: unknown
  role?: unknown
  text?: unknown
  at?: unknown
  imageCount?: unknown
  quoteSeq?: unknown
}

interface StoredConversation {
  nextSeq?: unknown
  records?: unknown
}

interface ConversationState {
  nextSeq: number
  records: QqChatRecord[]
  lastAt: number
}

function trimText(text: string): string {
  const normalized = text.replace(/\r\n/gu, '\n').trim()
  const chars = Array.from(normalized)
  return chars.length <= QQ_CHAT_TEXT_MAX_CHARS ? normalized : chars.slice(0, QQ_CHAT_TEXT_MAX_CHARS).join('')
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * 本机聊天台账。只做同步的读写与内存索引，不碰网络、不碰 QQ 报文解析。
 */
export class ChatLog {
  private readonly file: string
  private readonly log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
  private readonly now: () => number
  private readonly maxRecords: number
  private readonly maxConversations: number
  private readonly flushDelayMs: number
  private conversations = new Map<string, ConversationState>()
  /** 会话 → QQ message_id → 记录（只用于「用户引用 ta 的话」这类回查） */
  private byQq = new Map<string, Map<number, QqChatRecord>>()
  /** 会话 → 短号 → 记录 */
  private seqIndex = new Map<string, Map<number, QqChatRecord>>()
  private loaded = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: QqChatLogOptions) {
    this.file = options.file
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.maxRecords = Math.max(1, Math.trunc(options.maxRecords ?? 500))
    this.maxConversations = Math.max(1, Math.trunc(options.maxConversations ?? 20))
    this.flushDelayMs = Math.max(0, Math.trunc(options.flushDelayMs ?? 500))
  }

  /** 台账文件路径（日志 / 诊断用；不要把内容打出来） */
  path(): string {
    return this.file
  }

  /** 记一条；返回带短号的记录 */
  append(conversationId: string, input: QqChatAppendInput): QqChatRecord {
    this.ensureLoaded()
    let state = this.conversations.get(conversationId)
    if (state === undefined) {
      this.pruneConversations(conversationId)
      state = { nextSeq: 1, records: [], lastAt: 0 }
      this.conversations.set(conversationId, state)
      this.byQq.set(conversationId, new Map())
      this.seqIndex.set(conversationId, new Map())
    }
    const quoteSeq = positiveInt(input.quoteSeq)
    const record: QqChatRecord = {
      seq: state.nextSeq,
      qqId: positiveInt(input.qqId) ?? 0,
      role: input.role,
      text: trimText(input.text ?? ''),
      at: Number.isFinite(input.at) ? Math.trunc(input.at) : this.now(),
      imageCount: Math.max(0, Math.trunc(input.imageCount ?? 0)),
      ...(quoteSeq !== null ? { quoteSeq } : {})
    }
    state.nextSeq += 1
    state.lastAt = record.at
    state.records.push(record)
    this.seqIndex.get(conversationId)?.set(record.seq, record)
    if (record.qqId > 0) this.byQq.get(conversationId)?.set(record.qqId, record)
    if (state.records.length > this.maxRecords) {
      const dropped = state.records.splice(0, state.records.length - this.maxRecords)
      for (const old of dropped) {
        this.seqIndex.get(conversationId)?.delete(old.seq)
        // 同一个 QQ id 只会映射到最后一条：只有它自己还指着这条时才删
        if (old.qqId > 0 && this.byQq.get(conversationId)?.get(old.qqId) === old) {
          this.byQq.get(conversationId)?.delete(old.qqId)
        }
      }
    }
    this.scheduleFlush()
    return record
  }

  /** 按 QQ message_id 回查（本进程收到 / 发出的消息） */
  byQqId(conversationId: string, qqId: number): QqChatRecord | null {
    this.ensureLoaded()
    if (!Number.isInteger(qqId) || qqId <= 0) return null
    return this.byQq.get(conversationId)?.get(qqId) ?? null
  }

  /** 按短号回查（`quote_message` 工具用） */
  bySeq(conversationId: string, seq: number): QqChatRecord | null {
    this.ensureLoaded()
    if (!Number.isInteger(seq) || seq <= 0) return null
    return this.seqIndex.get(conversationId)?.get(seq) ?? null
  }

  /** 最近几条（按时间从旧到新，含最后一条） */
  recent(conversationId: string, limit = QQ_CHAT_RECENT_MAX): QqChatRecord[] {
    this.ensureLoaded()
    const records = this.conversations.get(conversationId)?.records ?? []
    const count = Math.max(0, Math.trunc(limit))
    return count === 0 ? [] : records.slice(-count)
  }

  /** 最近几个可用短号（短号不存在时给模型一个范围，别让它瞎猜） */
  recentSeqs(conversationId: string, limit = QQ_CHAT_RECENT_MAX): number[] {
    return this.recent(conversationId, limit).map((record) => record.seq)
  }

  /** 立即写盘（退出 / 测试用）；没有改动时也安全 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.loaded) return
    const conversations: Record<string, { nextSeq: number; records: QqChatRecord[] }> = {}
    for (const [id, state] of this.conversations) {
      conversations[id] = { nextSeq: state.nextSeq, records: state.records }
    }
    const body = JSON.stringify({ version: QQ_CHAT_LOG_VERSION, conversations })
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('warn', 'qq chat log write failed', { error: String(error) })
    }
  }

  /** 退出前调用：把还没合并的改动写掉 */
  dispose(): void {
    this.flush()
  }

  private scheduleFlush(): void {
    if (this.flushDelayMs === 0) {
      this.flush()
      return
    }
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.flushDelayMs)
    // Electron 主进程里别让定时器拖住退出
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  /** 会话数超限：丢最久没有消息的那个（正在用的这个不丢） */
  private pruneConversations(keep: string): void {
    if (this.conversations.size < this.maxConversations) return
    let oldestId: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, state] of this.conversations) {
      if (id === keep) continue
      if (state.lastAt < oldestAt) {
        oldestAt = state.lastAt
        oldestId = id
      }
    }
    if (oldestId === null) return
    this.conversations.delete(oldestId)
    this.byQq.delete(oldestId)
    this.seqIndex.delete(oldestId)
  }

  /** 懒加载：第一次访问时读盘；坏文件按空台账启动 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.log('warn', 'qq chat log corrupt: unreadable json, starting empty')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.log('warn', 'qq chat log corrupt: not an object, starting empty')
      return
    }
    const root = parsed as { version?: unknown; conversations?: unknown }
    if (root.version !== QQ_CHAT_LOG_VERSION) {
      this.log('warn', 'qq chat log version mismatch, starting empty', { version: root.version })
      return
    }
    const conversations = root.conversations
    if (typeof conversations !== 'object' || conversations === null) return
    for (const [id, value] of Object.entries(conversations as Record<string, StoredConversation>)) {
      if (typeof value !== 'object' || value === null) continue
      const records: QqChatRecord[] = []
      const byQq = new Map<number, QqChatRecord>()
      const seqIndex = new Map<number, QqChatRecord>()
      let maxSeq = 0
      const stored = Array.isArray(value.records) ? value.records : []
      for (const item of stored as StoredRecord[]) {
        if (typeof item !== 'object' || item === null) continue
        const seq = positiveInt(item.seq)
        const role = item.role === 'ta' || item.role === 'user' ? item.role : null
        if (seq === null || role === null) continue
        if (seqIndex.has(seq)) continue
        const quoteSeq = positiveInt(item.quoteSeq)
        const record: QqChatRecord = {
          seq,
          qqId: positiveInt(item.qqId) ?? 0,
          role,
          text: typeof item.text === 'string' ? trimText(item.text) : '',
          at: typeof item.at === 'number' && Number.isFinite(item.at) ? Math.trunc(item.at) : 0,
          imageCount:
            typeof item.imageCount === 'number' && Number.isFinite(item.imageCount)
              ? Math.max(0, Math.trunc(item.imageCount))
              : 0,
          ...(quoteSeq !== null ? { quoteSeq } : {})
        }
        records.push(record)
        seqIndex.set(record.seq, record)
        if (record.qqId > 0) byQq.set(record.qqId, record)
        maxSeq = Math.max(maxSeq, record.seq)
      }
      records.sort((a, b) => a.seq - b.seq)
      const kept = records.slice(-this.maxRecords)
      const nextSeq = Math.max(positiveInt(value.nextSeq) ?? 1, maxSeq + 1)
      this.conversations.set(id, {
        nextSeq,
        records: kept,
        lastAt: kept.length > 0 ? kept[kept.length - 1]!.at : 0
      })
      // 淘汰出来的旧记录不能留在索引里
      const keptSeqs = new Set(kept.map((record) => record.seq))
      for (const record of records) {
        if (!keptSeqs.has(record.seq)) {
          seqIndex.delete(record.seq)
          if (record.qqId > 0 && byQq.get(record.qqId) === record) byQq.delete(record.qqId)
        }
      }
      this.seqIndex.set(id, seqIndex)
      this.byQq.set(id, byQq)
    }
  }
}
