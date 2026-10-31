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

/** 一条可处理的私聊消息（已归一：纯文本 + 发送者 + 时刻 + 图片引用） */
export interface QqInbound {
  userId: number
  nickname: string
  text: string
  messageId: number
  /** 毫秒时间戳（NapCat 给的是秒，这里乘 1000；缺省用收到的时间） */
  at: number
  /** 这条消息里的图片引用（最多 4 张；拿不到图的会跳过） */
  images?: readonly QqImageRef[]
  /**
   * 这条消息里的文件引用（D88，最多 4 个）。QQ 有时把图片当「文件」发，
   * 通道会按扩展名再判一次：是图就取字节当图，是文本就取正文。
   */
  files?: readonly QqFileRef[]
}

/** 图片段里的引用：`file` 可交给 OneBot `get_image`，`url` 是可直接下载的地址 */
export interface QqImageRef {
  file?: string
  url?: string
}

/** 文件段里的引用：`name` 给模型看，`file` / `fileId` / `url` 用来取字节 */
export interface QqFileRef {
  /** 文件名（能拿到就给；扩展名是后面判图片 / 文本的依据） */
  name?: string
  /** OneBot 的 file 字段（文件名或 id，形态看实现） */
  file?: string
  /** NapCat 的 file_id（取下载地址用） */
  fileId?: string
  /** 直链（有就直接下载） */
  url?: string
}

/** 一条消息里的图片上限（与桌面附件一致） */
export const QQ_INBOUND_IMAGE_MAX = 4
/** 一条消息里的文件上限（D88） */
export const QQ_INBOUND_FILE_MAX = 4

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

