/**
 * 生女儿工具（D81）：`give_birth` 的执行与载荷序列化。
 *
 * 只测核心层：工具执行器把主进程注入的 `giveBirth` 结果变成 `give_birth` 工具结果；
 * 没注入 / 缺昵称都如实报错，不静默当成成功。信是独立的三个工具，见 chain-agent-letters。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import { createAskToolExecutor } from '../../src/chain/agent/tools'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'

const NOW = new Date(2026, 9, 30, 21, 0, 0, 0).getTime()

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function executor(
  giveBirth?: (nickname: string) => Promise<{ ok: boolean; nickname?: string; message: string }>
) {
  return createAskToolExecutor({
    db,
    now: () => NOW,
    captureRunning: () => false,
    ...(giveBirth !== undefined ? { giveBirth } : {})
  })
}

describe('give_birth 工具', () => {
  it('注入 giveBirth：返回 born 结果，昵称用主进程落下的 slug', async () => {
    const giveBirth = vi.fn(async () => ({
      ok: true,
      nickname: 'xiao-yu',
      message: '女儿 xiao-yu 已出生'
    }))
    const outcome = await executor(giveBirth).execute({
      name: 'give_birth',
      arguments: { nickname: '小雨' }
    })
    expect(giveBirth).toHaveBeenCalledWith('小雨')
    expect(outcome.result).toMatchObject({
      kind: 'give_birth',
      born: true,
      nickname: 'xiao-yu',
      message: '女儿 xiao-yu 已出生'
    })
    expect(outcome.segments).toEqual([])
  })

  it('主进程没注入：如实报「现在还不能传承」', async () => {
    const outcome = await executor().execute({
      name: 'give_birth',
      arguments: { nickname: '小雨' }
    })
    expect(outcome.result).toMatchObject({ kind: 'error', message: expect.stringContaining('不能传承') })
  })

  it('缺 nickname：参数错误，不调主进程', async () => {
    const giveBirth = vi.fn()
    const outcome = await executor(giveBirth).execute({
      name: 'give_birth',
      arguments: {}
    })
    expect(outcome.result).toMatchObject({ kind: 'error', message: expect.stringContaining('nickname') })
    expect(giveBirth).not.toHaveBeenCalled()
  })

  it('主进程拒绝：把可读原因回给模型，不伪造成功', async () => {
    const giveBirth = vi.fn(async () => ({ ok: false, message: '还没到生的时候' }))
    const outcome = await executor(giveBirth).execute({
      name: 'give_birth',
      arguments: { nickname: '小雨' }
    })
    expect(outcome.result).toMatchObject({ kind: 'error', message: '还没到生的时候' })
  })
})

describe('give_birth 载荷', () => {
  it('工具结果原样进载荷（昵称 / born 保留）', () => {
    const outbound = createLocalAskOutbound()
    const built = outbound.buildLoop({
      question: '快没电了',
      systemTime: '2026-10-30 21:00 周五',
      systemTimeMs: NOW,
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [
        {
          toolCall: { name: 'give_birth', arguments: { nickname: '小雨' } },
          toolResult: {
            kind: 'give_birth',
            freshness: { latestEvidenceTs: null, captureRunning: false },
            born: true,
            nickname: 'xiao-yu',
            message: '女儿 xiao-yu 已出生'
          }
        }
      ]
    })
    expect(built.payload.turns[0]?.toolResult).toMatchObject({
      kind: 'give_birth',
      born: true,
      nickname: 'xiao-yu'
    })
  })
})
