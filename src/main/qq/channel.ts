/**
 * QQ 通道 · 通道层（M1）
 *
 * 职责只有「谁可以问 / 一次怎么答 / 回什么字」——协议与传输在 `ob11.ts`，
 * 问答在组合根注入的 `ask`（`src/main/index.ts` 里接的是现有 `askChain`，
 * 与桌面问记忆同一条链路、同一份出云策略与日额度）。
 *
 * 纪律（D63）：
 * - **默认关闭**；没配白名单就不放行（fail-closed，不回话也不记录问题正文）；
 * - 每用户串行 + 每分钟限流，避免 QQ 侧连点把桌面问答挤爆；
 * - 回答一律按纯文本回，长答自动分条（不做 t2i 卡片、不注入平台提示词）；
 * - 日志只记计数与结果种类，**不记问题正文、不记 token**。
 */

import type {
  ChainAskOutboundMedia,
  ChainAskResult,
  ChainAskResumeDecision
} from '../../chain/agent/types'
import type { QqImageRef, QqInbound, QqLog, QqQuotedMessage, QqTransportStatus } from './ob11'
import { QQ_INBOUND_FILE_MAX, QQ_INBOUND_IMAGE_MAX } from './ob11'
import {
  downloadFileBytes,
  downloadImageAsDataUrl,
  imageDataUrlFromBase64,
  imageDataUrlFromBytes,
  isImageFile,
  isTextFile,
  textFromBytes
} from './media'

/** 通道看到的台账记录（真实实现是 `ChatLog`；测试给内存假实现） */
export interface QqChatRecordView {
  readonly seq: number
  readonly qqId: number
  readonly role: 'user' | 'ta'
  readonly text: string
  readonly at: number
  readonly imageCount: number
  /** 这条引用了哪条（短号） */
  readonly quoteSeq?: number
}

/** 通道要用的台账能力（D96）：记 / 按 QQ id 回查 / 按短号回查 / 最近几条 */
export interface QqChatLog {
  append(
    conversationId: string,
    input: {
      qqId: number
      role: 'user' | 'ta'
      text: string
      at: number
      imageCount?: number
      quoteSeq?: number
    }
  ): QqChatRecordView
  byQqId(conversationId: string, qqId: number): QqChatRecordView | null
  bySeq(conversationId: string, seq: number): QqChatRecordView | null
  recent(conversationId: string, limit?: number): readonly QqChatRecordView[]
}

/** 引用块里的一句话（给模型的 `quoted`）：短号 / 来源 / 时刻 / 原话 / 图数 */
export interface QqQuoteView {
  readonly id: number
  readonly from: 'user' | 'ta'
  readonly at: number
  readonly text: string
  readonly images: number
  readonly missing?: true
}

/** 最近几条聊天（给模型的 `recent`） */
export interface QqRecentView {
  readonly id: number
  readonly from: 'user' | 'ta'
  readonly at: number
  readonly text: string
}

/** 传输层的最小契约（真实实现是 `QqOb11Server`；测试里换成假实现） */
export interface QqTransport {
  start(options: {
    host: string
    port: number
    accessToken: string
    onMessage: (inbound: QqInbound) => void
    log: QqLog
    /** 账号被服务器踢下线（`bot_offline`）：可选，假实现不接就当没这条信号 */
    onAccountOffline?: () => void
  }): Promise<{ port: number }>
  stop(): Promise<void>
  /**
   * 发一条消息；`replyTo` 是真实 QQ message_id（D96：`reply` 段放第一位）。
   * 返回发出去的 message_id（拿不到就 null）：通道要把它记进台账。
   */
  sendPrivate(userId: number, text: string, options?: { replyTo?: number }): Promise<number | null>
  /**
   * 发一张图 / 表情（D96 / PR2）：只收压过口径的 data URL（`prepareOutboundImage`），
   * 不接受任意本地路径 / 远端地址。可选：假实现不接 = 这条通道发不了图。
   */
  sendPrivateImage?(
    userId: number,
    dataUrl: string,
    options?: { replyTo?: number }
  ): Promise<number | null>
  /** NapCat `get_image`：拿 base64（优先）或 url（兜底） */
  getImage(file: string): Promise<{ base64?: string; url?: string }>
  /** NapCat `get_msg`（D96）：台账没命中时兜底解引用；可选，假实现不接就当取不到 */
  getMsg?(messageId: number): Promise<QqQuotedMessage | null>
  /** 私聊文件的下载地址（D88）：可选，假实现不接就当拿不到 */
  getFileUrl?(fileId: string): Promise<string | null>
  /** 改 QQ 昵称（M4 传承）：可选，老测试假实现不用接 */
  setProfile?(nickname: string): Promise<void>
  status(): QqTransportStatus
}

export interface QqChannelConfig {
  enabled: boolean
  /** 监听地址：`127.0.0.1`（默认，只本机）或 `0.0.0.0`（允许局域网 / 跨机 NapCat） */
  host: string
  port: number
  accessToken: string
  /** 允许私聊问答的 QQ 号（字符串形态，与设置里存的一致） */
  allowUsers: readonly string[]
  /** 单条消息上限：超了分条发 */
  replyMaxChars: number
}

