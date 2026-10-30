/**
 * QQ 通道 · 通道层（D63）
 *
 * 传输层是假的（不打真端口），这里只守通道自己的规矩：
 * 默认关 / 白名单 fail-closed / 每用户串行 / 限流 / 长答分条 / 错误如实回一句。
 */

import { describe, expect, it } from 'vitest'

import type { ChainAskResult } from '../../src/chain/agent/types'
import {
  createQqChannel,
  formatAskResult,
  type QqChannelConfig,
  type QqTransport
} from '../../src/main/qq/channel'
import type { QqInbound } from '../../src/main/qq/ob11'

class FakeTransport implements QqTransport {
  started: { host: string; port: number; accessToken: string; onMessage: (inbound: QqInbound) => void } | null =
    null
  sent: { userId: number; text: string }[] = []
  private state = { listening: false, connections: 0, port: null as number | null }

  async start(options: {
    host: string
    port: number
    accessToken: string
    onMessage: (inbound: QqInbound) => void
  }): Promise<{ port: number }> {
    this.started = options
    this.state = { listening: true, connections: 1, port: options.port }
    return { port: options.port }
  }

  async stop(): Promise<void> {
    this.started = null
    this.state = { listening: false, connections: 0, port: null }
  }

  async sendPrivate(userId: number, text: string): Promise<void> {
    this.sent.push({ userId, text })
  }

  status(): { listening: boolean; connections: number; port: number | null } {
    return this.state
  }
}

function config(overrides: Partial<QqChannelConfig> = {}): QqChannelConfig {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 8_643,
    accessToken: 'secret-token-1',
    allowUsers: ['20002'],
    replyMaxChars: 1_800,
    ...overrides
  }
}

function inbound(text: string, userId = 20002): QqInbound {
  return { userId, nickname: '测试', text, messageId: Math.floor(Math.random() * 1e9), at: Date.now() }
}

function answer(text: string): ChainAskResult {
  return {
    kind: 'answer',
    answer: text,
    citations: [{ segmentId: 1, at: Date.UTC(2026, 9, 30, 6, 23), app: 'Chrome', title: '某页', why: '相关' }],
    stats: { hits: 3, evidence: 1, cited: 1, questionChars: 6 }
  }
}

function stats(): { hits: number; evidence: number; cited: number; questionChars: number } {
  return { hits: 0, evidence: 0, cited: 0, questionChars: 6 }
}

describe('开关与白名单（fail-closed）', () => {
  it('默认关：不起传输、不占端口', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, { ask: async () => answer('x'), log: () => {} })
    const result = await channel.start(config({ enabled: false }))
    expect(result.ok).toBe(true)
    expect(transport.started).toBeNull()
    expect(channel.status().running).toBe(false)
  })

  it('白名单为空 / token 太短 → 不起，并给出原因', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, { ask: async () => answer('x'), log: () => {} })
    expect((await channel.start(config({ allowUsers: [] }))).ok).toBe(false)
    expect(transport.started).toBeNull()
    expect((await channel.start(config({ accessToken: 'short' }))).ok).toBe(false)
    expect(transport.started).toBeNull()
  })

  it('监听地址：默认 127.0.0.1；允许局域网时透传 0.0.0.0', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, { ask: async () => answer('x'), log: () => {} })
    await channel.start(config())
    expect(transport.started?.host).toBe('127.0.0.1')
    await channel.start(config({ host: '0.0.0.0' }))
    expect(transport.started?.host).toBe('0.0.0.0')
  })

  it('自聊：白名单里填自己的号，自己发给自己也能问（会话按自己号派生）', async () => {
    const transport = new FakeTransport()
    const asked: { text: string; conversationId: string }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ text, conversationId }) => {
        asked.push({ text, conversationId })
        return answer('在')
      },
      log: () => {}
    })
    await channel.start(config({ allowUsers: ['10001'] }))
    await channel.handleMessage(inbound('在吗', 10001))
    expect(asked).toEqual([{ text: '在吗', conversationId: 'qq-10001' }])
    expect(transport.sent).toEqual([{ userId: 10001, text: expect.stringContaining('在') }])
  })

  it('非白名单号的消息直接丢：不问答、不回话', async () => {
    const transport = new FakeTransport()
    let asked = 0
    const channel = createQqChannel(transport, {
      ask: async () => {
        asked += 1
        return answer('x')
      },
      log: () => {}
    })
    await channel.start(config())
    await channel.handleMessage(inbound('我下午在干嘛', 99999))
    expect(asked).toBe(0)
    expect(transport.sent).toEqual([])
  })
})

describe('一次问答', () => {
  it('白名单私聊 → 走注入的 ask（会话 id 按用户派生）→ 回正文 + 参考行', async () => {
    const transport = new FakeTransport()
    const asked: { text: string; conversationId: string }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ text, conversationId }) => {
        asked.push({ text, conversationId })
        return answer('你下午在改 **persona.ts**。')
      },
      log: () => {}
    })
    await channel.start(config())
    await channel.handleMessage(inbound('我下午在干嘛'))
    expect(asked).toEqual([{ text: '我下午在干嘛', conversationId: 'qq-20002' }])
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.text).toContain('你下午在改 persona.ts。')
    expect(transport.sent[0]!.text).toContain('参考：')
    expect(transport.sent[0]!.text).toContain('Chrome')
  })

  it('长答自动分条，每条不超过上限', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, {
      ask: async () => answer(Array.from({ length: 30 }, (_, i) => `第 ${i} 行：` + '字'.repeat(80)).join('\n')),
      log: () => {}
    })
    await channel.start(config({ replyMaxChars: 400 }))
    await channel.handleMessage(inbound('长一点'))
    expect(transport.sent.length).toBeGreaterThan(1)
    for (const item of transport.sent) expect(Array.from(item.text).length).toBeLessThanOrEqual(400)
  })

  it('错误如实翻译：出网没确认 / 额度用完', () => {
    expect(formatAskResult({ kind: 'error', reason: 'consent', message: 'x', stats: stats() })).toContain(
      '出网确认'
    )
    expect(formatAskResult({ kind: 'error', reason: 'budget', message: 'x', stats: stats() })).toContain(
      '额度用完'
    )
  })

  it('限流：一分钟内超量只警告一次，超出的不再问', async () => {
    const transport = new FakeTransport()
    let asked = 0
    const channel = createQqChannel(transport, {
      ask: async () => {
        asked += 1
        return answer('好')
      },
      log: () => {},
      perMinute: 2
    })
    await channel.start(config())
    await channel.handleMessage(inbound('一'))
    await channel.handleMessage(inbound('二'))
    await channel.handleMessage(inbound('三'))
    await channel.handleMessage(inbound('四'))
    expect(asked).toBe(2)
    const warnings = transport.sent.filter((item) => item.text.includes('太多了'))
    expect(warnings).toHaveLength(1)
  })
})
