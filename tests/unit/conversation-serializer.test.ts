/**
 * 桌面与 QQ 共用的会话串行器（2026-11-08）
 *
 * 守三件事：同一 conversationId 完整串行、不同会话不互相阻塞、前一轮失败不堵死队列；
 * 以及组合根把同一个调度器交给两端后，手机和电脑同时发消息不乱序、不串会话。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} }
}))

import { createConversationSerializer } from '../../src/main/conversation-serializer'
import { createAskIpcHandlers, type AskIpcDeps } from '../../src/main/ask-ipc'
import {
  createQqChannel,
  type QqChannelConfig,
  type QqChatLog,
  type QqChatRecordView,
  type QqTransport
} from '../../src/main/qq/channel'
import type { QqInbound } from '../../src/main/qq/ob11'
import type { ChainAskResult } from '../../src/chain/agent/types'

const MAIN_FRAME = {}
const SENDER_OK = { sender: { id: 7 }, senderFrame: MAIN_FRAME }
const STATS = { hits: 0, evidence: 0, cited: 0, questionChars: 1 }

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function noEvidence(): ChainAskResult {
  return { kind: 'no-evidence', stats: STATS }
}

function qqAnswer(text: string): ChainAskResult {
  return { kind: 'answer', answer: text, citations: [], stats: STATS }
}

function buildDeps(overrides: Partial<AskIpcDeps> = {}): AskIpcDeps {
  return {
    getWindow: () =>
      ({ isDestroyed: () => false, webContents: { id: 7, mainFrame: MAIN_FRAME } }) as never,
    ask: async () => noEvidence(),
    segment: () => null,
    consent: () => ({ consented: true, clientReady: true }),
    setConsent: (consented) => ({ consented, clientReady: true }),
    record: () => {},
    history: () => [],
    clearHistory: () => {},
    log: () => {},
    ...overrides
  }
}

function query(deps: AskIpcDeps, question: string, conversationId: string): Promise<unknown> {
  const found = createAskIpcHandlers(deps).get('ask:query')
  if (!found) throw new Error('没有 ask:query')
  return Promise.resolve(found(SENDER_OK as never, { question, conversationId }))
}

class FakeTransport implements QqTransport {
  sent: string[] = []
  private nextMessageId = 9001

  async start(): Promise<{ port: number }> {
    return { port: 8_643 }
  }
  async stop(): Promise<void> {}
  async sendPrivate(_userId: number, text: string): Promise<number> {
    this.sent.push(text)
    return this.nextMessageId++
  }
  async getImage(): Promise<{ base64?: string; url?: string }> {
    return {}
  }
  status(): { listening: boolean; connections: number; port: number | null } {
    return { listening: true, connections: 1, port: 8_643 }
  }
}

/** 只记「写到了哪个会话」，用于验证消息到达时固定会话 */
class RecordingChatLog implements QqChatLog {
  conversations: string[] = []
  private next = 1

