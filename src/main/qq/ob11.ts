/**
 * QQ 通道 · OneBot 11 协议层（M1）
 *
 * 事实源：参考插件 `dsh-onebot-qq`（OneBot 11 + NapCat，见 `docs/agent/decisions.md` D63）。
 * 这里只做两件事，不含任何业务判断：
 *
 * 1. **入站解析**：把 NapCat 推来的 `post_type=message` 报文变成 `QqInbound`——
 *    只认 `message_type=private`（M1 私聊）；段数组优先，CQ 字符串回退；
 *    图片 / 语音 / 文件等非文字段只留占位符（M1 不处理媒体）。
 * 2. **反向 WS 服务端**：NapCat 以 ws-reverse 拨入 `ws://127.0.0.1:<port>`，
 *    我们校验 access_token、收事件、并按 OneBot 的 action/echo 约定回发 API 调用。
 *
 * 纪律：
 * - **只监听 127.0.0.1**（默认；`host` 可改但组合根不传）——QQ 通道是「本机拨入」，
 *   不是对外开端口；
 * - token 只用于比较，**绝不进日志**；
 * - 事件按 `message_id` 去重（NapCat 重连会重发），重复的丢掉。
 */

import { WebSocketServer, type WebSocket, type RawData } from 'ws'

/** 一条可处理的私聊消息（已归一：纯文本 + 发送者 + 时刻） */
export interface QqInbound {
  userId: number
  nickname: string
  text: string
  messageId: number
  /** 毫秒时间戳（NapCat 给的是秒，这里乘 1000；缺省用收到的时间） */
  at: number
}

export type QqLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
) => void

const SEGMENT_PLACEHOLDER: Readonly<Record<string, string>> = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  face: '[表情]',
  mface: '[表情]',
  file: '[文件]',
  forward: '[合并转发]',
  node: '[合并转发]',
  json: '[卡片]',
  xml: '[卡片]',
  share: '[链接]',
  music: '[音乐]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

const CQ_RE = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/gu

