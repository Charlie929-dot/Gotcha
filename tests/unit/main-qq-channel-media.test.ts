/**
 * QQ 通道 · 发图（D96 / PR2）
 *
 * 守这些事：文字先发、图后发；每轮最多 1 表情 + 1 图；闸门挡住就不发；
 * 图发失败只记 warn（文字已经送达，不重发、不吞回答）；传输不支持发图时静默跳过。
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ChainAskResult } from '../../src/chain/agent/types'
import {
  createQqChannel,
  type QqChannelConfig,
  type QqTransport
} from '../../src/main/qq/channel'
import type { QqInbound } from '../../src/main/qq/ob11'

const TINY_PNG = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`

class FakeTransport implements QqTransport {
  sent: { userId: number; text: string }[] = []
  images: { userId: number; dataUrl: string }[] = []
  /** 发图失败一次（验证「文字不受影响」） */
  failImage = false
  private state: { listening: boolean; connections: number; port: number | null } = {
    listening: true,
    connections: 1,
    port: 8_643
  }

  async start(): Promise<{ port: number }> {
    return { port: 8_643 }
  }
  async stop(): Promise<void> {
    this.state = { listening: false, connections: 0, port: null }
  }
  async sendPrivate(userId: number, text: string): Promise<number | null> {
    this.sent.push({ userId, text })
    return 9100 + this.sent.length
  }
  async sendPrivateImage(userId: number, dataUrl: string): Promise<number | null> {
    if (this.failImage) throw new Error('OneBot 发图失败（100）')
    this.images.push({ userId, dataUrl })
    return 9200 + this.images.length
  }
  async getImage(): Promise<{ base64?: string; url?: string }> {
    throw new Error('no image')
  }
  status(): { listening: boolean; connections: number; port: number | null } {
    return this.state
  }
}

function config(): QqChannelConfig {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 8_643,
    accessToken: 'secret-token-1',
    allowUsers: ['20002'],
    replyMaxChars: 1_800
  }
}

function inbound(text: string): QqInbound {
  return { userId: 20002, nickname: '测试', text, messageId: 5, at: Date.now() }
}

function answerWithMedia(
  media: NonNullable<ChainAskResult['outboundMedia']>
): ChainAskResult {
  return {
    kind: 'answer',
    answer: '（翻了个白眼）',
    citations: [],
    stats: { hits: 0, evidence: 0, cited: 0, questionChars: 6 },
    outboundMedia: media
  }
}

const logs: { level: string; message: string; data?: Record<string, unknown> }[] = []

afterEach(() => {
  logs.splice(0)
})

async function run<T extends QqTransport>(
  result: ChainAskResult,
  transport: T = new FakeTransport() as unknown as T,
  gate?: { allow(kind: 'sticker' | 'image', ref?: string): boolean }
): Promise<T> {
  const channel = createQqChannel(transport, {
    ask: async () => result,
    log: (level, message, data) => logs.push({ level, message, ...(data ? { data } : {}) }),
    partGapMs: 0,
    ...(gate !== undefined ? { mediaGate: gate } : {})
  })
  await channel.start(config())
  await channel.handleMessage(inbound('发个无语的表情'))
  await channel.stop()
  return transport
}

describe('文字先发、图后发（D96 / PR2）', () => {
  it('一条回答带表情 + 图：先文字，再表情，再图', async () => {
    const transport = await run(
      answerWithMedia([
        { kind: 'sticker', dataUrl: TINY_PNG, label: '无语', ref: 'a1b2c3d4e5f6' },
        { kind: 'image', dataUrl: TINY_PNG, ref: 'deadbeef' }
      ]),
      new FakeTransport()
    )
    expect(transport.sent).toHaveLength(1)
    expect(transport.images.map((item) => item.dataUrl)).toEqual([TINY_PNG, TINY_PNG])
    expect(transport.images.every((item) => item.userId === 20002)).toBe(true)
  })

  it('每轮最多 1 表情 + 1 图：多出来的不发', async () => {
    const transport = await run(
      answerWithMedia([
        { kind: 'sticker', dataUrl: TINY_PNG, ref: 's1' },
        { kind: 'sticker', dataUrl: TINY_PNG, ref: 's2' },
        { kind: 'image', dataUrl: TINY_PNG, ref: 'i1' },
        { kind: 'image', dataUrl: TINY_PNG, ref: 'i2' }
      ]),
      new FakeTransport()
    )
    expect(transport.images).toHaveLength(2)
  })

  it('闸门挡住表情：表情不发，文字与图照常', async () => {
    const asked: { kind: string; ref?: string }[] = []
    const gate = {
      allow: (kind: 'sticker' | 'image', ref?: string) => {
        asked.push({ kind, ...(ref !== undefined ? { ref } : {}) })
        return kind !== 'sticker'
      }
    }
    const transport = await run(
      answerWithMedia([
        { kind: 'sticker', dataUrl: TINY_PNG, ref: 'a1b2c3d4e5f6' },
        { kind: 'image', dataUrl: TINY_PNG, ref: 'deadbeef' }
      ]),
      new FakeTransport(),
      gate
    )
    expect(asked).toEqual([
      { kind: 'sticker', ref: 'a1b2c3d4e5f6' },
      { kind: 'image', ref: 'deadbeef' }
    ])
    expect(transport.sent).toHaveLength(1)
    expect(transport.images).toHaveLength(1)
  })

  it('图发失败：不抛、不重发文字，只记一条 warn', async () => {
    const transport = new FakeTransport()
    transport.failImage = true
    const done = await run(
      answerWithMedia([{ kind: 'sticker', dataUrl: TINY_PNG, ref: 's1' }]),
      transport
    )
    expect(done.sent).toHaveLength(1)
    expect(done.images).toHaveLength(0)
    expect(logs.some((item) => item.message === 'qq outbound media failed')).toBe(true)
    // 日志只记类型，不记图片内容 / 路径
    expect(JSON.stringify(logs)).not.toContain('base64')
  })

  it('传输不支持发图：静默跳过，文字照常', async () => {
    const transport = new FakeTransport()
    const noImageTransport: QqTransport = {
      start: transport.start.bind(transport),
      stop: transport.stop.bind(transport),
      sendPrivate: transport.sendPrivate.bind(transport),
      getImage: transport.getImage.bind(transport),
      status: transport.status.bind(transport)
    }
    const done = await run(
      answerWithMedia([{ kind: 'sticker', dataUrl: TINY_PNG, ref: 's1' }]),
      noImageTransport
    )
    void done
    expect(transport.sent).toHaveLength(1)
    expect(transport.images).toHaveLength(0)
    expect(logs.some((item) => item.message === 'qq outbound media skipped')).toBe(true)
  })

  it('没有媒体：什么都不多发（老路径不变）', async () => {
    const plain: ChainAskResult = {
      kind: 'answer',
      answer: '在。',
      citations: [],
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 6 }
    }
    const transport = await run(plain, new FakeTransport())
    expect(transport.sent).toHaveLength(1)
    expect(transport.images).toHaveLength(0)
  })
})
