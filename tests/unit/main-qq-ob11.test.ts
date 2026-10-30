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

  it('群聊 / 空文本 / 非 message 一律 null；自己发给自己放行（自聊用法）', () => {
    expect(parsePrivateMessageEvent(event({ message_type: 'group' }))).toBeNull()
    const self = parsePrivateMessageEvent(event({ user_id: 10001 }))
    expect(self).not.toBeNull()
    expect(self?.userId).toBe(10001)
    expect(self?.text).toBe('我下午在干嘛')
    expect(parsePrivateMessageEvent(event({ message: [] }))).toBeNull()
    expect(parsePrivateMessageEvent(event({ post_type: 'meta_event' }))).toBeNull()
    expect(parsePrivateMessageEvent(null)).toBeNull()
    expect(parsePrivateMessageEvent('x')).toBeNull()
  })

  it('CQ 字符串回退：图片留占位并带引用、@ 与回复丢掉、转义还原', () => {
    const inbound = parsePrivateMessageEvent(
      event({ message: '[CQ:reply,id=1]看这个[CQ:image,file=a.png,url=http://x/a.png] &amp; [CQ:face,id=1]' })
    )
    expect(inbound?.text).toBe('看这个[图片] & [表情]')
    expect(inbound?.images).toEqual([{ file: 'a.png', url: 'http://x/a.png' }])
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

  it('图片引用：去重、最多 4 张；纯图消息也能进（文本是 [图片]）', () => {
    const parsed = parsePrivateMessageEvent(
      event({
        message: [
          { type: 'image', data: { file: 'a.png' } },
          { type: 'image', data: { file: 'a.png' } },
          { type: 'image', data: { file: 'b.png' } },
          { type: 'image', data: { file: 'c.png' } },
          { type: 'image', data: { file: 'd.png' } },
          { type: 'image', data: { file: 'e.png' } }
        ]
      })
    )
    expect(parsed?.text).toBe('[图片][图片][图片][图片][图片][图片]')
    expect(parsed?.images?.map((ref) => ref.file)).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
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

  it('按空行分段：多段回答 → 多条消息（2026-10-30 拍板人反馈）', () => {
    const text = '第一段。\n\n第二段，稍长一点。\n\n第三段。'
    expect(splitForQq(text, 1_800)).toEqual(['第一段。', '第二段，稍长一点。', '第三段。'])
  })

  it('短答不分条；单段超上限时按行切成多条且每条不超过上限', () => {
    expect(splitForQq('就一句', 1_800)).toEqual(['就一句'])
    const paragraph = '这是一段话。'.repeat(60) // 360 字（单换行 = 同一段）
    const parts = splitForQq(Array(6).fill(paragraph).join('\n'), 400)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(Array.from(part).length).toBeLessThanOrEqual(400)
    expect(parts.join('')).toContain(paragraph.slice(0, 10))
  })

  it('超长单行按码点硬切（不劈坏 emoji）；超过条数上限时合并而不是丢内容', () => {
    const text = '🐟'.repeat(50)
    expect(splitForQq(text, 200)).toEqual(['🐟'.repeat(50)])

    const many = Array.from({ length: 12 }, (_, i) => `第 ${i} 条${'字'.repeat(100)}`).join('\n')
    const capped = splitForQq(many, 200, 3)
    expect(capped.length).toBe(3)
    // 不丢内容：最后一条把剩下所有行合并进来
    expect(capped[0]).toContain('第 0 条')
    expect(capped[2]).toContain('第 11 条')
    expect(capped[2]).not.toContain('（还有更多，到桌面看）')
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

  it('自聊防回声：自己发出去的消息被回放成 message 事件时按 id 丢弃', async () => {
    const received: string[] = []
    server = new QqOb11Server()
    const { port } = await server.start({
      port: 0,
      accessToken: TOKEN,
      onMessage: (inbound) => received.push(inbound.text)
    })

    const socket = new WebSocket(`ws://127.0.0.1:${port}?access_token=${TOKEN}`)
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      socket.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: { message_id: 777 },
          echo: frame['echo']
        })
      )
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    await server.sendPrivate(10001, '收到')
    // 有的实现会把机器人自己的消息再当成 message 事件回放（自聊时最容易撞上）
    socket.send(JSON.stringify(event({ user_id: 10001, message_id: 777 })))
    socket.send(JSON.stringify(event({ user_id: 10001, message_id: 778 })))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(received).toEqual(['我下午在干嘛'])
    socket.close()
  })
})