export interface QqAskInput {
  text: string
  /** 每个 QQ 用户一个会话（`qq-<userId>`），上下文按它取 */
  conversationId: string
  signal: AbortSignal
  /** 本条消息里的图片（data URL；最多 4 张；取不到就空） */
  images?: readonly string[]
  /** 本条消息里的文本文件（D88：QQ 以「文件」发的 .md/.txt 等） */
  files?: readonly { readonly name: string; readonly text: string }[]
  /** 本条消息引用了哪条（D96）：通道已解出原话；取不到就 `missing` */
  quoted?: QqQuoteView
  /** 最近几条聊天（含本轮这条）：让 ta 知道能引用谁 */
  recent?: readonly QqRecentView[]
}

export interface QqChannelDeps {
  ask: (input: QqAskInput) => Promise<ChainAskResult>
  /** 成功推送后，在收件人的串行队列内持久化提醒上下文。 */
  pushed?: (input: { conversationId: string; question: string; text: string; at: number }) => Promise<void>
  /**
   * 「还要继续查吗」的选择（2026-11-01 修）：桌面能点按钮，QQ 只能回字，
   * 所以这里接上与桌面同一个续查通道——会话里挂着待选时，回「1」继续查 /「2」按现有结果收尾。
   * 不传 = 这条通道不支持续查（界面文案仍会提示回桌面点）。
   */
  resume?: (input: QqResumeInput) => Promise<ChainAskResult>
  /**
   * 本地命令（M5）：与桌面共用同一个 `createCommandHandler` 实例。
   * 命中就返结果（不调模型、不计生命、不占限流），返 null 照常提问。
   */
  command?: (text: string, context: { conversationId: string }) => Promise<ChainAskResult | null>
  log: QqLog
  now?: () => number
  /**
   * 聊天台账（D96）：记短号与原话、解引用、给 `quote_message` 查。
   * 不传 = 没有台账：引用只能靠 `getMsg` 兜底，重启后引用不了旧消息。
   */
  chatLog?: QqChatLog
  /**
   * 发图闸门（D96 / PR2）：同一张表情 24h 内不连发、表情 / 图片每日上限。
   * 不传 = 不做计数（测试 / 没接闸门的路径）。
   */
  mediaGate?: {
    allow(kind: 'sticker' | 'image', ref?: string): boolean
  }
  /** 每用户每分钟最多几条（默认 6） */
  perMinute?: number
  /** 全局排队上限（默认 8）：超了回一句「排队中」 */
  maxQueue?: number
  /** 一次问答的超时（默认 180s） */
  askTimeoutMs?: number
  /** 分条之间隔多久（默认 200ms；测试传 0） */
  partGapMs?: number
  /**
   * 这条 QQ 消息该写进哪个会话（2026-11-05 拍板 C+D）：默认 `qq-<QQ号>`（各聊各的）；
   * 主进程传「桌面当前会话」时，QQ 与桌面共用同一条上下文——桌面能看到 QQ 说的话，
   * QQ 也能接上桌面说过的话。
   */
  conversationFor?: (userId: number) => string
  /**
   * 账号被腾讯踢下线（OneBot `notice_type=bot_offline`，2026-11-10）：
   * 这条通知证明「刚才是登录着的」，但腾讯把这次登录作废了——只能重新扫码。
   * 主进程接到 NapCat 托管器上，立刻弹一条「要扫码」的提醒（别再说「会自动接上」）。
   */
  onAccountOffline?: () => void
}

export interface QqChannelStatus extends QqTransportStatus {
  running: boolean
  lastError?: string
  /**
   * 最后一条**入站**消息的时刻（D111，2026-11-09）。
   *
   * 这条链上「出站」永远像好人：QQ 半死时 `send_private_msg` 照样成功、WS 连着、
   * `isLogin` / `online` 全是 true，唯一变化就是再也收不到消息（19:42–21:38 那次）。
   * 所以这是唯一能让人看见「在线但收不到」的线索；null = 本次启动还没收到过。
   */
  lastInboundAt: number | null
}

/** QQ 里的「还要继续查吗」选择：带着当初那一问，续查结果仍记在这条上 */
export interface QqResumeInput {
  resumeId: string
  decision: ChainAskResumeDecision
  conversationId: string
  /** 当初问的那句（续查的答案仍算这一问的答案） */
  question: string
  /** 本条消息的超时信号（与 `ask` 同一条命） */
  signal: AbortSignal
}

/** 只认 `1` / `2`（含全角、带句点 / 顿号 / 括号）：别的字一律当正常提问，别把话吃掉 */
const RESUME_CHOICE_RE = /^([12１２])[.．、,)）]?$/u

/**
 * 用户回的是不是「继续查 / 收尾」的选择。
 * 只在**这个会话正挂着待选**时才算数（见 `pendingChoices`），否则「1」就是普通提问。
 */
export function parseResumeChoice(text: string): ChainAskResumeDecision | null {
  const match = RESUME_CHOICE_RE.exec(text.trim())
  if (match === null) return null
  const digit = match[1]
  return digit === '1' || digit === '１' ? 'continue' : 'stop'
}

