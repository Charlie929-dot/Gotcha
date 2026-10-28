/**
 * `ask:*` IPC handler 表（不经过 ipcMain，直接调用通道函数）
 *
 * 重点：只认问记忆窗口自己的主框架；参数在边界上校验；出错变成可读结果而不抛回渲染层。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} }
}))

import { ASK_QUESTION_MAX_CHARS, createAskIpcHandlers, type AskIpcDeps, type AskQueryContext } from '../../src/main/ask-ipc'
import type { ChainAskResult } from '../../src/chain/agent/types'
import type { SegmentEvidence } from '../../src/chain/agent/evidence'
import type { AskHistoryEntry } from '../../src/main/ask-history'

const MAIN_FRAME = {}

function fakeWindow(): { isDestroyed: () => boolean; webContents: { id: number; mainFrame: unknown } } {
  return { isDestroyed: () => false, webContents: { id: 7, mainFrame: MAIN_FRAME } }
}

const SENDER_OK = { sender: { id: 7 }, senderFrame: MAIN_FRAME }

function buildDeps(overrides: Partial<AskIpcDeps> = {}): AskIpcDeps {
  return {
    getWindow: () => fakeWindow() as never,
    ask: async (): Promise<ChainAskResult> => ({
      kind: 'no-evidence',
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 1 }
    }),
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

function handler(deps: AskIpcDeps, channel: string) {
  const found = createAskIpcHandlers(deps).get(channel)
  if (!found) throw new Error(`没有通道 ${channel}`)
  return found
}

describe('ask IPC：权限边界', () => {
  it('只认自己窗口的主框架：别的 sender 一律拒', async () => {
    const deps = buildDeps()
    const query = handler(deps, 'ask:query')
    const wrongSender = await query({ sender: { id: 99 }, senderFrame: MAIN_FRAME } as never, '问点什么')
    expect(wrongSender).toMatchObject({ kind: 'error', message: 'forbidden' })
    const wrongFrame = await query({ sender: { id: 7 }, senderFrame: {} } as never, '问点什么')
    expect(wrongFrame).toMatchObject({ kind: 'error', message: 'forbidden' })
    // 窗口没了也拒
    const gone = handler(buildDeps({ getWindow: () => null }), 'ask:query')
    expect(await gone(SENDER_OK as never, '问点什么')).toMatchObject({ kind: 'error', message: 'forbidden' })
  })

  it('参数不合法 / 空问题 / 超长都不进 askChain', async () => {
    const ask = vi.fn()
    const deps = buildDeps({ ask })
    const query = handler(deps, 'ask:query')
    expect(await query(SENDER_OK as never, 42)).toMatchObject({ kind: 'error' })
    expect(await query(SENDER_OK as never, '   ')).toMatchObject({ kind: 'error', message: '问题是空的' })
    expect(await query(SENDER_OK as never, 'x'.repeat(ASK_QUESTION_MAX_CHARS + 1))).toMatchObject({
      kind: 'error'
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('正常提问：问题 trim 后交给 askChain（带会话 id / 上下文 / 取消信号）', async () => {
    const ask = vi.fn(async (): Promise<ChainAskResult> => ({
      kind: 'answer',
      answer: '答',
      citations: [],
      stats: { hits: 1, evidence: 1, cited: 1, questionChars: 5 }
    }))
    const history: Array<{ question: string; answer: string }> = [
      { question: '上一问', answer: '上一答' }
    ]
    const result = await handler(
      buildDeps({ ask, conversationHistory: () => history }),
      'ask:query'
    )(SENDER_OK as never, { question: '  那次编译  ', conversationId: 'conv-1' })
    expect(ask).toHaveBeenCalledWith(
      '那次编译',
      expect.objectContaining({
        conversationId: 'conv-1',
        history,
        signal: expect.anything()
      })
    )
    expect(result).toMatchObject({ kind: 'answer', answer: '答' })
    // 非法会话 id 不进入上下文查找：现造一个合法 id
    const ask2 = vi.fn(async (_question: string, _context: AskQueryContext): Promise<ChainAskResult> => ({
      kind: 'no-evidence',
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 1 }
    }))
    await handler(buildDeps({ ask: ask2 }), 'ask:query')(SENDER_OK as never, {
      question: '问',
      conversationId: '带 空格/斜杠'
    })
    expect(ask2.mock.calls[0]![1]).toMatchObject({ conversationId: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/) })
  })

  it('askChain 抛错：变成可读错误，不把异常抛回渲染层', async () => {
    const logs: string[] = []
    const deps = buildDeps({
      ask: async () => {
        throw new Error('屏幕流断了')
      },
      log: (_level, message) => logs.push(message)
    })
    const result = await handler(deps, 'ask:query')(SENDER_OK as never, '问点什么')
    expect(result).toMatchObject({ kind: 'error', reason: 'failed' })
    expect(logs).toEqual(['ask:query failed'])
  })
})

describe('ask IPC：段证据与出云确认', () => {
  it('段 id 必须是正整数；找不到就是 null', () => {
    const deps = buildDeps()
    const segment = handler(deps, 'ask:segment')
    expect(segment(SENDER_OK as never, 'abc')).toBeNull()
    expect(segment(SENDER_OK as never, 0)).toBeNull()
    expect(segment(SENDER_OK as never, 1.5)).toBeNull()
    expect(segment(SENDER_OK as never, 12)).toBeNull()
  })

  it('段证据原样返回', () => {
    const evidence: SegmentEvidence = {
      segmentId: 12,
      app: 'Firefox',
      title: '文档',
      startTs: 1,
      endTs: 2,
      activeMs: 1,
      tags: [],
      links: [],
      contents: [],
      shots: []
    }
    const deps = buildDeps({ segment: () => evidence })
    expect(handler(deps, 'ask:segment')(SENDER_OK as never, 12)).toEqual(evidence)
  })

  it('出云确认：读状态 / 写入只接受布尔', () => {
    const setConsent = vi.fn((consented: boolean) => ({ consented, clientReady: true }))
    const deps = buildDeps({ setConsent })
    const getHandler = handler(deps, 'ask:consent:get')
    const setHandler = handler(deps, 'ask:consent:set')
    expect(getHandler(SENDER_OK as never)).toEqual({ consented: true, clientReady: true })
    expect(setHandler(SENDER_OK as never, { consented: 'yes' })).toBeNull()
    expect(setHandler(SENDER_OK as never, null)).toBeNull()
    expect(setHandler(SENDER_OK as never, { consented: false })).toEqual({
      consented: false,
      clientReady: true
    })
    expect(setConsent).toHaveBeenCalledWith(false)
  })
})

const ENTRY: AskHistoryEntry = {
  id: 'id-1',
  at: 1_000,
  question: '问',
  kind: 'no-evidence',
  citations: [],
  stats: { hits: 0, evidence: 0, cited: 0, questionChars: 1 }
}

describe('ask IPC：对话记录', () => {
  it('答完落一条记录：answer / no-evidence / error 都记', async () => {
    const record = vi.fn()
    const results: ChainAskResult[] = [
      { kind: 'answer', answer: '答', citations: [], stats: { hits: 1, evidence: 1, cited: 0, questionChars: 1 } },
      { kind: 'no-evidence', stats: { hits: 0, evidence: 0, cited: 0, questionChars: 1 } },
      { kind: 'error', reason: 'consent', message: '未确认', stats: { hits: 0, evidence: 0, cited: 0, questionChars: 1 } }
    ]
    for (const result of results) {
      const deps = buildDeps({ ask: async () => result, record })
      await handler(deps, 'ask:query')(SENDER_OK as never, '问')
    }
    expect(record).toHaveBeenCalledTimes(3)
    expect(record).toHaveBeenNthCalledWith(1, '问', results[0], expect.any(String))
  })

  it('停止通道：中止在途提问，返回值落成 aborted（不是 failed）', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null }
    const deps = buildDeps({
      ask: async (_question, context) => {
        captured.signal = context.signal
        // 等信号中止（真实现里是模型请求被 abort）
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()))
        return {
          kind: 'error',
          reason: 'aborted',
          message: '已停止',
          stats: { hits: 0, evidence: 0, cited: 0, questionChars: 1 }
        }
      }
    })
    const handlers = createAskIpcHandlers(deps)
    const query = handlers.get('ask:query')
    const cancel = handlers.get('ask:cancel')
    if (!query || !cancel) throw new Error('缺通道')
    const pending = query(SENDER_OK as never, { question: '问', conversationId: 'conv-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(captured.signal?.aborted).toBe(false)
    expect(cancel(SENDER_OK as never)).toBe(true)
    const result = await pending
    expect(captured.signal?.aborted).toBe(true)
    expect(result).toMatchObject({ kind: 'error', reason: 'aborted' })
    // 越权取消：拒
    expect(cancel({ sender: { id: 9 }, senderFrame: MAIN_FRAME } as never)).toBe(false)
  })

  it('边界失败（越权 / 空 / 超长 / 抛错）不进历史', async () => {
    const record = vi.fn()
    const deps = buildDeps({
      ask: async () => {
        throw new Error('断了')
      },
      record
    })
    const query = handler(deps, 'ask:query')
    await query({ sender: { id: 9 }, senderFrame: MAIN_FRAME } as never, '问')
    await query(SENDER_OK as never, '   ')
    await query(SENDER_OK as never, 'x'.repeat(ASK_QUESTION_MAX_CHARS + 1))
    await query(SENDER_OK as never, '问')
    expect(record).not.toHaveBeenCalled()
  })

  it('记录写失败只记日志，不把回答弄丢', async () => {
    const logs: string[] = []
    const result: ChainAskResult = {
      kind: 'answer',
      answer: '答',
      citations: [],
      stats: { hits: 1, evidence: 1, cited: 0, questionChars: 1 }
    }
    const deps = buildDeps({
      ask: async () => result,
      record: () => {
        throw new Error('磁盘满')
      },
      log: (_level, message) => logs.push(message)
    })
    expect(await handler(deps, 'ask:query')(SENDER_OK as never, '问')).toEqual(result)
    expect(logs).toEqual(['ask history record failed'])
  })

  it('历史通道：只认自己窗口的主框架；读失败返回空数组', () => {
    const deps = buildDeps({ history: () => [ENTRY] })
    expect(handler(deps, 'ask:history')(SENDER_OK as never)).toEqual([ENTRY])
    expect(handler(deps, 'ask:history')({ sender: { id: 9 }, senderFrame: MAIN_FRAME } as never)).toEqual([])
    const broken = buildDeps({
      history: () => {
        throw new Error('坏文件')
      }
    })
    expect(handler(broken, 'ask:history')(SENDER_OK as never)).toEqual([])
  })

  it('清空通道：调 deps.clearHistory；越权 / 写失败返回 false', () => {
    const clearHistory = vi.fn()
    const deps = buildDeps({ clearHistory })
    expect(handler(deps, 'ask:history:clear')(SENDER_OK as never)).toBe(true)
    expect(clearHistory).toHaveBeenCalledTimes(1)
    expect(
      handler(deps, 'ask:history:clear')({ sender: { id: 9 }, senderFrame: MAIN_FRAME } as never)
    ).toBe(false)
    const broken = buildDeps({
      clearHistory: () => {
        throw new Error('权限')
      }
    })
    expect(handler(broken, 'ask:history:clear')(SENDER_OK as never)).toBe(false)
  })
})

describe('ask IPC：轮数用尽的续查', () => {
  const paused: ChainAskResult = {
    kind: 'continue-ask',
    question: '已经查了 8 轮，还要接着查吗？',
    options: ['继续查（再给 8 轮）', '先按现在的结果回答'],
    stats: { hits: 3, evidence: 2, cited: 0, questionChars: 4, turns: 8, toolCalls: 9 },
    resumeId: 'rabc123'
  }

  it('暂停轮不落历史；续查结果用原问题落一条；句柄一次性', async () => {
    const record = vi.fn()
    const resume = vi.fn(async (): Promise<ChainAskResult> => ({
      kind: 'answer',
      answer: '答',
      citations: [],
      stats: { hits: 3, evidence: 2, cited: 0, questionChars: 4 }
    }))
    const deps = buildDeps({
      ask: async () => paused,
      resume,
      record,
      conversationHistory: () => [{ question: '上一问', answer: '上一答' }]
    })
    const handlers = createAskIpcHandlers(deps)
    const query = handlers.get('ask:query')
    const continueAsk = handlers.get('ask:resume')
    if (!query || !continueAsk) throw new Error('缺通道')

    const first = await query(SENDER_OK as never, {
      question: '  那次编译  ',
      conversationId: 'conv-1'
    })
    expect(first).toEqual(paused)
    // 用户还没决定：问题与最终答案都没出来，不能先记一条
    expect(record).not.toHaveBeenCalled()

    const second = await continueAsk(SENDER_OK as never, {
      resumeId: 'rabc123',
      decision: 'continue'
    })
    expect(second).toMatchObject({ kind: 'answer', answer: '答' })
    expect(resume).toHaveBeenCalledWith(
      'rabc123',
      'continue',
      expect.objectContaining({ conversationId: 'conv-1', signal: expect.anything() })
    )
    // 落历史用的是原问题（续查通道不传问题），且只落最终这一条
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('那次编译', second, 'conv-1')

    // 一次性：同一个句柄再来一次就过期
    expect(
      await continueAsk(SENDER_OK as never, { resumeId: 'rabc123', decision: 'stop' })
    ).toMatchObject({ kind: 'error', message: expect.stringContaining('过期') })
  })

  it('非法句柄 / 非法决定 / 没接续查能力都拒绝，不调 resume', async () => {
    const resume = vi.fn(async (): Promise<ChainAskResult> => paused)
    const continueAsk = handler(buildDeps({ resume }), 'ask:resume')
    expect(
      await continueAsk(SENDER_OK as never, { resumeId: 'bad id', decision: 'continue' })
    ).toMatchObject({ kind: 'error' })
    expect(
      await continueAsk(SENDER_OK as never, { resumeId: 'rabc123', decision: 'maybe' })
    ).toMatchObject({ kind: 'error' })
    // 没先暂停过的句柄：过期
    expect(
      await continueAsk(SENDER_OK as never, { resumeId: 'rabc123', decision: 'continue' })
    ).toMatchObject({ kind: 'error', message: expect.stringContaining('过期') })
    expect(resume).not.toHaveBeenCalled()

    const noResume = handler(buildDeps(), 'ask:resume')
    expect(
      await noResume(SENDER_OK as never, { resumeId: 'rabc123', decision: 'continue' })
    ).toMatchObject({ kind: 'error', message: '当前版本不支持续查' })
  })
})
