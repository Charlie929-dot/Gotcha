/**
 * QQ 通道 · 通道层（D63）
 *
 * 传输层是假的（不打真端口），这里只守通道自己的规矩：
 * 默认关 / 白名单 fail-closed / 每用户串行 / 限流 / 长答分条 / 错误如实回一句。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChainAskResult } from '../../src/chain/agent/types'
import {
  createQqChannel,
  formatAskResult,
  parseResumeChoice,
  type QqChannelConfig,
  type QqResumeInput,
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

  /** file_id → 下载地址（D88）；没塞就当 NapCat 不给 */
  fileUrls = new Map<string, string>()

  async getFileUrl(fileId: string): Promise<string | null> {
    return this.fileUrls.get(fileId) ?? null
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

function inbound(
  text: string,
  userId = 20002,
  images?: QqInbound['images'],
  files?: QqInbound['files']
): QqInbound {
  return {
    userId,
    nickname: '测试',
    text,
    messageId: Math.floor(Math.random() * 1e9),
    at: Date.now(),
    ...(images !== undefined ? { images } : {}),
    ...(files !== undefined ? { files } : {})
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
})

describe('文件（D88：QQ 把图当「文件」发）', () => {
  const pngBytes = Buffer.from(TINY_PNG, 'base64')

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(body: Uint8Array): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/octet-stream' } }))
    )
  }

  it('扩展名是图片 → 取字节当图（和图片段同一条路）', async () => {
    const transport = new FakeTransport()
    transport.fileUrls.set('fid-1', 'https://example.test/avatar.jpg')
    stubFetch(pngBytes)
    const asked: { images?: readonly string[]; files?: readonly { name: string; text: string }[] }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ images, files }) => {
        asked.push({ ...(images !== undefined ? { images } : {}), ...(files !== undefined ? { files } : {}) })
        return answer('看到了。')
      },
      log: () => undefined,
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(
      inbound('这是你哦 [文件：avatar.jpg]', 20002, undefined, [{ name: 'avatar.jpg', fileId: 'fid-1' }])
    )

    expect(asked).toHaveLength(1)
    expect(asked[0]?.images?.[0]).toMatch(/^data:image\/png;base64,/u)
    expect(asked[0]?.files).toBeUndefined()
  })

  it('扩展名是文本 → 正文当附件', async () => {
    const transport = new FakeTransport()
    transport.fileUrls.set('fid-2', 'https://example.test/note.md')
    stubFetch(new TextEncoder().encode('# 标题\n正文在这里'))
    const asked: { files?: readonly { name: string; text: string }[] }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ files }) => {
        asked.push({ ...(files !== undefined ? { files } : {}) })
        return answer('读到了。')
      },
      log: () => undefined,
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(
      inbound('读一下 [文件：note.md]', 20002, undefined, [{ name: 'note.md', fileId: 'fid-2' }])
    )

    expect(asked[0]?.files?.[0]?.name).toBe('note.md')
    expect(asked[0]?.files?.[0]?.text).toContain('正文在这里')
  })

  it('拿不到下载地址 → 只按文字问，日志记 qq file skipped', async () => {
    const transport = new FakeTransport()
    const logs: string[] = []
    const asked: { images?: readonly string[]; files?: readonly { name: string; text: string }[] }[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ images, files }) => {
        asked.push({ ...(images !== undefined ? { images } : {}), ...(files !== undefined ? { files } : {}) })
        return answer('没拿到文件，只看到文件名。')
      },
      log: (_level, message) => logs.push(message),
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(
      inbound('看看 [文件：x.jpg]', 20002, undefined, [{ name: 'x.jpg', fileId: 'fid-missing' }])
    )

    expect(asked[0]?.images).toBeUndefined()
    expect(asked[0]?.files).toBeUndefined()
    expect(logs).toContain('qq file skipped')
    expect(transport.sent[0]?.text).toContain('没拿到文件')
  })
})

