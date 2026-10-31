/**
 * 信工具（D81）：`write_letter` / `list_letter` / `read_letter` 的执行与载荷。
 *
 * 只测核心层：执行器把主进程注入的 `letters` 端口结果变成工具结果；没注入如实报错；
 * 载荷只给元信息 / 读到的正文，`<now>` 只报未读数（不把信塞进 system）。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import { createAskToolExecutor, type LetterToolDeps } from '../../src/chain/agent/tools'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'

const NOW = new Date(2026, 9, 31, 12, 0, 0, 0).getTime()
const FRESHNESS = { latestEvidenceTs: null, captureRunning: false }

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function executor(letters?: LetterToolDeps) {
  return createAskToolExecutor({
    db,
    now: () => NOW,
    captureRunning: () => false,
    ...(letters !== undefined ? { letters } : {})
  })
}

function port(overrides: Partial<LetterToolDeps> = {}): LetterToolDeps {
  return {
    write: vi.fn(async (input) => ({
      ok: true,
      id: '20261031-120000',
      at: input.at,
      message: '写好了'
    })),
    list: vi.fn(async () => [
      { id: 'a', from: '妈妈', to: '小鱼', at: NOW, where: 'letters' as const, unread: true }
    ]),
    read: vi.fn(async (id?: string) =>
      id === 'a'
        ? {
            id: 'a',
            from: '妈妈',
            to: '小鱼',
            at: NOW,
            where: 'letters' as const,
            unread: false,
            text: '好好长大'
          }
        : null
    ),
    ...overrides
  }
}

describe('write_letter', () => {
  it('参数合法时调主进程端口，回执带 id / at', async () => {
    const letters = port()
    const outcome = await executor(letters).execute({
      name: 'write_letter',
      arguments: { to: '主人', write: '今天也很晚', at: 'desktop' }
    })
    expect(letters.write).toHaveBeenCalledWith({ to: '主人', write: '今天也很晚', at: 'desktop' })
    expect(outcome.result).toMatchObject({
      kind: 'write_letter',
      id: '20261031-120000',
      at: 'desktop',
      message: '写好了'
    })
  })

  it('at 不合法 / 缺字段：参数错误，不调端口', async () => {
    const letters = port()
    const outcome = await executor(letters).execute({
      name: 'write_letter',
      arguments: { to: '主人', write: '今天也很晚', at: 'moon' }
    })
    expect(outcome.result).toMatchObject({ kind: 'error', message: expect.stringContaining('参数不合法') })
    expect(letters.write).not.toHaveBeenCalled()
  })

  it('没注入端口：如实报「现在不能写信」', async () => {
    const outcome = await executor().execute({
      name: 'write_letter',
      arguments: { to: '主人', write: '今天也很晚', at: 'self' }
    })
    expect(outcome.result).toMatchObject({ kind: 'error', message: expect.stringContaining('不能写信') })
  })
})

describe('list_letter / read_letter', () => {
  it('list 返回元信息（不展开正文）', async () => {
    const outcome = await executor(port()).execute({ name: 'list_letter', arguments: {} })
    expect(outcome.result).toMatchObject({
      kind: 'list_letter',
      letters: [{ id: 'a', from: '妈妈', to: '小鱼', unread: true, where: 'letters' }]
    })
  })

  it('read 传 id 读指定那封；正文随结果回给模型', async () => {
    const outcome = await executor(port()).execute({
      name: 'read_letter',
      arguments: { id: 'a' }
    })
    expect(outcome.result).toMatchObject({
      kind: 'read_letter',
      id: 'a',
      from: '妈妈',
      to: '小鱼',
      text: '好好长大'
    })
  })

  it('read 不传 id = 最新未读；没有就如实报错', async () => {
    const outcome = await executor(port({ read: vi.fn(async () => null) })).execute({
      name: 'read_letter',
      arguments: {}
    })
    expect(outcome.result).toMatchObject({ kind: 'error', message: expect.stringContaining('没有这封信') })
  })
})

describe('载荷与 <now>', () => {
  it('写 / 列 / 读的结果都进载荷', () => {
    const outbound = createLocalAskOutbound()
    const built = outbound.buildLoop({
      question: '有我的信吗',
      systemTime: '2026-10-31 12:00 周六',
      systemTimeMs: NOW,
      freshness: FRESHNESS,
      turns: [
        {
          toolCall: { name: 'list_letter', arguments: {} },
          toolResult: {
            kind: 'list_letter',
            freshness: FRESHNESS,
            letters: [
              { id: 'a', from: '妈妈', to: '小鱼', at: NOW, where: 'letters', unread: true }
            ]
          }
        },
        {
          toolCall: { name: 'read_letter', arguments: { id: 'a' } },
          toolResult: {
            kind: 'read_letter',
            freshness: FRESHNESS,
            id: 'a',
            from: '妈妈',
            to: '小鱼',
            at: NOW,
            text: '好好长大'
          }
        }
      ]
    })
    expect(built.payload.turns[0]?.toolResult).toMatchObject({
      kind: 'list_letter',
      letters: [{ id: 'a', from: '妈妈', to: '小鱼', unread: true }]
    })
    expect(built.payload.turns[1]?.toolResult).toMatchObject({
      kind: 'read_letter',
      id: 'a',
      text: '好好长大'
    })
  })

  it('有未读：<now> 只报数量；没有就不写这一行', () => {
    const outbound = createLocalAskOutbound()
    const withUnread = outbound.buildLoop({
      question: '在吗',
      systemTime: '2026-10-31 12:00 周六',
      systemTimeMs: NOW,
      freshness: FRESHNESS,
      turns: [],
      letters: { unread: 2 }
    })
    expect(withUnread.payload.now).toContain('信件：2 封未读')
    expect(withUnread.payload.now).not.toContain('来自')

    const read = outbound.buildLoop({
      question: '在吗',
      systemTime: '2026-10-31 12:00 周六',
      systemTimeMs: NOW,
      freshness: FRESHNESS,
      turns: [],
      letters: { unread: 0 }
    })
    expect(read.payload.now).not.toContain('信件：')
  })
})
