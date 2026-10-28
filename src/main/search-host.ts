/**
 * 检索宿主（主进程侧）：把 `search_info` 的 LIKE 全扫放进 `utilityProcess`。
 *
 * 形态照 `embedding-host.ts`（P1-4）：懒 fork、请求串行、单条超时后杀进程重建、
 * 退出时在途请求全部 reject、`dispose()` 供应用退出调用。
 *
 * 与向量宿主的差别：这里没有「模型就绪」这种前置条件，也没有 profile 概念——
 * 每条请求自带库路径，worker 自己懒开只读连接。失败语义由调用方决定：
 * 主进程在 `ask-ipc` 侧包一层「worker 不行就退回主线程查」，所以这层只管如实报错。
 */
import { join } from 'node:path'
import type { ChainSearchBatchQuery, ChainSearchBatchResult } from '../chain/query'
import type { SearchRequestMessage, SearchResponseMessage } from '../chain/query-remote'

/** worker 句柄：只留主进程用得到的三件事（便于单测注入） */
export interface SearchWorkerHandle {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number) => void): void
  kill(): void
}

export type SearchHostLogLevel = 'info' | 'warn' | 'error'

export interface SearchHostOptions {
  /** 库路径（每条请求都带：worker 按路径懒开只读连接） */
  dbPath: string
  /** 起一个 worker；缺省 `utilityProcess.fork(<out>/main/search-worker.js)` */
  spawn?: () => SearchWorkerHandle
  workerPath?: string
  log?: (level: SearchHostLogLevel, msg: string, data?: Record<string, unknown>) => void
  /** 单次检索超时（默认 20s：1.1 s 是 40 MB 正文的量级，留够冷启动与慢盘余量） */
  requestTimeoutMs?: number
}

export interface SearchHost {
  search(query: ChainSearchBatchQuery): Promise<ChainSearchBatchResult>
  dispose(): void
  /** 已经 fork 过几次（用例断言「超时 / 退出后会重建」） */
  readonly spawnCount: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

interface Pending {
  resolve: (response: SearchResponseMessage) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** 缺省 spawn：延迟 require electron，单测（纯 node）不会走到这里 */
function defaultSpawn(workerPath: string): () => SearchWorkerHandle {
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { utilityProcess } = require('electron') as typeof import('electron')
    const child = utilityProcess.fork(workerPath, [], { serviceName: 'gotcha-search' })
    return {
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => child.on('message', listener),
      onExit: (listener) => child.on('exit', listener),
      kill: () => {
        child.kill()
      }
    }
  }
}

function joinWorkerPath(): string {
  return join(__dirname, 'search-worker.js')
}

export function createSearchHost(options: SearchHostOptions): SearchHost {
  const requestTimeoutMs = Math.max(50, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  const spawn = options.spawn ?? defaultSpawn(options.workerPath ?? joinWorkerPath())
  const log = options.log ?? (() => undefined)

  let worker: SearchWorkerHandle | null = null
  let spawnCount = 0
  let disposed = false
  let nextId = 0
  const pending = new Map<number, Pending>()
  let gate: Promise<unknown> = Promise.resolve()

  const failAll = (error: unknown): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const ensureWorker = (): SearchWorkerHandle => {
    if (disposed) throw new Error('检索工作进程已关闭')
    if (worker) return worker
    const created = spawn()
    spawnCount += 1
    created.onMessage((message) => {
      const response = message as SearchResponseMessage | null
      if (!response || typeof response !== 'object' || response.type !== 'result') return
      const entry = pending.get(response.id)
      if (!entry) return
      pending.delete(response.id)
      clearTimeout(entry.timer)
      entry.resolve(response)
    })
    created.onExit((code) => {
      if (worker !== created) return
      worker = null
      failAll(new Error(`检索工作进程退出（code=${code}）`))
      log('warn', 'search worker exited', { code, pending: pending.size })
    })
    worker = created
    log('info', 'search worker started', { spawnCount })
    return created
  }

  const run = (query: ChainSearchBatchQuery): Promise<SearchResponseMessage> => {
    const target = ensureWorker()
    const id = ++nextId
    return new Promise<SearchResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`检索超时（${requestTimeoutMs} ms）`))
        // 卡住的 worker 不能再用：杀掉，下一次调用重建
        if (worker === target) {
          worker = null
          target.kill()
        }
      }, requestTimeoutMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      pending.set(id, { resolve, reject, timer })
      const message: SearchRequestMessage = {
        type: 'search',
        id,
        dbPath: options.dbPath,
        query: { ...query, texts: [...query.texts] }
      }
      target.postMessage(message)
    })
  }

  return {
    get spawnCount(): number {
      return spawnCount
    },
    search(query: ChainSearchBatchQuery): Promise<ChainSearchBatchResult> {
      const task = gate
        .catch(() => undefined)
        .then(async () => {
          if (disposed) throw new Error('检索工作进程已关闭')
          const response = await run(query)
          if (!response.ok || !response.result) {
            throw new Error(response.message ?? response.code ?? '检索失败')
          }
          return response.result
        })
      gate = task.catch(() => undefined)
      return task
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      failAll(new Error('检索工作进程已关闭'))
      const current = worker
      worker = null
      current?.kill()
    }
  }
}
