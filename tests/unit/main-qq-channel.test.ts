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
  /** file → get_image 回执（测试按需塞） */
  images = new Map<string, { base64?: string; url?: string }>()
  /** 改过的昵称（M4 传承） */
  profiles: string[] = []
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

  async getImage(file: string): Promise<{ base64?: string; url?: string }> {
    const got = this.images.get(file)
    if (!got) throw new Error('no such image')
    return got
  }

  async setProfile(nickname: string): Promise<void> {
    this.profiles.push(nickname)
  }

  status(): { listening: boolean; connections: number; port: number | null } {
    return this.state
  }
}

/** 1×1 PNG（只验 mime / data URL，不验像素） */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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

function inbound(text: string, userId = 20002, images?: QqInbound['images']): QqInbound {
  return {
    userId,
    nickname: '测试',
    text,
    messageId: Math.floor(Math.random() * 1e9),
    at: Date.now(),
    ...(images !== undefined ? { images } : {})
  }
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
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config({ allowUsers: ['10001'] }))
    await channel.handleMessage(inbound('在吗', 10001))
    expect(asked).toEqual([{ text: '在吗', conversationId: 'qq-10001' }])
    expect(transport.sent[0]).toEqual({ userId: 10001, text: expect.stringContaining('在') })
    // 正文与「参考」各成一条，顺序不乱
    expect(transport.sent.every((item) => item.userId === 10001)).toBe(true)
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
  it('白名单私聊 → 走注入的 ask（会话 id 按用户派生）→ 正文与参考各成一条', async () => {
    const transport = new FakeTransport()
    const asked: { text: string; conversationId: string }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ text, conversationId }) => {
        asked.push({ text, conversationId })
        return answer('你下午在改 **persona.ts**。')
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('我下午在干嘛'))
    expect(asked).toEqual([{ text: '我下午在干嘛', conversationId: 'qq-20002' }])
    // 正文一段 + 「参考：」一段 → 两条 QQ 消息（2026-10-30 拍板人要求多段）
    expect(transport.sent).toHaveLength(2)
    expect(transport.sent[0]!.text).toContain('你下午在改 persona.ts。')
    expect(transport.sent[1]!.text).toContain('参考：')
    expect(transport.sent[1]!.text).toContain('Chrome')
  })

  it('多段回答分条发送（每段一条），长段落仍按上限切', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, {
      ask: async () =>
        answer(['第一段。', '第二段。', '第三段。'].join('\n\n')),
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('分段'))
    expect(transport.sent.map((item) => item.text)).toEqual([
      '第一段。',
      '第二段。',
      '第三段。',
      expect.stringContaining('参考：')
    ])
  })

  it('交接回执先单独发一条，再发回答（D85）', async () => {
    const transport = new FakeTransport()
    const receipt = '🎗️提示\n✨<贴心大肥鱼> 生命耗尽  ta的女儿 ✨<鱼苗> 将接续ta的使命'
    const channel = createQqChannel(transport, {
      ask: async () => ({ ...answer('女儿出生了。'), receipt }),
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('生一个吧'))
    const texts = transport.sent.map((item) => item.text)
    expect(texts[0]).toContain('🎗️提示')
    expect(texts[0]).toContain('生命耗尽')
    expect(texts[0]).not.toContain('女儿出生了。')
    expect(texts.slice(1).join('\n')).toContain('女儿出生了。')
  })

  it('formatAskResult：有回执时回执在最前、自成一段（splitForQq 才能分两条）', () => {
    const text = formatAskResult({ ...answer('正文'), receipt: '🎗️提示\n回执行' })
    expect(text.startsWith('🎗️提示')).toBe(true)
    expect(text).toContain('\n\n正文')
    expect(formatAskResult(answer('正文'))).not.toContain('🎗️提示')
  })

  it('长答按上限分条，每条不超过上限', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, {
      ask: async () => answer(Array.from({ length: 30 }, (_, i) => `第 ${i} 行：` + '字'.repeat(80)).join('\n')),
      log: () => {},
      partGapMs: 0
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

describe('图片（D63 追加）', () => {
  it('get_image 返回 base64 → ask 收到 data URL，文本仍带 [图片]', async () => {
    const transport = new FakeTransport()
    transport.images.set('pic-1', { base64: TINY_PNG })
    const asked: { text: string; images?: readonly string[] }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ text, images }) => {
        asked.push({ text, ...(images !== undefined ? { images } : {}) })
        return answer('看到了，是一张白图。')
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('看看这个 [图片]', 20002, [{ file: 'pic-1' }]))

    expect(asked).toHaveLength(1)
    expect(asked[0]?.text).toContain('[图片]')
    expect(asked[0]?.images).toHaveLength(1)
    expect(asked[0]?.images?.[0]).toMatch(/^data:image\/png;base64,/)
    expect(transport.sent[0]?.text).toContain('看到了')
  })

  it('取不到图 → 只按文字问，不阻断回答', async () => {
    const transport = new FakeTransport()
    const logs: { message: string; data?: Record<string, unknown> }[] = []
    const asked: { text: string; images?: readonly string[] }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ text, images }) => {
        asked.push({ text, ...(images !== undefined ? { images } : {}) })
        return answer('没看到图，只看到文字。')
      },
      log: (level, message, data) => logs.push({ message, ...(data !== undefined ? { data } : {}) }),
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('看看 [图片]', 20002, [{ file: 'missing' }]))

    expect(asked).toHaveLength(1)
    expect(asked[0]?.images).toBeUndefined()
    expect(transport.sent[0]?.text).toContain('没看到图')
    expect(logs.some((entry) => entry.message === 'qq image skipped')).toBe(true)
  })

  it('传承改名：setProfile 转给 transport（M4）', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, {
      ask: async () => answer('在。'),
      log: () => undefined,
      partGapMs: 0
    })
    await channel.start(config())
    await channel.setProfile?.('xiao-yu')
    expect(transport.profiles).toEqual(['xiao-yu'])
  })
})