/** 问题长度上限：与 `ask:query` 的 500 字口径一致（超了直接回提示，不截断硬发） */
export const QQ_QUESTION_MAX_CHARS = 500
/** 单条回复的分条上限（QQ 单条上限比这个大；分条是为了不刷屏、也留余量给引用段） */
export const QQ_REPLY_MIN_CHARS = 200
export const QQ_REPLY_MAX_CHARS = 4_500
export const QQ_REPLY_DEFAULT_CHARS = 1_800

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function clockOf(at: number): string {
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 剥 Markdown：QQ 不渲染，星号 / 井号留着只会显得像乱码。
 * 只做「不改变语义」的轻剥离：代码块去掉围栏保留内容，行内 code 去掉反引号，
 * 标题井号去掉，链接留文字（URL 太长不原样回）。
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*\n?/gu, '')
    .replace(/`([^`\n]+)`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
    .replace(/__([^_\n]+)__/gu, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/gmu, '$1$2')
    .replace(/^\s*[-*+]\s+/gmu, '· ')
    .replace(/^\s*>\s?/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** 引用段 → 一行行纯文本（屏幕上是什么、几点） */
function citationLines(result: ChainAskResult): string[] {
  if (result.kind !== 'answer' && result.kind !== 'insufficient' && result.kind !== 'no-evidence') {
    return []
  }
  const lines: string[] = []
  for (const citation of result.citations ?? []) {
    const title = citation.title.trim()
    lines.push(`· ${clockOf(citation.at)} ${citation.app}${title === '' ? '' : ` · ${title}`}`)
  }
  for (const memory of result.memories ?? []) {
    const section = memory.section.trim()
    lines.push(`· 日记 ${memory.day}${section === '' ? '' : ` · ${section}`}`)
  }
  return lines
}

/** 一次结果 → 回复正文（不含分条；分条在 `splitForQq`） */
export function formatAskResult(result: ChainAskResult): string {
  const body = formatAskBody(result)
  // 交接回执（D82 / D85）：出生那一问把回执放在最前面、自己成一段——
  // `splitForQq` 按空行分段，手机上就是先一条「🎗️提示 …」，再是回答本身。
  const receipt = result.receipt?.trim() ?? ''
  return receipt === '' ? body : `${receipt}\n\n${body}`
}

function formatAskBody(result: ChainAskResult): string {
  switch (result.kind) {
    case 'answer':
    case 'insufficient': {
      const body = stripMarkdown(result.answer).trim()
      const lines = citationLines(result)
      const head = body === '' ? '这条我没答上来。' : body
      if (lines.length === 0) return head
      return `${head}\n\n参考：\n${lines.join('\n')}`
    }
    case 'no-evidence': {
      const note = result.note ? stripMarkdown(result.note).trim() : ''
      const lines = citationLines(result)
      const head = note === '' ? '这条没找到相关的记录。' : note
      return lines.length === 0 ? head : `${head}\n\n查到这些片段（还不算结论）：\n${lines.join('\n')}`
    }
    case 'clarify':
      return [
        result.question,
        ...result.options.map((option, index) => `${index + 1}. ${option}`),
        '',
        '回一句话补上就行。'
      ].join('\n')
    case 'command':
      // 本地命令（M5）：命令回执自己就是正文（桌面窗口原样显示，QQ 只剥 Markdown）
      return stripMarkdown(result.text)
    case 'continue-ask':
      // 2026-11-01 修：QQ 也能续查了（回 1 / 2），不再让人回桌面点按钮
      return [
        result.question,
        ...result.options.map((option, index) => `${index + 1}. ${option}`),
        '',
        '回「1」继续查，回「2」按现有结果收尾。'
      ].join('\n')
    case 'error':
      return formatAskError(result.reason, result.message)
    default:
      return '这次没问出来，待会儿再试。'
  }
}

function formatAskError(reason: string, message: string): string {
  switch (reason) {
    case 'consent':
      return '还没打开出网确认（桌面 → 设置 → 出网），打开后才能在这边问。'
    case 'budget':
      return '今天的额度用完了，明天再来（或到桌面调高每日额度）。'
    case 'client':
      return '模型还没配好（桌面 → 设置 → 供应商）。'
    case 'question-blocked':
      return '这个问题里有敏感内容，没有发出去。'
    case 'empty-question':
      return '没收到问题。'
    case 'unparseable':
      return '模型这轮没答成形，再问一次试试。'
    default:
      return `这次没问出来：${message}`
  }
}

/**
 * 回复分条（2026-10-30 拍板人反馈「本来应该是多段消息，但他只发了一个」）：
 * 一律**按空行分段**，一段一条 QQ 消息；段太长再按行 / 码点硬切（不劈坏 emoji）。
 * 超过 `maxParts` 条时**不丢内容**：前 `maxParts-1` 条原样，剩下的合并进最后一条。
 */
export function splitForQq(text: string, maxChars: number, maxParts = 8): string[] {
  const limit = Math.max(QQ_REPLY_MIN_CHARS, Math.min(QQ_REPLY_MAX_CHARS, Math.round(maxChars)))
  const normalized = text.replace(/\r\n/gu, '\n').trim()
  if (normalized === '') return []

  const chunks: string[] = []
  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')

  for (const paragraph of paragraphs) {
    if (Array.from(paragraph).length <= limit) {
      chunks.push(paragraph)
      continue
    }
    // 单段超上限：按行累加到 limit，再不行按码点硬切
    let current = ''
    const flush = (): void => {
      if (current.trim() !== '') chunks.push(current.trim())
      current = ''
    }
    const pushHard = (line: string): void => {
      const chars = Array.from(line)
      while (chars.length > 0) {
        const room = limit - Array.from(current).length
        if (room <= 0) {
          flush()
          continue
        }
        current += chars.splice(0, room).join('')
        if (chars.length > 0) flush()
      }
    }
    for (const line of paragraph.split('\n')) {
      if (Array.from(line).length > limit) {
        flush()
        pushHard(line)
        continue
      }
      if (Array.from(current).length + Array.from(line).length + 1 > limit) flush()
      current += (current === '' ? '' : '\n') + line
    }
    flush()
  }

  if (chunks.length === 0) return []
  if (chunks.length <= maxParts) return chunks
  const kept = chunks.slice(0, maxParts - 1)
  kept.push(chunks.slice(maxParts - 1).join('\n\n'))
  return kept
}

export interface QqChannel {
  start(config: QqChannelConfig): Promise<{ ok: boolean; error?: string; port?: number }>
  stop(): Promise<void>
  status(): QqChannelStatus
  /** 供传输层调用（也供测试直接喂消息）：排队跑完这一次问答 */
  handleMessage(inbound: QqInbound): Promise<void>
  /** 当前是否在跑（组合根退出 / 重配时用） */
  isRunning(): boolean
  /** 改 QQ 昵称（M4 传承）：transport 没接就静默跳过，调用方记日志 */
  setProfile?(nickname: string): Promise<void>
  /**
   * 主动推一条（前台任务到点，2026-11-01 拍板 D93）：窗口没开时手机上也能看到。
   * 只在通道跑着、白名单非空时发，发给白名单第一个人；失败只记日志、不重试。
   */
  push(text: string, question?: string): Promise<QqPushResult>
}

/** `push` 的结果：没发出去时带原因（调用方只记日志，不重试也不改口） */
export interface QqPushResult {
  sent: boolean
  /** 实际发出去几条（长回答按 `splitForQq` 分段） */
  parts: number
  reason?: 'not-running' | 'no-owner' | 'empty' | 'send-failed'
}

export function createQqChannel(transport: QqTransport, deps: QqChannelDeps): QqChannel {
  const now = deps.now ?? Date.now
  const perMinute = Math.max(1, deps.perMinute ?? 6)
  const maxQueue = Math.max(1, deps.maxQueue ?? 8)
  const askTimeoutMs = Math.max(10_000, deps.askTimeoutMs ?? 180_000)
  const partGapMs = Math.max(0, deps.partGapMs ?? 200)

  let config: QqChannelConfig | null = null
  let running = false
  let lastError: string | undefined
  let pending = 0
  /** 最后一条入站消息的时刻（D111）：设置抽屉与「入站体检」都看它 */
  let lastInboundAt: number | null = null
  const queues = new Map<number, Promise<void>>()
  const windows = new Map<number, { start: number; count: number }>()
  const warnedAt = new Map<number, number>()
  /**
   * 每个会话挂着的「要不要接着查」（2026-11-01 修）：上一句是 `continue-ask` 且带 `resumeId`
   * 时记下来，下一句若是 `1` / `2` 就走续查通道；换成别的问题就清掉（不把话吃掉）。
   */
  const pendingChoices = new Map<string, { resumeId: string; question: string }>()

  const log = deps.log
  const chatLog = deps.chatLog
  /** 这条消息写进哪个会话：主进程接了「桌面当前会话」就用它（C+D），否则各聊各的 */
  const conversationFor = (userId: number): string =>
    deps.conversationFor?.(userId) ?? `qq-${userId}`

  /**
   * 图片引用 → data URL。优先 `get_image` 的 base64（不下载），没有才走 url；
   * 单张失败跳过（文本里的 `[图片]` 还在），只记数量不记文件 id / url。
   */
  const resolveImages = async (refs: QqInbound['images']): Promise<string[]> => {
    if (!refs || refs.length === 0) return []
    const wanted = refs.slice(0, QQ_INBOUND_IMAGE_MAX)
    // 并行取图：每张各自超时，别让 4 张串行把问答预算吃光
    const resolved = await Promise.all(
      wanted.map(async (ref) => {
        try {
          let base64 = ''
          let url = ref.url ?? ''
          if (ref.file !== undefined) {
            const got = await transport.getImage(ref.file)
            base64 = got.base64 ?? ''
            if (got.url !== undefined) url = got.url
          }
          if (base64 !== '') {
            const dataUrl = imageDataUrlFromBase64(base64)
            if (dataUrl !== null) return dataUrl
          }
          if (url !== '') return await downloadImageAsDataUrl(url)
          return null
        } catch {
          return null
        }
      })
    )
    const out = resolved.filter((item): item is string => item !== null)
    if (out.length < wanted.length) {
      log('warn', 'qq image skipped', { requested: wanted.length, resolved: out.length })
    }
    return out
  }

  /**
   * 文件引用 → 图片 / 文本附件（D88）。QQ 把同一张图当「文件」发时，`[文件]` 里其实
   * 还藏着字节：扩展名是图片就当图（和图片段同一条路），是文本就当附件；
   * 取不到就只留占位符，日志只记原因，不记文件名 / id。
   */
  const resolveFiles = async (
    refs: QqInbound['files']
  ): Promise<{ images: string[]; files: { name: string; text: string }[] }> => {
    const out = { images: [] as string[], files: [] as { name: string; text: string }[] }
    if (!refs || refs.length === 0) return out
    for (const ref of refs.slice(0, QQ_INBOUND_FILE_MAX)) {
      const name = ref.name ?? ''
      const wantedImage = name === '' || isImageFile(name)
      const wantedText = name !== '' && isTextFile(name)
      if (!wantedImage && !wantedText) continue
      try {
        let url = ref.url ?? ''
        if (url === '' && ref.fileId !== undefined && transport.getFileUrl !== undefined) {
          url = (await transport.getFileUrl(ref.fileId)) ?? ''
        }
        if (url === '') {
          log('warn', 'qq file skipped', { reason: 'no-url' })
          continue
        }
        const bytes = await downloadFileBytes(url)
        if (bytes === null) {
          log('warn', 'qq file skipped', { reason: 'download-failed' })
          continue
        }
        if (wantedImage) {
          const dataUrl = imageDataUrlFromBytes(bytes)
          if (dataUrl !== null) {
            out.images.push(dataUrl)
            continue
          }
        }
        if (!wantedText) continue
        const text = textFromBytes(bytes)
        if (text !== null) out.files.push({ name: name === '' ? '文件' : name, text })
        else log('warn', 'qq file skipped', { reason: 'not-text' })
      } catch {
        log('warn', 'qq file skipped', { reason: 'error' })
      }
    }
    return out
  }

  const allow = (userId: number): boolean => {    // 白名单为空 = 谁都别问（fail-closed）；设置层也会挡，这里是最后一道
    if (!config || config.allowUsers.length === 0) return false
    return config.allowUsers.includes(String(userId))
  }

  const rateLimited = (userId: number): boolean => {
    const at = now()
    const window = windows.get(userId)
    if (!window || at - window.start >= 60_000) {
      windows.set(userId, { start: at, count: 1 })
      return false
    }
    window.count += 1
    return window.count > perMinute
  }

  const warnOnce = async (userId: number, text: string): Promise<void> => {
    const at = now()
    const last = warnedAt.get(userId) ?? 0
    if (at - last < 60_000) return
    warnedAt.set(userId, at)
    try {
      // 提醒也算 ta 说的话：记进台账，用户引用它时能解出原话
      await sendOne(userId, conversationFor(userId), text)
    } catch (error) {
      log('warn', 'qq reply failed', { error: String(error) })
    }
  }

  /**
   * 发一条并记进台账（role=ta）。`sentId` 拿不到（个别实现不回 message_id）就不记：
   * 没有真实 QQ id 的映射没有意义，宁可少一条也不编。
   */
  const sendOne = async (
    userId: number,
    conversationId: string,
    text: string,
    replyTo?: number
  ): Promise<number | null> => {
    const sentId = await transport.sendPrivate(
      userId,
      text,
      replyTo !== undefined ? { replyTo } : undefined
    )
    if (chatLog !== undefined && sentId !== null) {
      chatLog.append(conversationId, {
        qqId: sentId,
        role: 'ta',
        text,
        at: now(),
        imageCount: 0
      })
    }
    return sentId
  }

  /**
   * 一段回复 → 按上限分条发出去（段间留一口气，测试传 partGapMs: 0）。
   * D96：只有第一段带引用；引用被拒（目标撤回 / 过期 / 风控）时重试一次纯文本，
   * 保证回答仍然送达——两次都失败才记 warn。
   */
  const sendParts = async (userId: number, text: string, replyTo?: number): Promise<number> => {
    const parts = splitForQq(text, config?.replyMaxChars ?? QQ_REPLY_DEFAULT_CHARS)
    const conversationId = conversationFor(userId)
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? ''
      const target = index === 0 ? replyTo : undefined
      try {
        await sendOne(userId, conversationId, part, target)
      } catch (error) {
        if (target === undefined) throw error
        log('warn', 'qq reply quote rejected, retrying plain text', { error: String(error) })
        await sendOne(userId, conversationId, part)
      }
      // 连发太快时 QQ 侧偶发乱序 / 折叠（默认 200ms）
      if (parts.length > 1 && partGapMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, partGapMs))
      }
    }
    return parts.length
  }

  /** `get_msg` 兜底拿到图（最多 1 张）：引用是一张图时也让 ta 看见 */
  const quotedImagesOf = async (refs: readonly QqImageRef[] | undefined): Promise<string[]> => {
    if (refs === undefined || refs.length === 0) return []
    return resolveImages(refs.slice(0, 1))
  }

  /**
   * 文字发完之后的媒体（D96 / PR2 §6.4）：
   * - 每轮最多 1 张表情 + 1 张图，顺序固定（表情在前）；
   * - 过闸门（24h 同表情 / 每日上限）才发；
   * - 图发失败只记一条 warn，**文字已经送达**，不重发、不吞回答。
   */
  const sendOutboundMedia = async (
    userId: number,
    media: readonly ChainAskOutboundMedia[] | undefined
  ): Promise<void> => {
    if (media === undefined || media.length === 0) return
    const sendImage = transport.sendPrivateImage?.bind(transport)
    if (sendImage === undefined) {
      log('warn', 'qq outbound media skipped', { reason: 'no-send-image' })
      return
    }
    const picked = [
      ...media.filter((item) => item.kind === 'sticker').slice(0, 1),
      ...media.filter((item) => item.kind === 'image').slice(0, 1)
    ]
    for (const item of picked) {
      const allowed = deps.mediaGate?.allow(item.kind, item.ref) ?? true
      if (!allowed) {
        log('info', 'qq outbound media gated', { kind: item.kind })
        continue
      }
      try {
        await sendImage(userId, item.dataUrl)
        log('info', 'qq outbound media sent', { kind: item.kind })
      } catch (error) {
        log('warn', 'qq outbound media failed', { kind: item.kind, error: String(error) })
      }
      if (partGapMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, partGapMs))
      }
    }
  }

  /**
   * 解引用（D96 §5.5）：台账 → `get_msg` → missing，三档都如实。
   * 返回给模型的 `quoted`，以及能附上的被引用图（最多 1 张）。
   */
  const resolveQuote = async (
    inbound: QqInbound,
    conversationId: string
  ): Promise<{ quoted?: QqQuoteView; images: string[] }> => {
    const quoteId = inbound.quoteId
    if (quoteId === undefined) return { images: [] }
    const ledger = chatLog?.byQqId(conversationId, quoteId) ?? null
    if (ledger !== null) {
      const pureImage = ledger.text === '' && ledger.imageCount > 0
      // 纯图引用：台账只存张数，图还得回 QQ 取一次（拿不到就只留 [图片]）
      const fallback = pureImage && transport.getMsg !== undefined ? await transport.getMsg(quoteId) : null
      const images = await quotedImagesOf(fallback?.images)
      return {
        quoted: {
          id: ledger.seq,
          from: ledger.role,
          at: ledger.at,
          text: ledger.text !== '' ? ledger.text : ledger.imageCount > 0 ? '[图片]' : '',
          images: ledger.imageCount
        },
        images
      }
    }
    const got = transport.getMsg !== undefined ? await transport.getMsg(quoteId) : null
    if (got === null || (got.text === '' && (got.images?.length ?? 0) === 0)) {
      // 台账没命中、get_msg 也取不到：如实标 missing，不编内容
      log('warn', 'qq quote unresolved', { reason: got === null ? 'no-get-msg' : 'empty' })
      return {
        quoted: { id: 0, from: 'user', at: 0, text: '', images: 0, missing: true },
        images: []
      }
    }
    const images = await quotedImagesOf(got.images)
    const messageId = got.fromSelf ? 'ta' : 'user'
    // 兜底取到的消息也补进台账：它有了短号，之后能再被引用
    const seq =
      chatLog !== undefined
        ? chatLog.append(conversationId, {
            qqId: quoteId,
            role: messageId,
            text: got.text,
            at: got.at,
            imageCount: got.images?.length ?? 0
          }).seq
        : 0
    return {
      quoted: {
        id: seq,
        from: messageId,
        at: got.at,
        text: got.text !== '' ? got.text : '[图片]',
        images: got.images?.length ?? 0
      },
      images
    }
  }

  /**
   * 主动推一条（2026-11-01 拍板 D93：前台任务到点，桌面气泡之外也发一份到 QQ）。
   * - 通道没跑 / 白名单空 / 主人号不合法：不发明说原因，调用方只记日志；
   * - 发给白名单第一个人（用户在设置里填的那个号），不发群、不发所有人；
   * - 发送失败也不抛：到点这一轮已经算交付过，重试只会重复提醒。
   */
  const push = async (text: string, question?: string): Promise<QqPushResult> => {
    if (!running) return { sent: false, parts: 0, reason: 'not-running' }
    const current = config
    if (current === null || current.allowUsers.length === 0) {
      return { sent: false, parts: 0, reason: 'no-owner' }
    }
    const owner = Number(current.allowUsers[0])
    if (!Number.isInteger(owner) || owner <= 0) return { sent: false, parts: 0, reason: 'no-owner' }
    const parts = splitForQq(text, current.replyMaxChars ?? QQ_REPLY_DEFAULT_CHARS)
    if (parts.length === 0) return { sent: false, parts: 0, reason: 'empty' }
    // 与同一用户的问答共用队列；先完成发送与记账，再允许下一问加载历史。
    const previous = queues.get(owner) ?? Promise.resolve()
    let result: QqPushResult = { sent: false, parts: 0, reason: 'send-failed' }
    const next = previous.then(async () => {
      if (!running) {
        result = { sent: false, parts: 0, reason: 'not-running' }
        return
      }
      try {
        const sent = await sendParts(owner, text)
        result = { sent: true, parts: sent }
        log('info', 'qq push sent', { parts: sent })
      } catch (error) {
        log('warn', 'qq push failed', { error: String(error) })
        return
      }
      if (question !== undefined && deps.pushed !== undefined) {
        try {
          await deps.pushed({ conversationId: `qq-${owner}`, question, text, at: now() })
        } catch (error) {
          log('warn', 'qq push context failed', { error: String(error) })
        }
      }
    })
    queues.set(owner, next)
    try {
      await next
    } finally {
      if (queues.get(owner) === next) queues.delete(owner)
    }
    return result
  }

  /**
   * 本地命令（M5）：与桌面共用同一个 `createCommandHandler` 实例（同一份「等名字 / 等 confirm」状态）。
   * 命中的命令不调模型、不计生命、不占每分钟额度，也不进问答队列（方案 §6.2）。
   * 返回 true = 这条消息已经被命令吃掉，不再走提问。
   */
  const command = deps.command
  const tryCommand = async (inbound: QqInbound): Promise<boolean> => {
    if (command === undefined) return false
    let handled: ChainAskResult | null
    try {
      handled = await command(inbound.text, { conversationId: conversationFor(inbound.userId) })
    } catch (error) {
      log('warn', 'qq command failed', { userId: inbound.userId, error: String(error) })
      await warnOnce(inbound.userId, '命令没跑成，细节看日志。')
      return true
    }
    if (handled === null) return false
    const parts = await sendParts(inbound.userId, formatAskResult(handled))
    log('info', 'qq command handled', { userId: inbound.userId, parts })
    return true
  }

  const answer = async (inbound: QqInbound): Promise<void> => {
    const conversationId = conversationFor(inbound.userId)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    // 挂着「要不要接着查」时，回 1 / 2 是选择，不是新问题（没接续查能力就当普通提问）
    const pendingChoice = pendingChoices.get(conversationId)
    const decision =
      pendingChoice !== undefined && deps.resume !== undefined
        ? parseResumeChoice(inbound.text)
        : null
    const resume = decision !== null && pendingChoice !== undefined ? deps.resume : undefined
    try {
      let result: ChainAskResult
      if (resume !== undefined && pendingChoice !== undefined && decision !== null) {
        timer = setTimeout(() => controller.abort(), askTimeoutMs)
        result = await resume({
          resumeId: pendingChoice.resumeId,
          decision,
          conversationId,
          question: pendingChoice.question,
          signal: controller.signal
        })
      } else {
        // 先取图 / 文件（各自超时），再开始算问答超时：下载慢不该把模型请求挤掉
        const images = await resolveImages(inbound.images)
        const filesAttached = await resolveFiles(inbound.files)
        // D96：解引用放在台账记账之前，记下的那条才带得上 quoteSeq
        const quote = await resolveQuote(inbound, conversationId)
        chatLog?.append(conversationId, {
          qqId: inbound.messageId,
          role: 'user',
          text: inbound.text,
          at: inbound.at,
          imageCount: inbound.images?.length ?? 0,
          ...(quote.quoted !== undefined && quote.quoted.missing !== true
            ? { quoteSeq: quote.quoted.id }
            : {})
        })
        const recent = chatLog
          ?.recent(conversationId, 6)
          .map((record) => ({
            id: record.seq,
            from: record.role,
            at: record.at,
            text:
              record.text !== '' ? record.text : record.imageCount > 0 ? '[图片]' : ''
          }))
        const allImages = [...images, ...filesAttached.images]
        // 被引用图最多 1 张；本轮已经有 4 张用户图时不再追加
        const room = Math.max(0, QQ_INBOUND_IMAGE_MAX - allImages.length)
        allImages.push(...quote.images.slice(0, room))
        // 只有引用 / 只有图、没打字：给一句中性的「问题」，让这一轮有东西可答
        const question =
          inbound.text.trim() !== ''
            ? inbound.text
            : quote.quoted !== undefined
              ? '（引用了这条消息，没有另外打字）'
              : '（发来附件，没有另外打字）'
        timer = setTimeout(() => controller.abort(), askTimeoutMs)
        result = await deps.ask({
          text: question,
          conversationId,
          signal: controller.signal,
          ...(allImages.length > 0 ? { images: allImages } : {}),
          ...(filesAttached.files.length > 0 ? { files: filesAttached.files } : {}),
          ...(quote.quoted !== undefined ? { quoted: quote.quoted } : {}),
          ...(recent !== undefined && recent.length > 0 ? { recent } : {})
        })
      }
      // 记住 / 清掉「要不要接着查」：续查之后又是 continue-ask 就换成新的 resumeId
      if (result.kind === 'continue-ask' && result.resumeId !== undefined) {
        pendingChoices.set(conversationId, {
          resumeId: result.resumeId,
          question:
            resume !== undefined && pendingChoice !== undefined
              ? pendingChoice.question
              : inbound.text
        })
      } else {
        pendingChoices.delete(conversationId)
      }
      const parts = await sendParts(inbound.userId, formatAskResult(result), result.replyTo)
      // 文字先送达，再发图（D96 / PR2 §6.4）；图失败不影响已经发出去的文字
      await sendOutboundMedia(inbound.userId, result.outboundMedia)
      log('info', 'qq answered', {
        userId: inbound.userId,
        kind: result.kind,
        parts,
        ...(decision !== null ? { resumed: decision } : {})
      })
    } catch (error) {
      log('warn', 'qq answer failed', { userId: inbound.userId, error: String(error) })
      const aborted = controller.signal.aborted
      await warnOnce(
        inbound.userId,
        aborted ? '这条查得太久了，先停在这。' : '这次没问出来，待会儿再试。'
      )
    } finally {
      if (timer !== null) clearTimeout(timer)
      pending = Math.max(0, pending - 1)
    }
  }

  const handleMessage = async (inbound: QqInbound): Promise<void> => {
    if (!running) return
    if (!allow(inbound.userId)) {
      log('warn', 'qq message from non-allowlisted user dropped', { userId: inbound.userId })
      return
    }
    // D111：入站本身留一条痕。排障时「最后一条入站是什么时候」比任何在线标志都可靠
    // （2026-11-09 19:42–21:38 静默断流时，登录态、WS、出站全绿，只有这里会停）。
    const now = Date.now()
    const gapMs = lastInboundAt === null ? null : now - lastInboundAt
    lastInboundAt = now
    log('info', 'qq inbound', {
      userId: inbound.userId,
      chars: Array.from(inbound.text).length,
      ...(gapMs !== null ? { gapMs } : {})
    })
    // 命令放最前（与桌面 `ask:query` 一致）：参数可以比提问长，也不该吃限流 / 排队名额
    if (await tryCommand(inbound)) return
    if (Array.from(inbound.text).length > QQ_QUESTION_MAX_CHARS) {
      await warnOnce(inbound.userId, `问题太长了（上限 ${QQ_QUESTION_MAX_CHARS} 字），只说关键那句吧。`)
      return
    }
    if (rateLimited(inbound.userId)) {
      await warnOnce(inbound.userId, '一分钟内问得太多了，缓一下。')
      return
    }
    if (pending >= maxQueue) {
      await warnOnce(inbound.userId, '前面还有几问没答完，稍等。')
      return
    }
    pending += 1
    const previous = queues.get(inbound.userId) ?? Promise.resolve()
    const next = previous.then(() => answer(inbound)).catch((error: unknown) => {
      log('warn', 'qq queue task failed', { error: String(error) })
    })
    queues.set(inbound.userId, next)
    next.finally(() => {
      // 队尾跑完就摘掉，别让 Map 按用户数无限涨
      if (queues.get(inbound.userId) === next) queues.delete(inbound.userId)
    })
    await next
  }

  return {
    async start(next) {
      if (running) await this.stop()
      config = next
      // 重配 / 重启后，旧的续查检查点已经不可用：待选一并作废，别让「1」接上个世纪的检查点
      pendingChoices.clear()
      if (!next.enabled) {
        lastError = undefined
        return { ok: true }
      }
      if (next.allowUsers.length === 0) {
        lastError = '白名单为空：填上允许的 QQ 号再开'
        running = false
        return { ok: false, error: lastError }
      }
      if (next.accessToken.trim().length < 8) {
        lastError = 'access_token 至少 8 位（与 NapCat 里填的一致）'
        running = false
        return { ok: false, error: lastError }
      }
      try {
        const started = await transport.start({
          // 默认只本机；设置里显式允许局域网才绑 0.0.0.0（token 仍是唯一门槛）
          host: next.host,
          port: next.port,
          accessToken: next.accessToken,
          onMessage: (inbound) => {
            void handleMessage(inbound)
          },
          ...(deps.onAccountOffline !== undefined ? { onAccountOffline: deps.onAccountOffline } : {}),
          log
        })
        running = true
        lastError = undefined
        log('info', 'qq channel started', {
          host: next.host,
          port: started.port,
          allow: next.allowUsers.length
        })
        return { ok: true, port: started.port }
      } catch (error) {
        running = false
        lastError = `端口 ${next.port} 起不来：${String(error)}`
        log('error', 'qq channel start failed', { error: String(error) })
        return { ok: false, error: lastError }
      }
    },
    async stop() {
      const wasRunning = running
      running = false
      // 排队里的任务还在跑也要能停：先关传输，再等队列自己失败
      if (wasRunning) {
        try {
          await transport.stop()
        } catch (error) {
          log('warn', 'qq transport stop failed', { error: String(error) })
        }
      }
      queues.clear()
      windows.clear()
      warnedAt.clear()
      pending = 0
    },
    status() {
      const transportStatus = transport.status()
      return {
        ...transportStatus,
        running,
        port: transportStatus.port,
        lastInboundAt,
        ...(lastError !== undefined ? { lastError } : {})
      }
    },
    handleMessage,
    isRunning: () => running,
    push,
    async setProfile(nickname: string) {
      if (transport.setProfile === undefined) return
      await transport.setProfile(nickname)
    }
  }
}
