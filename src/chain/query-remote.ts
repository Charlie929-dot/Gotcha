/**
 * 检索的跨进程协议（性能方案 §5.11 的下一步：把 `search_info` 搬出主线程）。
 *
 * 为什么：`searchChainSegmentsBatch()` 是一条同步的 LIKE 全扫 + 归因，
 * 39.7 MB 正文实测 **1.1 s**，这段时间主进程的事件循环完全停住（球、热键、窗口 IPC
 * 一起卡）——和 P1-4 的 `onnxruntime` 是同一类问题。SQLite 本身没有异步 API，
 * 所以只能把「跑查询的那条连接」放进 `utilityProcess`。
 *
 * 协议刻意做成无状态的：每条请求自带 `dbPath`，worker 按路径懒开只读连接。
 * 这样主进程切库（重开 / 迁移）不需要握手，worker 也不需要知道 userData 在哪。
 *
 * 日志红线不变：不回正文、不回向量，错误只带 code + 截断后的 message。
 */
import type { ChainDb } from './store'
import {
  searchChainSegmentsBatch,
  type ChainSearchBatchQuery,
  type ChainSearchBatchResult
} from './query'

/** 一条消息里最多几个关键词（工具侧上限 8；留两倍余量，别让越界输入在 worker 里跑） */
export const SEARCH_WORKER_MAX_TEXTS = 16
export const SEARCH_WORKER_MAX_LIMIT = 200
export const SEARCH_WORKER_MAX_QUERY_CHARS = 200
const MAX_ERROR_MESSAGE = 200

export interface SearchRequestMessage {
  type: 'search'
  id: number
  /** 库路径（主进程给；worker 按路径懒开只读连接） */
  dbPath: string
  query: ChainSearchBatchQuery
}

export interface SearchResponseMessage {
  type: 'result'
  id: number
  ok: boolean
  /** ok=true 时的检索结果（`Float32Array` 字段不会出现在关键词路上） */
  result?: ChainSearchBatchResult
  /** ok=false 时的错误码（`invalid-input` / `query-failed` / …） */
  code?: string
  message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只保留 `searchChainSegmentsBatch()` 认得的字段（模型 / 调用方给的东西一律不直接透传） */
function readQuery(raw: unknown): ChainSearchBatchQuery | null {
  if (!isRecord(raw)) return null
  const textsRaw = raw.texts
  if (!Array.isArray(textsRaw) || textsRaw.length === 0) return null
  if (textsRaw.length > SEARCH_WORKER_MAX_TEXTS) return null
  const texts: string[] = []
  for (const text of textsRaw) {
    if (typeof text !== 'string' || text.length > SEARCH_WORKER_MAX_QUERY_CHARS) return null
    texts.push(text)
  }
  const query: ChainSearchBatchQuery = { texts }
  if (typeof raw.limit === 'number' && Number.isFinite(raw.limit)) {
    query.limit = Math.min(SEARCH_WORKER_MAX_LIMIT, Math.max(1, Math.floor(raw.limit)))
  }
  if (typeof raw.includeOpen === 'boolean') query.includeOpen = raw.includeOpen
  if (typeof raw.dayKey === 'string') query.dayKey = raw.dayKey
  for (const key of ['from', 'to'] as const) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) query[key] = value
  }
  if (typeof raw.app === 'string') query.app = raw.app
  if (typeof raw.tag === 'string') query.tag = raw.tag
  if (typeof raw.link === 'string') query.link = raw.link
  return query
}

function shortMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value.length > MAX_ERROR_MESSAGE ? `${value.slice(0, MAX_ERROR_MESSAGE)}…` : value
}

export interface SearchWorkerHandler {
  /** 处理一条消息；不是检索请求返回 null（worker 入口直接丢掉） */
  handle(message: unknown): Promise<SearchResponseMessage | null>
}

/**
 * worker 侧纯处理函数：`open(dbPath)` 注入只读连接工厂，单测里可以塞内存库。
 * 失败一律回 `{ok:false, code}`，不 throw 到进程级（throw 会让整个 worker 退出）。
 */
export function createSearchWorkerHandler(deps: {
  open: (dbPath: string) => ChainDb
}): SearchWorkerHandler {
  return {
    async handle(message: unknown): Promise<SearchResponseMessage | null> {
      if (!isRecord(message) || message.type !== 'search') return null
      const id = message.id
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null
      const dbPath = message.dbPath
      if (typeof dbPath !== 'string' || dbPath === '') {
        return { type: 'result', id, ok: false, code: 'invalid-input', message: '缺少库路径' }
      }
      const query = readQuery(message.query)
      if (!query) {
        return { type: 'result', id, ok: false, code: 'invalid-input', message: '查询参数不合法' }
      }
      try {
        const result = searchChainSegmentsBatch(deps.open(dbPath), query)
        return { type: 'result', id, ok: true, result }
      } catch (error) {
        return {
          type: 'result',
          id,
          ok: false,
          code: 'query-failed',
          message: shortMessage((error as { message?: unknown }).message)
        }
      }
    }
  }
}