describe('本地命令（M5）', () => {
  function receipt(text: string): ChainAskResult {
    return { kind: 'command', text, stats: stats() }
  }

  it('命中命令：不调模型，按 qq-<号> 会话把回执发回去', async () => {
    const transport = new FakeTransport()
    let asked = 0
    const seen: { text: string; conversationId: string }[] = []
    const channel = createQqChannel(transport, {
      ask: async () => {
        asked += 1
        return answer('不该走到这里')
      },
      command: async (text, context) => {
        seen.push({ text, conversationId: context.conversationId })
        return text === '/help' ? receipt('🎗️提示\n能用的命令：/help /log /new') : null
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('/help'))

    expect(asked).toBe(0)
    expect(seen).toEqual([{ text: '/help', conversationId: 'qq-20002' }])
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toContain('能用的命令')
  })

  it('命令不占每分钟限流：连发 3 条后普通问题照样能问', async () => {
    const transport = new FakeTransport()
    let asked = 0
    const channel = createQqChannel(transport, {
      ask: async () => {
        asked += 1
        return answer('答')
      },
      command: async (text) => (text.startsWith('/') ? receipt(`跑了 ${text}`) : null),
      log: () => {},
      perMinute: 1,
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('/log'))
    await channel.handleMessage(inbound('/life'))
    await channel.handleMessage(inbound('/git log --oneline'))

    expect(transport.sent.filter((item) => item.text.includes('跑了')).length).toBe(3)
    // 限流窗口没被命令吃掉：第一条普通消息还能问
    await channel.handleMessage(inbound('我下午在干嘛'))
    expect(asked).toBe(1)
    expect(transport.sent.some((item) => item.text.includes('太多了'))).toBe(false)
  })

  it('命令返回 null：照常提问（普通一句话不会被命令拦下）', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, {
      ask: async () => answer('照常答'),
      command: async () => null,
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('我昨天看了什么'))
    expect(transport.sent[0]?.text).toContain('照常答')
  })

  it('命令抛错：回一句「没跑成」，不调模型', async () => {
    const transport = new FakeTransport()
    let asked = 0
    const channel = createQqChannel(transport, {
      ask: async () => {
        asked += 1
        return answer('不该走到这里')
      },
      command: async () => {
        throw new Error('git boom')
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('/backup'))

    expect(asked).toBe(0)
    expect(transport.sent[0]?.text).toContain('没跑成')
  })

  it('命令不进问答队列：长问答还在跑时，命令照样先回', async () => {
    const transport = new FakeTransport()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const channel = createQqChannel(transport, {
      ask: async () => {
        await gate
        return answer('慢慢答完')
      },
      command: async (text) => (text === '/life' ? receipt('❤️剩余生命✨99%') : null),
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    const asking = channel.handleMessage(inbound('慢问题'))
    await channel.handleMessage(inbound('/life'))

    expect(transport.sent.some((item) => item.text.includes('剩余生命'))).toBe(true)
    expect(transport.sent.some((item) => item.text.includes('慢慢答完'))).toBe(false)
    release()
    await asking
    expect(transport.sent.some((item) => item.text.includes('慢慢答完'))).toBe(true)
  })

  it('非白名单发命令也不执行、不回话', async () => {
    const transport = new FakeTransport()
    let commands = 0
    const channel = createQqChannel(transport, {
      ask: async () => answer('x'),
      command: async () => {
        commands += 1
        return receipt('不该跑到这里')
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('/help', 99999))
    expect(commands).toBe(0)
    expect(transport.sent).toHaveLength(0)
  })

  it('命令回执走 formatAskResult：剥 Markdown，保留换行', () => {
    expect(formatAskResult(receipt('**粗体** 与 `代码`\n\n第二段'))).toBe('粗体 与 代码\n\n第二段')
  })
})
