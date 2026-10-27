/**
 * `ask:*` IPC handler 表（不经过 ipcMain，直接调用通道函数）
 *
 * 重点：只认问记忆窗口自己的主框架；参数在边界上校验；出错变成可读结果而不抛回渲染层。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} }
}))

import { ASK_QUESTION_MAX_CHARS, createAskIpcHandlers, type AskIpcDeps } from '../../src/main/ask-ipc'
import type { ChainAskResult } from '../../src/chain/agent/types'
import type { SegmentEvidence } from '../../src/chain/agent/evidence'

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

  it('正常提问：问题 trim 后交给 askChain', async () => {
    const ask = vi.fn(async (): Promise<ChainAskResult> => ({
      kind: 'answer',
      answer: '答',
      citations: [],
      stats: { hits: 1, evidence: 1, cited: 1, questionChars: 5 }
    }))
    const result = await handler(buildDeps({ ask }), 'ask:query')(SENDER_OK as never, '  那次编译  ')
    expect(ask).toHaveBeenCalledWith('那次编译')
    expect(result).toMatchObject({ kind: 'answer', answer: '答' })
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