/** CQ 码参数（`file=xxx,url=yyy`）→ 对象；解码 CQ 转义 */
function cqParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const value = part
      .slice(index + 1)
      .replace(/&#91;/gu, '[')
      .replace(/&#93;/gu, ']')
      .replace(/&#44;/gu, ',')
      .replace(/&amp;/gu, '&')
    if (key !== '') out[key] = value
  }
  return out
}

/** 图片段 → `QqImageRef`；文件名 / url 都空就当没有 */
function imageRefOf(data: Record<string, unknown>): QqImageRef | null {
  const file = typeof data['file'] === 'string' ? data['file'].trim() : ''
  const url = typeof data['url'] === 'string' ? data['url'].trim() : ''
  if (file === '' && url === '') return null
  return {
    ...(file !== '' ? { file } : {}),
    ...(url !== '' ? { url } : {})
  }
}

function pushImage(images: QqImageRef[], ref: QqImageRef | null): void {
  if (ref === null || images.length >= QQ_INBOUND_IMAGE_MAX) return
  if (images.some((item) => item.file === ref.file && item.url === ref.url)) return
  images.push(ref)
}

/** 文件段的文件名：优先 file_name / name，其次 file 字段的 basename */
function fileNameOf(data: Record<string, unknown>): string {
  for (const key of ['file_name', 'name', 'file']) {
    const value = data[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    const base = trimmed.split(/[\\/]/u).pop() ?? trimmed
    if (base !== '') return base.slice(0, 120)
  }
  return ''
}

/** 文件段 → `QqFileRef`；文件名 / file / file_id / url 全空就当没有 */
function fileRefOf(data: Record<string, unknown>): QqFileRef | null {
  const name = fileNameOf(data)
  const file = typeof data['file'] === 'string' ? data['file'].trim() : ''
  const fileId = typeof data['file_id'] === 'string' ? data['file_id'].trim() : ''
  const url = typeof data['url'] === 'string' ? data['url'].trim() : ''
  if (name === '' && file === '' && fileId === '' && url === '') return null
  return {
    ...(name !== '' ? { name } : {}),
    ...(file !== '' ? { file } : {}),
    ...(fileId !== '' ? { fileId } : {}),
    ...(url !== '' ? { url } : {})
  }
}

function pushFile(files: QqFileRef[], ref: QqFileRef | null): void {
  if (ref === null || files.length >= QQ_INBOUND_FILE_MAX) return
  if (files.some((item) => item.file === ref.file && item.url === ref.url)) return
  files.push(ref)
}

/** 文件段的占位符（D88）：带上文件名，让模型知道「这里有个 xxx，但我没拿到内容」 */
function filePlaceholderText(ref: QqFileRef): string {
  return ref.name !== undefined && ref.name !== '' ? `[文件：${ref.name}]` : '[文件]'
}

/** CQ 字符串 → 纯文本 + 图片引用（只留 text 段，其余按占位符；`at` / `reply` 直接丢） */
function parseCqMessage(raw: string): { text: string; images: QqImageRef[]; files: QqFileRef[] } {
  const images: QqImageRef[] = []
  const files: QqFileRef[] = []
  const text = raw
    .replace(CQ_RE, (_match: string, type: string, params: string) => {
      if (type === 'at' || type === 'reply') return ''
      if (type === 'image') {
        pushImage(images, imageRefOf(cqParams(params)))
        return '[图片]'
      }
      if (type === 'file') {
        const ref = fileRefOf(cqParams(params))
        pushFile(files, ref)
        return ref === null ? '[文件]' : filePlaceholderText(ref)
      }
      return SEGMENT_PLACEHOLDER[type] ?? ''
    })
    // CQ 码里的转义（OneBot 11 §CQ 码转义）
    .replace(/&#91;/gu, '[')
    .replace(/&#93;/gu, ']')
    .replace(/&#44;/gu, ',')
    .replace(/&amp;/gu, '&')
  return { text, images, files }
}

/**
 * 报文里的 `message` → 纯文本 + 图片 / 文件引用。
 * 段数组优先（NapCat 的默认形态）；字符串按 CQ 码解析；其它形态当空。
 */
export function parseMessageContent(message: unknown): {
  text: string
  images: QqImageRef[]
  files: QqFileRef[]
} {
  if (typeof message === 'string') {
    const parsed = parseCqMessage(message)
    return {
      text: parsed.text.replace(/\r\n/gu, '\n').trim(),
      images: parsed.images,
      files: parsed.files
    }
  }
  if (!Array.isArray(message)) return { text: '', images: [], files: [] }
  let out = ''
  const images: QqImageRef[] = []
  const files: QqFileRef[] = []
  for (const segment of message) {
    if (!isPlainObject(segment)) continue
    const type = typeof segment.type === 'string' ? segment.type : ''
    const data = isPlainObject(segment.data) ? segment.data : {}
    if (type === 'text') {
      out += typeof data['text'] === 'string' ? (data['text'] as string) : ''
      continue
    }
    if (type === 'at' || type === 'reply') continue
    if (type === 'image') {
      pushImage(images, imageRefOf(data))
      out += '[图片]'
      continue
    }
    if (type === 'file') {
      const ref = fileRefOf(data)
      pushFile(files, ref)
      out += ref === null ? '[文件]' : filePlaceholderText(ref)
      continue
    }
    out += SEGMENT_PLACEHOLDER[type] ?? ''
  }
  return { text: out.replace(/\r\n/gu, '\n').trim(), images, files }
}

/** 兼容旧调用方：只要纯文本 */
export function segmentsToText(message: unknown): string {
  return parseMessageContent(message).text
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
  // 不再拒绝「自己发给自己」（userId === selfId）：2026-10-30 拍板「所有你都帮我做吧」——
  // 自用场景就是拿自己号当机器人，从手机 QQ 给自己发消息。
  // 防回声交给服务端的「自己发出的 message_id 环」：机器人回的消息若被实现方以 message 事件回放，
  // 这里按 message_id 丢掉（OneBot 11 正常用 message_sent，本就不解析）。
  const parsed = parseMessageContent(raw['message'])
  const text = parsed.text
  if (text === '') return null
  const sender = isPlainObject(raw['sender']) ? raw['sender'] : {}
  const nickname = typeof sender['nickname'] === 'string' ? (sender['nickname'] as string).slice(0, 40) : ''
  const seconds = typeof raw['time'] === 'number' ? raw['time'] : NaN
  return {
    userId,
    nickname,
    text,
    messageId: positiveInt(raw['message_id']) ?? 0,
    at: Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now(),
    ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
    ...(parsed.files.length > 0 ? { files: parsed.files } : {})
  }
}

/** OneBot API 回执（只取用得上的几个字段） */
interface Ob11Response {
  status?: string
  retcode?: number
  wording?: string
  data?: unknown
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
  /**
   * 我们自己发出去的 message_id（上限 100 条）：同一号自聊时，
   * 有些 OneBot 实现会把机器人发的消息也当成 `message` 事件回放——按 id 丢掉，防自问自答死循环。
   */
  private readonly selfSent = new Set<number>()
  private readonly selfSentOrder: number[] = []
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
      // 自聊回声：机器人自己发出去的那条又作为 message 事件回来 → 丢掉（否则会自问自答）
      if (this.selfSent.has(inbound.messageId)) {
        this.log('info', 'qq own message ignored', { messageId: inbound.messageId })
        return
      }
      this.seenMessages.add(inbound.messageId)
      this.seenOrder.push(inbound.messageId)
      if (this.seenOrder.length > 200) {
        const oldest = this.seenOrder.shift()
        if (oldest !== undefined) this.seenMessages.delete(oldest)
      }
    }
    this.onMessage?.(inbound)
  }

  /** OneBot action 调用：发一条带 echo 的请求并等回执（所有 API 共用） */
  private async callAction(action: string, params: Record<string, unknown>): Promise<Ob11Response> {
    const socket = this.activeSocket()
    if (!socket) throw new Error('没有已连接的 OneBot 客户端')
    const echo = `gotcha-${++this.seq}`
    socket.send(JSON.stringify({ action, params, echo }))
    return new Promise<Ob11Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error('OneBot 回执超时'))
      }, this.timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
    })
  }

  /** 把图片文件交给 NapCat 换 base64 / url（M1 只读图，不落盘） */
  async getImage(file: string): Promise<{ base64?: string; url?: string }> {
    const response = await this.callAction('get_image', { file })
    if (typeof response.retcode === 'number' && response.retcode !== 0) {
      throw new Error(`OneBot get_image 失败（${response.retcode}）${response.wording ?? ''}`)
    }
    const data = isPlainObject(response.data) ? response.data : {}
    const base64 = typeof data['base64'] === 'string' ? data['base64'] : ''
    const url = typeof data['url'] === 'string' ? data['url'] : ''
    return {
      ...(base64 !== '' ? { base64 } : {}),
      ...(url !== '' ? { url } : {})
    }
  }

  /**
   * 私聊文件的下载地址（D88）：NapCat 的 `get_private_file_url`。
   * 拿不到就返回 null——调用方会退回「占位符 + 明说没拿到」，不会假装读过。
   */
  async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const response = await this.callAction('get_private_file_url', { file_id: fileId })
      if (typeof response.retcode === 'number' && response.retcode !== 0) return null
      const data = isPlainObject(response.data) ? response.data : {}
      const url = typeof data['url'] === 'string' ? data['url'].trim() : ''
      return url === '' ? null : url
    } catch {
      return null
    }
  }

  /**
   * 改 QQ 昵称（M4 传承）：OneBot `set_qq_profile`。
   * 失败抛错，由调用方记日志——改名失败不该影响传承本身。
   */
  async setProfile(nickname: string): Promise<void> {
    const response = await this.callAction('set_qq_profile', { nickname })
    if (typeof response.retcode === 'number' && response.retcode !== 0) {
      throw new Error(`OneBot set_qq_profile 失败（${response.retcode}）${response.wording ?? ''}`)
    }
  }

  /** 私聊发一条纯文本（OneBot `send_private_msg`） */
  async sendPrivate(userId: number, text: string): Promise<void> {    const response = await this.callAction('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }]
    })
    if (typeof response.retcode === 'number' && response.retcode !== 0) {
      throw new Error(`OneBot 发送失败（${response.retcode}）${response.wording ?? ''}`)
    }
    // 记下自己发出的 message_id：有的实现会把这条再以 message 事件回放
    const data = isPlainObject(response.data) ? response.data : {}
    const sentId = positiveInt(data['message_id'])
    if (sentId !== null) {
      this.selfSent.add(sentId)
      this.selfSentOrder.push(sentId)
      if (this.selfSentOrder.length > 100) {
        const oldest = this.selfSentOrder.shift()
        if (oldest !== undefined) this.selfSent.delete(oldest)
      }
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
