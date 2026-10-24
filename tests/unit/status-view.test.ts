/**
 * 归纳状态徽标文案（纯函数）：失败原因 / 下次重试 / 连续失败停自动
 */

import { describe, expect, it } from 'vitest'
import type { InductionSnapshot } from '../../src/main/induction-runtime'
import {
  failureReasonText,
  retryEtaText,
  statusView
} from '../../src/renderer/graph/status-view'

const NOW = new Date(2026, 9, 24, 12, 0, 0, 0).getTime()

function snapshot(patch: Partial<InductionSnapshot> = {}): InductionSnapshot {
  return {
    status: 'idle',
    halted: false,
    consent: true,
    captureRunning: true,
    client: { ok: true },
    ...patch
  }
}

describe('status-view · 徽标文案', () => {
  it('读取中 / 未确认出网 / 缺密钥 / 采集暂停', () => {
    expect(statusView(null)).toEqual({ kind: 'idle', text: '读取中…', detail: '' })

    const consent = statusView(snapshot({ consent: false }))
    expect(consent.kind).toBe('consent')
    expect(consent.detail).toContain('确认')

    const missingKey = statusView(
      snapshot({ client: { ok: false, reason: 'missing-key', apiKeyEnv: 'GOTCHA_KEY_DEEPSEEK' } })
    )
    expect(missingKey.kind).toBe('error')
    expect(missingKey.text).toContain('GOTCHA_KEY_DEEPSEEK')
    expect(missingKey.detail).toContain('设置')

    const paused = statusView(snapshot({ captureRunning: false, status: 'stopped' }))
    expect(paused.text).toBe('采集暂停，归纳已停')
  })

  it('背压：显示失败分类 + 约 N 分钟后重试', () => {
    const view = statusView(
      snapshot({
        status: 'backoff',
        nextRunAt: NOW + 120_000,
        lastFailure: {
          code: 'http',
          status: 429,
          message: 'LLM HTTP 429',
          at: NOW - 1000,
          streak: 2
        }
      }),
      NOW
    )
    expect(view.kind).toBe('backoff')
    expect(view.text).toBe('退避重试')
    expect(view.detail).toBe('供应商返回 HTTP 429 · 约 2 分钟后重试')
  })

  it('背压但没有分类信息时只显示重试时间（旧快照兼容）', () => {
    const view = statusView(snapshot({ status: 'backoff', nextRunAt: NOW + 45_000 }), NOW)
    expect(view.detail).toBe('约 1 分钟后重试')
  })

  it('解析类失败直接显示客户端固定文案（截断 / 校验）', () => {
    const truncated = statusView(
      snapshot({
        status: 'backoff',
        nextRunAt: NOW + 60_000,
        lastFailure: {
          code: 'parse',
          message: 'LLM 输出被 max_tokens（2000）截断（content 为空）',
          at: NOW,
          streak: 1
        }
      }),
      NOW
    )
    expect(truncated.detail).toContain('max_tokens（2000）')
  })

  it('校验类失败显示具体规则（字段 / 下标 / id）', () => {
    const view = statusView(
      snapshot({
        status: 'error',
        lastFailure: {
          code: 'validation',
          message: 'LLM 输出未通过校验（1 条问题）：nodes[0].title 超过 24 字',
          details: ['nodes[0].title 超过 24 字'],
          at: NOW,
          streak: 1
        }
      }),
      NOW
    )
    expect(view.detail).toContain('nodes[0].title 超过 24 字')
  })

  it('连续失败停自动：给出次数与恢复方式', () => {
    const view = statusView(
      snapshot({
        status: 'error',
        halted: true,
        lastFailure: {
          code: 'timeout',
          message: 'LLM 请求超时',
          at: NOW,
          streak: 5
        }
      }),
      NOW
    )
    expect(view.kind).toBe('error')
    expect(view.text).toBe('已停自动归纳')
    expect(view.detail).toContain('连续失败 5 次')
    expect(view.detail).toContain('立即归纳')
    expect(view.detail).toContain('请求超时')
  })

  it('未达上限的 error 只显示原因，不声称停自动', () => {
    const view = statusView(
      snapshot({
        status: 'error',
        lastFailure: { code: 'network', message: 'LLM 网络请求失败', at: NOW, streak: 2 }
      }),
      NOW
    )
    expect(view.text).toBe('上次失败')
    expect(view.detail).toBe('网络请求失败')
  })

  it('运行中 / 空闲 / 预算用尽', () => {
    expect(statusView(snapshot({ status: 'running' })).text).toBe('归纳中…')
    expect(statusView(snapshot({ status: 'idle' })).kind).toBe('ok')
    const budget = statusView(snapshot({ status: 'budget-exhausted' }))
    expect(budget.kind).toBe('budget')
    expect(budget.detail).toContain('token')
  })
})

describe('status-view · 文案工具', () => {
  it('retryEtaText：无排程 / 即将 / 分钟取整', () => {
    expect(retryEtaText(undefined, NOW)).toBeNull()
    expect(retryEtaText(NOW + 10_000, NOW)).toBe('即将重试')
    expect(retryEtaText(NOW + 61_000, NOW)).toBe('约 2 分钟后重试')
    expect(retryEtaText(NOW + 15 * 60_000, NOW)).toBe('约 15 分钟后重试')
  })

  it('failureReasonText：六类分类都有人话，未知分类回退消息', () => {
    expect(failureReasonText({ code: 'http', status: 500, message: '', at: NOW, streak: 1 })).toBe(
      '供应商返回 HTTP 500'
    )
    expect(failureReasonText({ code: 'timeout', message: '', at: NOW, streak: 1 })).toContain('超时')
    expect(failureReasonText({ code: 'network', message: '', at: NOW, streak: 1 })).toContain('网络')
    expect(failureReasonText({ code: 'config', message: '缺少 API key', at: NOW, streak: 1 })).toContain(
      '缺少 API key'
    )
    expect(failureReasonText({ code: 'parse', message: 'LLM 返回空 content', at: NOW, streak: 1 })).toBe(
      'LLM 返回空 content'
    )
    expect(failureReasonText({ code: 'unknown', message: '', at: NOW, streak: 1 })).toBe('未知错误')
    expect(failureReasonText(undefined)).toBeNull()
  })
})
