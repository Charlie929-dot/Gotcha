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

import type { ChainAskResult } from '../../chain/agent/types'
import type { QqInbound, QqLog, QqTransportStatus } from './ob11'
import { QQ_INBOUND_IMAGE_MAX } from './ob11'
import { downloadImageAsDataUrl, imageDataUrlFromBase64 } from './media'

/** 传输层的最小契约（真实实现是 `QqOb11Server`；测试里换成假实现） */
export interface QqTransport {
  start(options: {
    host: string
    port: number
    accessToken: string
    onMessage: (inbound: QqInbound) => void
    log: QqLog
  }): Promise<{ port: number }>
  stop(): Promise<void>
  sendPrivate(userId: number, text: string): Promise<void>
  /** NapCat `get_image`：拿 base64（优先）或 url（兜底） */
  getImage(file: string): Promise<{ base64?: string; url?: string }>
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
  /** 每个 QQ 用户一个会话（`qq:<userId>`），上下文按它取 */
  conversationId: string
  signal: AbortSignal
  /** 本条消息里的图片（data URL；最多 4 张；取不到就空） */
  images?: readonly string[]
}

export interface QqChannelDeps {
  ask: (input: QqAskInput) => Promise<ChainAskResult>
  log: QqLog
  now?: () => number
  /** 每用户每分钟最多几条（默认 6） */
  perMinute?: number
  /** 全局排队上限（默认 8）：超了回一句「排队中」 */
  maxQueue?: number
  /** 一次问答的超时（默认 180s） */
  askTimeoutMs?: number
  /** 分条之间隔多久（默认 200ms；测试传 0） */
  partGapMs?: number
}

export interface QqChannelStatus extends QqTransportStatus {
  running: boolean
  lastError?: string
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
    case 'continue-ask':
      // M1 不通续查（续查要在桌面点选）：把问题与候选原样带回去，并说明入口
      return [
        result.question,
        ...result.options.map((option, index) => `${index + 1}. ${option}`),
        '',
        '这条要接着查得回桌面点一下；QQ 里先按现有结果收尾。'
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
  const queues = new Map<number, Promise<void>>()
  const windows = new Map<number, { start: number; count: number }>()
  const warnedAt = new Map<number, number>()

  const log = deps.log

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

  const allow = (userId: number): boolean => {
    // 白名单为空 = 谁都别问（fail-closed）；设置层也会挡，这里是最后一道
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
      await transport.sendPrivate(userId, text)
    } catch (error) {
      log('warn', 'qq reply failed', { error: String(error) })
    }
  }

  const answer = async (inbound: QqInbound): Promise<void> => {
    const conversationId = `qq-${inbound.userId}`
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      // 先取图（各自超时），再开始算问答超时：下载慢不该把模型请求挤掉
      const images = await resolveImages(inbound.images)
      timer = setTimeout(() => controller.abort(), askTimeoutMs)
      const result = await deps.ask({
        text: inbound.text,
        conversationId,
        signal: controller.signal,
        ...(images.length > 0 ? { images } : {})
      })
      const text = formatAskResult(result)
      const parts = splitForQq(text, config?.replyMaxChars ?? QQ_REPLY_DEFAULT_CHARS)
      for (const part of parts) {
        await transport.sendPrivate(inbound.userId, part)
        // 段与段之间留一口气：连发太快时 QQ 侧偶发乱序 / 折叠（默认 200ms，测试传 0）
        if (parts.length > 1 && partGapMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, partGapMs))
        }
      }
      log('info', 'qq answered', {
        userId: inbound.userId,
        kind: result.kind,
        parts: parts.length
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
        ...(lastError !== undefined ? { lastError } : {})
      }
    },
    handleMessage,
    isRunning: () => running,
    async setProfile(nickname: string) {
      if (transport.setProfile === undefined) return
      await transport.setProfile(nickname)
    }
  }
}