describe('传承改名（M4）', () => {
  it('setProfile 转给 transport', async () => {
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

/**
 * 2026-11-01 修（真机截图）：ta 在 QQ 里问「已经查了 8 轮，还要接着查吗？1. 继续查 / 2. 先按现在的结果回答」，
 * 用户回「1」却被当成新问题（ta 回「这是发错啦，还是在试我？」），因为它自己写着「得回桌面点一下」。
 * 通道层要做的：记着这一问挂着待选，下一句是 1 / 2 就走续查通道，别的字照常当提问。
 */
describe('「还要继续查吗」在 QQ 里也能答', () => {
  function paused(resumeId = 'r-20261101'): ChainAskResult {
    return {
      kind: 'continue-ask',
      question: '已经查了 8 轮，还要接着查吗？',
      options: ['继续查（再给 8 轮）', '先按现在的结果回答'],
      stats: stats(),
      resumeId
    }
  }

  it('给出 1 / 2 的用法，不再让人回桌面点', () => {
    const text = formatAskResult(paused())
    expect(text).toContain('已经查了 8 轮')
    expect(text).toContain('1. 继续查（再给 8 轮）')
    expect(text).toContain('回「1」继续查')
    expect(text).toContain('回「2」按现有结果收尾')
    expect(text).not.toContain('回桌面点一下')
  })

  it('只认 1 / 2（含全角与标点）；别的话不吞', () => {
    expect(parseResumeChoice('1')).toBe('continue')
    expect(parseResumeChoice(' 1 ')).toBe('continue')
    expect(parseResumeChoice('1.')).toBe('continue')
    expect(parseResumeChoice('1、')).toBe('continue')
    expect(parseResumeChoice('１')).toBe('continue')
    expect(parseResumeChoice('2')).toBe('stop')
    expect(parseResumeChoice('２）')).toBe('stop')
    expect(parseResumeChoice('继续')).toBeNull()
    expect(parseResumeChoice('1 2')).toBeNull()
    expect(parseResumeChoice('1 条任务')).toBeNull()
    expect(parseResumeChoice('')).toBeNull()
  })

  it('回「1」走续查（continue），答案发回同一会话，不当成新问题', async () => {
    const transport = new FakeTransport()
    const resumed: QqResumeInput[] = []
    let asked = 0
    const channel = createQqChannel(transport, {
      ask: async () => {
        asked += 1
        return paused()
      },
      resume: async (input) => {
        resumed.push(input)
        return answer('接着查完了：日记里确实有两条没做完的任务。')
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())

    await channel.handleMessage(inbound('对了，之前我日记里面好像也有一些任务没完成唉'))
    expect(transport.sent.at(-1)?.text).toContain('回「1」继续查')

    await channel.handleMessage(inbound('1'))
    expect(asked).toBe(1)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({
      resumeId: 'r-20261101',
      decision: 'continue',
      conversationId: 'qq-20002',
      question: '对了，之前我日记里面好像也有一些任务没完成唉'
    })
    // 长答会分条（正文 + 参考），拼起来看
    expect(transport.sent.map((item) => item.text).join('\n')).toContain('接着查完了')

    // 收尾之后这条待选就没了：再来个「1」是普通提问
    await channel.handleMessage(inbound('1'))
    expect(asked).toBe(2)
    expect(resumed).toHaveLength(1)
  })

  it('回「2」走 stop；续查之后又是 continue-ask 就换成新的 resumeId', async () => {
    const transport = new FakeTransport()
    const decisions: string[] = []
    const ids: string[] = []
    let round = 0
    const channel = createQqChannel(transport, {
      ask: async () => paused('r-first'),
      resume: async ({ resumeId, decision }) => {
        ids.push(resumeId)
        decisions.push(decision)
        round += 1
        // 前两次续查后还想再查：每次给一个新检查点；第三次收尾
        return round <= 2 ? paused(`r-round-${round}`) : answer('收尾了。')
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())

    await channel.handleMessage(inbound('这条要查很久'))
    await channel.handleMessage(inbound('1'))
    expect(ids).toEqual(['r-first'])
    expect(decisions).toEqual(['continue'])
    expect(transport.sent.at(-1)?.text).toContain('回「1」继续查')

    // 上一轮又给了新检查点：再来「1」应该续新的那个
    await channel.handleMessage(inbound('1'))
    expect(ids).toEqual(['r-first', 'r-round-1'])

    await channel.handleMessage(inbound('2'))
    expect(ids).toEqual(['r-first', 'r-round-1', 'r-round-2'])
    expect(decisions).toEqual(['continue', 'continue', 'stop'])
    expect(transport.sent.map((item) => item.text).join('\n')).toContain('收尾了')
  })

  it('换成别的问题就清掉待选（别把「1」当很久以前那次的答案）', async () => {
    const transport = new FakeTransport()
    let asked = 0
    let resumedCount = 0
    const channel = createQqChannel(transport, {
      ask: async () => {
        asked += 1
        return asked === 1 ? paused() : answer('另一个问题答完了。')
      },
      resume: async () => {
        resumedCount += 1
        return answer('不该走到这里。')
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())

    await channel.handleMessage(inbound('先问那个要查很久的'))
    await channel.handleMessage(inbound('算了，先问个别的'))
    expect(transport.sent.map((item) => item.text).join('\n')).toContain('另一个问题答完了')

    await channel.handleMessage(inbound('1'))
    expect(resumedCount).toBe(0)
    expect(asked).toBe(3)
  })

  it('没接续查能力：「1」照常当提问，不崩', async () => {
    const transport = new FakeTransport()
    const asked: string[] = []
    const channel = createQqChannel(transport, {
      ask: async ({ text }) => {
        asked.push(text)
        return paused()
      },
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config())
    await channel.handleMessage(inbound('这条要查很久'))
    await channel.handleMessage(inbound('1'))
    expect(asked).toEqual(['这条要查很久', '1'])
  })
})
describe('主动推送（D93：前台任务到点也发一份到 QQ）', () => {
  it('通道没起：不发，回 not-running', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, { ask: async () => answer('x'), log: () => {} })
    expect(await channel.push('到点啦')).toMatchObject({ sent: false, parts: 0, reason: 'not-running' })
    expect(transport.sent).toHaveLength(0)
  })

  it('在线：只发给白名单第一个人；长文本按分段规则发完', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, {
      ask: async () => answer('x'),
      log: () => {},
      partGapMs: 0
    })
    await channel.start(config({ allowUsers: ['20002', '30003'], replyMaxChars: 200 }))

    expect(await channel.push('到点啦——晚点名！')).toMatchObject({ sent: true, parts: 1 })
    expect(transport.sent).toEqual([{ userId: 20002, text: '到点啦——晚点名！' }])

    transport.sent.length = 0
    const long = await channel.push('段'.repeat(900))
    expect(long.sent).toBe(true)
    expect(long.parts).toBeGreaterThan(1)
    // 白名单里第二个号不该收到
    expect(transport.sent.every((item) => item.userId === 20002)).toBe(true)
  })

  it('主人号不是数字：不发也不抛（no-owner）', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, { ask: async () => answer('x'), log: () => {} })
    await channel.start(config({ allowUsers: ['not-a-number'] }))
    expect(await channel.push('到点啦')).toMatchObject({ sent: false, parts: 0, reason: 'no-owner' })
    expect(transport.sent).toHaveLength(0)
  })

  it('发送失败：不抛，回 send-failed（调用方只记日志、不重试）', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, { ask: async () => answer('x'), log: () => {} })
    await channel.start(config())
    transport.sendPrivate = async () => {
      throw new Error('boom')
    }
    expect(await channel.push('到点啦')).toMatchObject({ sent: false, reason: 'send-failed' })
  })

  it('停掉通道之后不再推', async () => {
    const transport = new FakeTransport()
    const channel = createQqChannel(transport, { ask: async () => answer('x'), log: () => {} })
    await channel.start(config())
    await channel.stop()
    expect(await channel.push('到点啦')).toMatchObject({ sent: false, reason: 'not-running' })
    expect(transport.sent).toHaveLength(0)
  })
})