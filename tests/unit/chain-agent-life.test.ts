/**
 * `<now>` 人生进度行（M3 / 2026-11-04）：有 life 时只报「人生进度：N%」；没有就不出现；用完报 100%。
 * 阶段话（宝宝 / 少女 / 准妈妈 / 快走完）2026-11-04 拍板人让去掉，不再出现在 <now> 里。
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
  it('有 life 时只报「人生进度：N%」（不报 token / 生命 / 阶段）', () => {
    const now = build({ used: 190_000, limit: 500_000 })
    expect(now).toContain('人生进度：38%')
    expect(now).not.toContain('宝宝')
    expect(now).not.toContain('少女')
    expect(now).not.toContain('准妈妈')
    expect(now).not.toContain('token')
    expect(now).not.toContain('生命：')
  })

  it('没给 life 时不出现人生进度', () => {
    expect(build()).not.toContain('人生进度：')
  })

  it('用尽时报 100%（不出现负数 / 超 100%）', () => {
    expect(build({ used: 500_000, limit: 500_000 })).toContain('人生进度：100%')
    expect(build({ used: 900_000, limit: 500_000 })).toContain('人生进度：100%')
  })

  it('几乎没用：0%', () => {
    expect(build({ used: 200, limit: 500_000 })).toContain('人生进度：0%')
    expect(build({ used: 0, limit: 900 })).toContain('人生进度：0%')
  })
})