/** CQ 字符串 → 纯文本（只留 text 段，其余按占位符；`at` / `reply` 直接丢） */
function cqToText(raw: string): string {
  return raw
    .replace(CQ_RE, (_match: string, type: string) => {
      if (type === 'at' || type === 'reply') return ''
      return SEGMENT_PLACEHOLDER[type] ?? ''
    })
    // CQ 码里的转义（OneBot 11 §CQ 码转义）
    .replace(/&#91;/gu, '[')
    .replace(/&#93;/gu, ']')
    .replace(/&#44;/gu, ',')
    .replace(/&amp;/gu, '&')
}

/**
 * 报文里的 `message` → 纯文本。
 * 段数组优先（NapCat 的默认形态）；字符串按 CQ 码解析；其它形态当空。
 */
export function segmentsToText(message: unknown): string {
  if (typeof message === 'string') {
    return cqToText(message).replace(/\r\n/gu, '\n').trim()
  }
  if (!Array.isArray(message)) return ''
  let out = ''
  for (const segment of message) {
    if (!isPlainObject(segment)) continue
    const type = typeof segment.type === 'string' ? segment.type : ''
    const data = isPlainObject(segment.data) ? segment.data : {}
    if (type === 'text') {
      out += typeof data['text'] === 'string' ? (data['text'] as string) : ''
      continue
    }
    if (type === 'at' || type === 'reply') continue
    out += SEGMENT_PLACEHOLDER[type] ?? ''
  }
  return out.replace(/\r\n/gu, '\n').trim()
}

/**
 * 严格解析一条入站事件：不是私聊消息、缺 user_id、自己发给自己、空文本 → null。
 * 「群聊一律丢」在这里就落定，通道层不需要再判断。
 */
export function parsePrivateMessageEvent(raw: unknown): QqInbound | null {
  if (!isPlainObject(raw)) return null
  if (raw['post_type'] !== 'message') return null
  if (raw['message_type'] !== 'private') return null
  const userId = positiveInt(raw['user_id'])
  const selfId = positiveInt(raw['self_id'])
  if (userId === null || selfId === null) return null
  if (userId === selfId) return null
  const text = segmentsToText(raw['message'])
  if (text === '') return null
  const sender = isPlainObject(raw['sender']) ? raw['sender'] : {}
  const nickname = typeof sender['nickname'] === 'string' ? (sender['nickname'] as string).slice(0, 40) : ''
  const seconds = typeof raw['time'] === 'number' ? raw['time'] : NaN
  return {
    userId,
    nickname,
    text,
    messageId: positiveInt(raw['message_id']) ?? 0,
    at: Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now()
  }
}

/** OneBot API 回执（只取用得上的几个字段） */
interface Ob11Response {
  status?: string
  retcode?: number
  wording?: string
  echo?: string
}

export interface QqServerOptions {
  host?: string
  port: number
  accessToken: string
  onMessage: (inbound: QqInbound) => void
  log?: QqLog
  /** 等回执的超时（默认 10s） */
  timeoutMs?: number
}

export interface QqTransportStatus {
  listening: boolean
  connections: number
  port: number | null
}

/**
 * 反向 WS 服务端：NapCat（ws-reverse）作为客户端拨入。
 *
 * 为什么不是正向（插件拨 NapCat）：拨入模式不需要在 Gotcha 里再存一个 NapCat 端口发现逻辑，
 * 而且「谁连进来」本身就能做白名单校验（token 不符直接 1008 关掉）。
 */
export class QqOb11Server {
  private server: WebSocketServer | null = null
  private readonly sockets = new Set<WebSocket>()
  private readonly pending = new Map<
    string,
    { resolve: (value: Ob11Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  /** 已处理过的 message_id（去重；上限 200 条，防无限涨） */
  private readonly seenMessages = new Set<number>()
  private readonly seenOrder: number[] = []
  private seq = 0
  private port: number | null = null
  private onMessage: ((inbound: QqInbound) => void) | null = null
  private log: QqLog = () => {}
  private timeoutMs = 10_000

  async start(options: QqServerOptions): Promise<{ port: number }> {
    if (this.server) throw new Error('QQ 通道已经启动')
    this.onMessage = options.onMessage
    if (options.log) this.log = options.log
    if (options.timeoutMs && options.timeoutMs > 0) this.timeoutMs = options.timeoutMs

    const host = options.host ?? '127.0.0.1'
    const wss = new WebSocketServer({ host, port: options.port })
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        wss.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        wss.off('listening', onListening)
        reject(error)
      }
      wss.once('listening', onListening)
      wss.once('error', onError)
    })
    // 端口 0（测试用）：把真实端口回给调用方
    const address = wss.address()
    this.port = typeof address === 'object' && address !== null ? address.port : options.port
    this.server = wss

    wss.on('connection', (socket, req) => this.accept(socket, req, options.accessToken))
    wss.on('error', (error) => this.log('error', 'qq ws server error', { error: String(error) }))
    this.log('info', 'qq ws listening', { host, port: this.port })
    return { port: this.port }
  }

  private accept(
    socket: WebSocket,
    req: { headers: Record<string, string | string[] | undefined>; url?: string | undefined },
    accessToken: string
  ): void {
    const header = Array.isArray(req.headers['authorization'])
      ? req.headers['authorization'][0]
      : req.headers['authorization']
    const bearer = typeof header === 'string' && /^Bearer\s+/iu.test(header)
      ? header.replace(/^Bearer\s+/iu, '').trim()
      : ''
    let query = ''
    try {
      query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('access_token') ?? ''
    } catch {
      query = ''
    }
    const provided = bearer !== '' ? bearer : query
    if (provided !== accessToken) {
      // 只说「token 不对」，不把两边的值写进日志
      this.log('warn', 'qq ws rejected', { reason: 'token-mismatch' })
      socket.close(1008, 'unauthorized')
      return
    }
    this.sockets.add(socket)
    this.log('info', 'qq ws connected', { connections: this.sockets.size })
    socket.on('message', (data) => this.receive(data))
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.log('info', 'qq ws closed', { connections: this.sockets.size })
    })
    socket.on('error', (error) => this.log('warn', 'qq ws socket error', { error: String(error) }))
  }

  private receive(data: RawData): void {
    let payload: unknown
    try {
      payload = JSON.parse(data.toString())
    } catch {
      this.log('warn', 'qq ws non-json frame dropped')
      return
    }
    if (!isPlainObject(payload)) return
    // 回执：带 echo 的才是我们发出去的调用
    if (typeof payload['echo'] === 'string') {
      const waiter = this.pending.get(payload['echo'])
      if (waiter) {
        this.pending.delete(payload['echo'])
        clearTimeout(waiter.timer)
        waiter.resolve(payload as Ob11Response)
      }
      return
    }
    const inbound = parsePrivateMessageEvent(payload)
    if (!inbound) {
      // 群聊 / 心跳 / 上线通知：M1 静默丢弃（只记一条 debug 级的 info，不打正文）
      const kind = String(payload['post_type'] ?? 'unknown')
      if (kind !== 'meta_event') this.log('info', 'qq event ignored', { kind })
      return
    }
    if (inbound.messageId > 0) {
      if (this.seenMessages.has(inbound.messageId)) return
      this.seenMessages.add(inbound.messageId)
      this.seenOrder.push(inbound.messageId)
      if (this.seenOrder.length > 200) {
        const oldest = this.seenOrder.shift()
        if (oldest !== undefined) this.seenMessages.delete(oldest)
      }
    }
    this.onMessage?.(inbound)
  }

  /** 私聊发一条纯文本（OneBot `send_private_msg`） */
  async sendPrivate(userId: number, text: string): Promise<void> {
    const socket = this.activeSocket()
    if (!socket) throw new Error('没有已连接的 OneBot 客户端')
    const echo = `gotcha-${++this.seq}`
    socket.send(
      JSON.stringify({
        action: 'send_private_msg',
        params: { user_id: userId, message: [{ type: 'text', data: { text } }] },
        echo
      })
    )
    const response = await new Promise<Ob11Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error('OneBot 回执超时'))
      }, this.timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
    })
    if (typeof response.retcode === 'number' && response.retcode !== 0) {
      throw new Error(`OneBot 发送失败（${response.retcode}）${response.wording ?? ''}`)
    }
  }

  private activeSocket(): WebSocket | null {
    // 反向 WS 通常只有一条连接；有多条时用最后连上来的那条
    let last: WebSocket | null = null
    for (const socket of this.sockets) last = socket
    return last !== null && last.readyState === last.OPEN ? last : null
  }

  status(): QqTransportStatus {
    return { listening: this.server !== null, connections: this.sockets.size, port: this.port }
  }

  async stop(): Promise<void> {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('QQ 通道已停止'))
    }
    this.pending.clear()
    for (const socket of this.sockets) {
      try {
        socket.close(1001, 'shutdown')
      } catch {
        // 关不掉就算了，下面统一 terminate
      }
      try {
        socket.terminate()
      } catch {
        // ignore
      }
    }
    this.sockets.clear()
    const server = this.server
    this.server = null
    this.port = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 有连接卡住时 close 不会回调：给一个兜底
        setTimeout(resolve, 1_000)
      })
    }
    this.log('info', 'qq ws stopped')
  }
}
