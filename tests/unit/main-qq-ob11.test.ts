/**
 * QQ 通道 · OneBot 11 协议层（D63）
 *
 * 守四件事：
 * 1. 入站只认私聊文字（群聊 / 自己 / 空文本一律 null）；
 * 2. 段数组与 CQ 字符串两条路都能归一成纯文本，非文字段留占位符；
 * 3. 反向 WS 的 token 校验是 fail-closed（错了直接 1008 关掉）；
 * 4. 长答分条不漏字、不劈坏 emoji，Markdown 不原样回给 QQ。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import {
  parsePrivateMessageEvent,
  QqOb11Server,
  segmentsToText
} from '../../src/main/qq/ob11'
import { splitForQq, stripMarkdown } from '../../src/main/qq/channel'

const TOKEN = 'test-token-1234'

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 10001,
    user_id: 20002,
    time: 1_700_000_000,
    message_id: 90,
    message: [{ type: 'text', data: { text: '我下午在干嘛' } }],
    sender: { nickname: '测试' },
    ...overrides
  }
}

describe('入站解析', () => {
  it('私聊文字 → QqInbound（秒转毫秒）', () => {
    const inbound = parsePrivateMessageEvent(event())
    expect(inbound).toEqual({
      userId: 20002,
      nickname: '测试',
      text: '我下午在干嘛',
      messageId: 90,
      at: 1_700_000_000_000
    })
  })

  it('群聊 / 自己发给自己 / 空文本 / 非 message 一律 null', () => {
    expect(parsePrivateMessageEvent(event({ message_type: 'group' }))).toBeNull()
    expect(parsePrivateMessageEvent(event({ user_id: 10001 }))).toBeNull()
    expect(parsePrivateMessageEvent(event({ message: [] }))).toBeNull()
    expect(parsePrivateMessageEvent(event({ post_type: 'meta_event' }))).toBeNull()
    expect(parsePrivateMessageEvent(null)).toBeNull()
    expect(parsePrivateMessageEvent('x')).toBeNull()
  })

  it('CQ 字符串回退：图片留占位、@ 与回复丢掉、转义还原', () => {
    const inbound = parsePrivateMessageEvent(
      event({ message: '[CQ:reply,id=1]看这个[CQ:image,file=a.png] &amp; [CQ:face,id=1]' })
    )
    expect(inbound?.text).toBe('看这个[图片] & [表情]')
  })

  it('段数组：非文字段只留占位符，at 不参与文本', () => {
    expect(
      segmentsToText([
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: '帮我找' } },
        { type: 'image', data: { file: 'x.png' } },
        { type: 'record', data: { file: 'y.amr' } },
        { type: 'bogus', data: {} }
      ])
    ).toBe('帮我找[图片][语音]')
  })
})

describe('回复成形', () => {
  it('剥 Markdown：代码围栏 / 行内 code / 标题 / 粗体 / 链接', () => {
    const text = [
      '## 标题',
      '**结论**：你下午在改 `persona.ts`。',
      '见 [文档](https://example.com/a/b)',
      '```ts',
      'const a = 1',
      '```'
    ].join('\n')
    expect(stripMarkdown(text)).toBe('标题\n结论：你下午在改 persona.ts。\n见 文档\nconst a = 1')
  })

  it('短答不分条；长答按行切成多条且每条不超过上限', () => {
    expect(splitForQq('就一句', 1_800)).toEqual(['就一句'])
    const paragraph = '这是一段话。'.repeat(60) // 360 字
    const parts = splitForQq(Array(6).fill(paragraph).join('\n'), 400)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(Array.from(part).length).toBeLessThanOrEqual(400)
    expect(parts.join('')).toContain(paragraph.slice(0, 10))
  })

  it('超长单行按码点硬切（不劈坏 emoji），且总条数封顶并提示「到桌面看」', () => {
    const text = '🐟'.repeat(50)
    const parts = splitForQq(text, 200)
    expect(parts).toEqual(['🐟'.repeat(50)])

    const many = Array.from({ length: 12 }, (_, i) => `第 ${i} 条${'字'.repeat(100)}`).join('\n')
    const capped = splitForQq(many, 200, 3)
    expect(capped.length).toBe(3)
    expect(capped[capped.length - 1]).toContain('（还有更多，到桌面看）')
  })
})

describe('反向 WS 服务端', () => {
  let server: QqOb11Server | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  it('token 不对直接断开；对了才转发事件，重复 message_id 只处理一次', async () => {
    const received: string[] = []
    server = new QqOb11Server()
    const { port } = await server.start({
      port: 0,
      accessToken: TOKEN,
      onMessage: (inbound) => received.push(inbound.text)
    })

    const rejected = new WebSocket(`ws://127.0.0.1:${port}?access_token=wrong-token`)
    const rejectedClose = await new Promise<number>((resolve) => {
      rejected.on('close', (code) => resolve(code))
    })
    expect(rejectedClose).toBe(1008)

    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.send(JSON.stringify(event()))
    socket.send(JSON.stringify(event()))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(received).toEqual(['我下午在干嘛'])
    socket.close()
  })

  it('sendPrivate 走 action/echo 并等回执；retcode 非 0 就报错', async () => {
    server = new QqOb11Server()
    const { port } = await server.start({ port: 0, accessToken: TOKEN, onMessage: () => {} })

    const socket = new WebSocket(`ws://127.0.0.1:${port}?access_token=${TOKEN}`)
    const actions: Record<string, unknown>[] = []
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      actions.push(frame)
      const echo = frame['echo']
      const params = frame['params'] as Record<string, unknown>
      socket.send(
        JSON.stringify({
          status: 'ok',
          retcode: params['user_id'] === 20002 ? 0 : 100,
          echo
        })
      )
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    await server.sendPrivate(20002, '收到')
    expect(actions[0]).toMatchObject({
      action: 'send_private_msg',
      params: { user_id: 20002, message: [{ type: 'text', data: { text: '收到' } }] }
    })
    await expect(server.sendPrivate(99999, 'x')).rejects.toThrow('OneBot 发送失败（100）')
    socket.close()
  })
})