  append(
    conversationId: string,
    input: { qqId: number; role: 'user' | 'ta'; text: string; at: number; imageCount?: number; quoteSeq?: number }
  ): QqChatRecordView {
    this.conversations.push(conversationId)
    return {
      seq: this.next++,
      qqId: input.qqId,
      role: input.role,
      text: input.text,
      at: input.at,
      imageCount: 0
    }
  }
  byQqId(): QqChatRecordView | null {
    return null
  }
  bySeq(): QqChatRecordView | null {
    return null
  }
  recent(): readonly QqChatRecordView[] {
    return []
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
  return { userId: 20002, nickname: '测试', text, messageId: 501, at: 1_700_000_000_000 }
}

describe('createConversationSerializer', () => {
  it('同键串行、异键并行', async () => {
    const serializer = createConversationSerializer()
    const order: string[] = []
    const gate = deferred()

    const first = serializer.run('c1', async () => {
      order.push('a-start')
      await gate.promise
      order.push('a-end')
      return 1
    })
    const second = serializer.run('c1', async () => {
      order.push('b-start')
      order.push('b-end')
      return 2
    })
    const other = serializer.run('c2', async () => {
      order.push('c-start')
      order.push('c-end')
      return 3
    })

    await tick()
    expect(order).toEqual(['a-start', 'c-start', 'c-end'])
    gate.resolve()
    await expect(Promise.all([first, second, other])).resolves.toEqual([1, 2, 3])
    expect(order).toEqual(['a-start', 'c-start', 'c-end', 'a-end', 'b-start', 'b-end'])
  })

  it('前一轮失败只影响自己，后续轮次照常跑', async () => {
    const serializer = createConversationSerializer()
    await expect(
      serializer.run('c1', async () => {
        throw new Error('上一轮炸了')
      })
    ).rejects.toThrow('上一轮炸了')
    await expect(serializer.run('c1', async () => 'ok')).resolves.toBe('ok')
  })
})

describe('桌面 + QQ 共用同一个会话调度器', () => {
  it('同一 conversationId 的两端不重叠：桌面这轮跑完，手机那轮才开始', async () => {
    const serializer = createConversationSerializer()
    const order: string[] = []
    const desktopGate = deferred()
    const transport = new FakeTransport()

    const desktop = query(
      buildDeps({
        serialize: serializer.run,
        ask: async () => {
          order.push('desktop:start')
          await desktopGate.promise
          order.push('desktop:end')
          return noEvidence()
        },
        record: () => {
          order.push('desktop:record')
        }
      }),
      '桌面问',
      'c-shared'
    )

    const channel = createQqChannel(transport, {
      log: () => {},
      partGapMs: 0,
      serialize: serializer.run,
      conversationFor: () => 'c-shared',
      ask: async () => {
        order.push('qq:start')
        return qqAnswer('手机答')
      }
    })
    await channel.start(config())

    await tick()
    const qq = channel.handleMessage(inbound('手机问'))
    await tick()
    // 桌面还握着这把锁：手机的提问（连命令判定）都得等
    expect(order).toEqual(['desktop:start'])

    desktopGate.resolve()
    await Promise.all([desktop, qq])
    expect(order).toEqual([
      'desktop:start',
      'desktop:end',
      'desktop:record',
      'qq:start'
    ])
    expect(transport.sent.join('\n')).toContain('手机答')
  })

  it('QQ 消息到达时固定会话：生成期间桌面切会话也不串台', async () => {
    const serializer = createConversationSerializer()
    const gate = deferred()
    const chatLog = new RecordingChatLog()
    const transport = new FakeTransport()
    let currentConversation = 'c-first'
    const qqAsked: string[] = []

    const desktop = query(
      buildDeps({ serialize: serializer.run, ask: async () => {
        await gate.promise
        return noEvidence()
      } }),
      '桌面问',
      'c-first'
    )

    const channel = createQqChannel(transport, {
      log: () => {},
      partGapMs: 0,
      chatLog,
      serialize: serializer.run,
      conversationFor: () => currentConversation,
      ask: async ({ conversationId }) => {
        qqAsked.push(conversationId)
        return qqAnswer('手机答')
      }
    })
    await channel.start(config())

    await tick()
    const qq = channel.handleMessage(inbound('手机问'))
    // 模拟桌面在模型生成期间切了会话
    currentConversation = 'c-second'
    await tick()
    gate.resolve()
    await Promise.all([desktop, qq])

    expect(qqAsked).toEqual(['c-first'])
    expect(chatLog.conversations.length).toBeGreaterThan(0)
    expect(chatLog.conversations.every((id) => id === 'c-first')).toBe(true)
  })

  it('桌面取消只中止自己那一轮，不把排队中的手机消息一起取消', async () => {
    const serializer = createConversationSerializer()
    const gate = deferred()
    const handlers = createAskIpcHandlers(
      buildDeps({
        serialize: serializer.run,
        ask: async (_question, context) => {
          if (context.signal.aborted) throw new Error('已取消')
          await gate.promise
          if (context.signal.aborted) throw new Error('已取消')
          return noEvidence()
        }
      })
    )
    const cancel = handlers.get('ask:cancel')
    const desktopQuery = handlers.get('ask:query')
    if (!cancel || !desktopQuery) throw new Error('handler 缺失')

    const first = Promise.resolve(
      desktopQuery(SENDER_OK as never, { question: '第一问', conversationId: 'c1' })
    )
    await tick()
    cancel(SENDER_OK as never)
    gate.resolve() // 放开被中止那一轮，让它就地收口
    await expect(first).resolves.toMatchObject({ kind: 'error' })
    // 串行器没被失败卡住：后续同一会话仍能跑
    await expect(query(buildDeps({ serialize: serializer.run }), '第二问', 'c1')).resolves.toMatchObject({
      kind: 'no-evidence'
    })
  })

  it('排队中被停止的桌面提问立刻让位：不占会话锁，也不再调模型', async () => {
    const serializer = createConversationSerializer()
    const gate = deferred()
    const asked: string[] = []
    const handlers = createAskIpcHandlers(
      buildDeps({
        serialize: serializer.run,
        ask: async (question) => {
          asked.push(question)
          return noEvidence()
        }
      })
    )
    const desktopQuery = handlers.get('ask:query')
    const cancel = handlers.get('ask:cancel')
    if (!desktopQuery || !cancel) throw new Error('handler 缺失')

    const channel = createQqChannel(new FakeTransport(), {
      log: () => {},
      partGapMs: 0,
      serialize: serializer.run,
      conversationFor: () => 'c1',
      ask: async () => {
        await gate.promise
        return qqAnswer('手机答')
      }
    })
    await channel.start(config())

    // 手机先握锁；桌面这轮排在同一会话后面
    const qq = channel.handleMessage(inbound('手机问'))
    await tick()
    const desktop = Promise.resolve(
      desktopQuery(SENDER_OK as never, { question: '桌面问', conversationId: 'c1' })
    )
    await tick()
    cancel(SENDER_OK as never)
    gate.resolve()
    await Promise.all([qq, desktop])

    expect(asked).toEqual([])
    await expect(desktop).resolves.toMatchObject({ kind: 'error', reason: 'aborted' })
  })
})
