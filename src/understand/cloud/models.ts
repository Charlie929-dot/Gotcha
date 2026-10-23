/**
 * 拉取供应商模型目录（M2 Phase 2 设置界面 /「获取模型」）
 *
 * - 只在用户点击「获取模型」时由主进程发起：`GET {baseUrl}/models`（OpenAI 兼容）；
 * - 携带 `Authorization: Bearer <key>`，禁止跟随重定向（避免密钥被 302 带走）；
 * - 10 秒超时、响应体上限 1MB；错误消息只描述原因，不回显密钥 / 响应正文；
 * - 不发送任何采集内容，也不写日志（调用方只记「获取失败」）。
 */

import { normalizeBaseUrl } from './providers'

export interface FetchModelsOptions {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export type FetchModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string }

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_CHARS = 1_000_000

function modelIdOf(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() === '' ? null : item.trim()
  if (typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>
    for (const field of ['id', 'model', 'name'] as const) {
      const value = record[field]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  return null
}

/** 兼容 OpenAI（data[].id）/ 部分网关（models[] / 字符串数组）三种形态；去重排序 */
export function extractModelIds(payload: unknown): string[] {
  let items: unknown[] = []
  if (Array.isArray(payload)) {
    items = payload
  } else if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.data)) items = record.data
    else if (Array.isArray(record.models)) items = record.models
  }
  const ids: string[] = []
  for (const item of items) {
    const id = modelIdOf(item)
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids.sort((a, b) => a.localeCompare(b))
}

function httpErrorMessage(status: number): string {
  if (status === 400) return '请求被供应商拒绝（HTTP 400）'
  if (status === 401) return 'API Key 无效或已过期（HTTP 401）'
  if (status === 403) return 'API Key 无权限（HTTP 403）'
  if (status === 404) return '该供应商不支持 /models（HTTP 404），可手动填写模型名'
  if (status === 429) return '请求过于频繁（HTTP 429），请稍后再试'
  if (status >= 500) return `供应商服务异常（HTTP ${status}）`
  return `供应商返回 HTTP ${status}`
}

export async function fetchProviderModels(options: FetchModelsOptions): Promise<FetchModelsResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  if (!baseUrl) return { ok: false, error: 'Base URL 不合法（仅 https 或本机 http）' }
  const apiKey = options.apiKey.trim()
  if (apiKey === '') return { ok: false, error: '请先填写 API Key' }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境不支持网络请求' }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) return { ok: false, error: httpErrorMessage(response.status) }
    const text = await response.text()
    if (text.length > MAX_RESPONSE_CHARS) return { ok: false, error: '供应商返回内容过大' }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, error: '供应商返回的不是合法 JSON' }
    }
    const models = extractModelIds(payload)
    if (models.length === 0) {
      return { ok: false, error: '供应商没有返回可用模型，可手动填写模型名' }
    }
    return { ok: true, models }
  } catch {
    if (controller.signal.aborted) {
      const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`
      return { ok: false, error: `请求超时（${label}）` }
    }
    return { ok: false, error: '无法连接供应商（网络错误）' }
  } finally {
    clearTimeout(timer)
  }
}
