/**
 * 归纳状态徽标（纯函数；DOM 接线在 `graph.ts`，这样文案可以单测）
 *
 * - 徽标只放「一句话状态」，「为什么」放进旁边的灰色小字（`detail`）；
 * - 失败原因全部来自 service 的 `InductionFailure` 分类：HTTP 状态码 / 超时 / 网络 /
 *   解析（截断、校验）/ 配置——不含提示词、响应正文、密钥；
 * - 退避时给出「约 N 分钟后重试」，连续失败停自动时提示「点『立即归纳』可恢复」。
 */

import type { InductionSnapshot } from '../../main/induction-runtime'
import type { InductionFailure } from '../../understand/service'

export const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '归纳中…',
  backoff: '退避重试',
  error: '上次失败',
  'budget-exhausted': '今日预算已用尽',
  stopped: '未运行'
}

export interface StatusView {
  /** 对应 `.status[data-kind]` 的样式键 */
  kind: string
  /** 徽标上的短文案 */
  text: string
  /** 徽标右侧的细节（失败原因 / 下次重试）；空串表示不显示 */
  detail: string
}

/** 「约 N 分钟后重试」；没有排程或已到点时返回 null / 即将重试 */
export function retryEtaText(nextRunAt: number | undefined, now = Date.now()): string | null {
  if (nextRunAt === undefined || !Number.isFinite(nextRunAt)) return null
  const remaining = nextRunAt - now
  if (remaining <= 30_000) return '即将重试'
  return `约 ${Math.ceil(remaining / 60_000)} 分钟后重试`
}

/** 失败分类 → 人话（只做展示，不引入新信息） */
export function failureReasonText(failure: InductionFailure | undefined): string | null {
  if (!failure) return null
  switch (failure.code) {
    case 'http':
      return failure.status !== undefined ? `供应商返回 HTTP ${failure.status}` : '供应商返回 HTTP 错误'
    case 'timeout':
      return '请求超时（60 秒）'
    case 'network':
      return '网络请求失败'
    case 'config':
      return `配置错误：${failure.message}`
    case 'parse':
      // 客户端已给出可定位的固定文案（截断 / 非法 JSON / 未通过校验）
      return failure.message
    default:
      return failure.message === '' ? '未知错误' : failure.message
  }
}

export function statusView(current: InductionSnapshot | null, now = Date.now()): StatusView {
  if (!current) return { kind: 'idle', text: '读取中…', detail: '' }

  if (!current.consent) {
    return { kind: 'consent', text: '未确认出网', detail: '确认后才会把脱敏内容发往供应商' }
  }

  if (!current.client.ok) {
    if (current.client.reason === 'missing-key') {
      return {
        kind: 'error',
        text: `未配置密钥（${current.client.apiKeyEnv ?? '环境变量'}）`,
        detail: '到设置里填写 API Key，保存后立即生效'
      }
    }
    if (current.client.reason === 'invalid-providers') {
      return { kind: 'error', text: '供应商配置损坏', detail: '到设置里重新保存供应商' }
    }
    if (current.client.reason === 'unknown-provider') {
      return { kind: 'error', text: '当前供应商不存在', detail: '到设置里选一个已保存的供应商' }
    }
    return { kind: 'error', text: '供应商配置不可用', detail: '到设置里检查供应商配置' }
  }

  if (!current.captureRunning && current.status === 'stopped') {
    return { kind: 'idle', text: '采集暂停，归纳已停', detail: '' }
  }

  if (current.status === 'budget-exhausted') {
    return {
      kind: 'budget',
      text: STATUS_LABEL[current.status],
      detail: '调高每日 token 预算，或等明天额度重置'
    }
  }

  if (current.status === 'running') {
    return { kind: 'running', text: STATUS_LABEL[current.status], detail: '' }
  }

  if (current.status === 'backoff') {
    const detail = [failureReasonText(current.lastFailure), retryEtaText(current.nextRunAt, now)]
      .filter((part): part is string => part !== null && part !== '')
      .join(' · ')
    return { kind: 'backoff', text: STATUS_LABEL[current.status], detail }
  }

  if (current.status === 'error') {
    const reason = failureReasonText(current.lastFailure)
    if (current.halted) {
      const streak = current.lastFailure?.streak
      const detail = [
        reason,
        streak !== undefined ? `连续失败 ${streak} 次` : null,
        '已停自动归纳，点「立即归纳」可恢复'
      ]
        .filter((part): part is string => part !== null && part !== '')
        .join(' · ')
      return { kind: 'error', text: '已停自动归纳', detail }
    }
    return { kind: 'error', text: STATUS_LABEL[current.status], detail: reason ?? '' }
  }

  return {
    kind: current.status === 'idle' ? 'ok' : 'idle',
    text: STATUS_LABEL[current.status] ?? current.status,
    detail: ''
  }
}
