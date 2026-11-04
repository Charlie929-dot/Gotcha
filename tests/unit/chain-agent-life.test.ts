/**
 * `<now>` 人生进度行（M3 / 2026-11-04）：有 life 时多一行日常话；没有就不出现；用完报 100%。
 * 阶段话仍跟 D99 的百分比边界走（剩余 >95 宝宝 / 86–95 少女 / 16–85 准妈妈 / ≤15 快走完）。
 * 只测载荷组装，不碰网络（策略用本机直通）。
 */

import { describe, expect, it } from 'vitest'

import { createLocalAskOutbound } from '../../src/chain/agent/payload'

function build(life?: { used: number; limit: number }): string {
  const outbound = createLocalAskOutbound()
  const built = outbound.buildLoop({
    question: '随便问一句',
    systemTime: '2026-10-30 20:00 周五',
    freshness: { latestEvidenceTs: null, captureRunning: false },
    turns: [],
    ...(life !== undefined ? { life } : {})
  })
  return built.payload.now
}

describe('<now> 人生进度行', () => {
  it('有 life 时报「人生进度：N% ，…」（不报 token / 生命）', () => {
    const now = build({ used: 190_000, limit: 500_000 })
    expect(now).toContain('人生进度：38% ，快要当妈妈了')
    expect(now).not.toContain('token')
    expect(now).not.toContain('生命：')
  })

  it('没给 life 时不出现人生进度', () => {
    expect(build()).not.toContain('人生进度：')
  })

  it('用尽时报 100%（不出现负数 / 超 100%）', () => {
    expect(build({ used: 500_000, limit: 500_000 })).toContain('人生进度：100% ，快走完了')
    expect(build({ used: 900_000, limit: 500_000 })).toContain('人生进度：100% ，快走完了')
  })

  it('几乎没用：0% 还是个宝宝', () => {
    expect(build({ used: 200, limit: 500_000 })).toContain('人生进度：0% ，还是个宝宝')
    expect(build({ used: 0, limit: 900 })).toContain('人生进度：0% ，还是个宝宝')
  })

  it('阶段话跟剩余百分比走（D99 边界不变）', () => {
    // 用了 4% → 剩 96% → 宝宝
    expect(build({ used: 20_000, limit: 500_000 })).toContain('还是个宝宝')
    // 用了 10% → 剩 90% → 少女
    expect(build({ used: 50_000, limit: 500_000 })).toContain('还是个少女')
    // 用了 86% → 剩 14% → 快要离开
    expect(build({ used: 430_000, limit: 500_000 })).toContain('快走完了')
  })
})
