/**
 * `<now>` 生命行（M3）：有 life 时多一行事实；没有就不出现；用完报 0%。
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

describe('<now> 生命行', () => {
  it('有 life 时多一行「生命：还剩 X%（YK token）」', () => {
    expect(build({ used: 190_000, limit: 500_000 })).toContain('生命：还剩 62%（310K token）')
  })

  it('没给 life 时不出现生命行', () => {
    expect(build()).not.toContain('生命：')
  })

  it('用尽时剩 0%（不出现负数 / 超 100%）', () => {
    expect(build({ used: 500_000, limit: 500_000 })).toContain('生命：还剩 0%（0 token）')
    expect(build({ used: 900_000, limit: 500_000 })).toContain('生命：还剩 0%（0 token）')
  })

  it('不足 1K 时直接报数字', () => {
    expect(build({ used: 200, limit: 500_000 })).toContain('生命：还剩 100%（500K token）')
    expect(build({ used: 0, limit: 900 })).toContain('生命：还剩 100%（900 token）')
  })
})
