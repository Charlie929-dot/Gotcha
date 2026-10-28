import { describe, expect, it } from 'vitest'
import { createSearchHost, type SearchWorkerHandle } from '../../src/main/search-host'
import type { SearchRequestMessage, SearchResponseMessage } from '../../src/chain/query-remote'
import type { ChainSearchBatchQuery, ChainSearchBatchResult } from '../../src/chain/query'

interface FakeWorker {
  spawn: () => SearchWorkerHandle
  exitAll: (code: number) => void
  received: SearchRequestMessage[]
  spawnCount: number
  inFlightPeak: () => number
}

/** 假 worker：按请求回一条「命中数 = texts 长度」的假结果，便于断言顺序 / 串行 */
function createFakeWorker(
  options: {
    handler?: (message: SearchRequestMessage) => Promise<SearchResponseMessage | null>
    silent?: boolean
  } = {}
): FakeWorker {
  const received: SearchRequestMessage[] = []
  const workers: Array<{
    messageListeners: Array<(message: unknown) => void>
    exitListeners: Array<(code: number) => void>
  }> = []
  let spawnCount = 0
  let inFlight = 0
  let peak = 0

  return {
    get spawnCount() {
      return spawnCount
    },
    spawn: () => {
      spawnCount += 1
      const listeners = {
        messageListeners: [] as Array<(message: unknown) => void>,
        exitListeners: [] as Array<(code: number) => void>
      }
      workers.push(listeners)
      return {
        postMessage: (raw) => {
          const message = raw as SearchRequestMessage
          received.push(message)
          if (options.silent) return
          inFlight += 1
          peak = Math.max(peak, inFlight)
          const respond = options.handler
            ? options.handler(message)
            : Promise.resolve<SearchResponseMessage | null>({
                type: 'result',
                id: message.id,
                ok: true,
                result: {
                  hitsPerText: message.query.texts.map((text) => [
                    {
                      segment: { id: text.length, app: 'App', start_ts: 0 },
                      score: 1,
                      similarity: null,
                      matches: 1,
                      contentIds: [],
                      snippet: text,
                      tags: [],
                      links: [],
                      counts: { events: 0, shots: 0, contents: 0 }
                    }
                  ]),
                  stats: { mode: 'keyword', vectors: 0, skippedVectors: 0, keywordRows: 1 }
                } as unknown as ChainSearchBatchResult
              })
          void respond
            .then((response) => {
              inFlight -= 1
              if (!response) return
              for (const listener of listeners.messageListeners) listener(response)
            })
            .catch(() => {
              inFlight -= 1
            })
        },
        onMessage: (listener) => {
          listeners.messageListeners.push(listener)
        },
        onExit: (listener) => {
          listeners.exitListeners.push(listener)
        },
        kill: () => {
          for (const listener of listeners.exitListeners) listener(0)
        }
      }
    },
    exitAll: (code) => {
      for (const listeners of workers) {
        for (const listener of listeners.exitListeners) listener(code)
      }
    },
    get received() {
      return received
    },
    inFlightPeak: () => peak
  }
}

function query(texts: string[]): ChainSearchBatchQuery {
  return { texts, limit: 8, includeOpen: true }
}

describe('检索宿主：查询搬进 worker，主进程只发消息（§5.11）', () => {
  it('懒启动：第一次 search 才 fork；请求串行；结果按调用顺序返回', async () => {
    const worker = createFakeWorker()
    const host = createSearchHost({ dbPath: '/tmp/db.sqlite', spawn: worker.spawn })
    try {
      expect(host.spawnCount).toBe(0)
      const first = await host.search(query(['记忆球']))
      const second = await host.search(query(['性能', '优化']))
      expect(host.spawnCount).toBe(1)
      expect(first.hitsPerText).toHaveLength(1)
      expect(second.hitsPerText).toHaveLength(2)
      // 每条请求都自带库路径（worker 按路径懒开只读连接）
      expect(worker.received.every((message) => message.dbPath === '/tmp/db.sqlite')).toBe(true)
      expect(worker.received.map((message) => message.id)).toEqual([1, 2])
    } finally {
      host.dispose()
    }
  })

  it('并发调用：一次只放一条进 worker，回包顺序与调用顺序一致', async () => {
    const worker = createFakeWorker()
    const host = createSearchHost({ dbPath: '/tmp/db.sqlite', spawn: worker.spawn })
    try {
      const results = await Promise.all([
        host.search(query(['a'])),
        host.search(query(['bb'])),
        host.search(query(['ccc']))
      ])
      expect(results.map((result) => result.hitsPerText[0][0]?.snippet)).toEqual(['a', 'bb', 'ccc'])
      expect(worker.inFlightPeak()).toBe(1)
    } finally {
      host.dispose()
    }
  })

  it('worker 回 ok:false → search() 抛错（由调用方决定降级）', async () => {
    const worker = createFakeWorker({
      handler: async (message) => ({
        type: 'result',
        id: message.id,
        ok: false,
        code: 'query-failed',
        message: '库坏了'
      })
    })
    const host = createSearchHost({ dbPath: '/tmp/db.sqlite', spawn: worker.spawn })
    try {
      await expect(host.search(query(['x']))).rejects.toThrow('库坏了')
    } finally {
      host.dispose()
    }
  })

  it('超时：杀掉 worker、本次抛错，下一次调用自动重建', async () => {
    const worker = createFakeWorker({ silent: true })
    const host = createSearchHost({ dbPath: '/tmp/db.sqlite', spawn: worker.spawn, requestTimeoutMs: 30 })
    try {
      await expect(host.search(query(['x']))).rejects.toThrow(/超时/)
      expect(host.spawnCount).toBe(1)
      // 下一次调用重建 worker（仍卡死，继续超时，但 spawnCount 说明重建发生了）
      await expect(host.search(query(['x']))).rejects.toThrow(/超时/)
      expect(host.spawnCount).toBe(2)
    } finally {
      host.dispose()
    }
  })

  it('worker 退出：在途请求 reject；下次调用重建', async () => {
    const worker = createFakeWorker({
      handler: () => new Promise<SearchResponseMessage | null>(() => undefined)
    })
    const host = createSearchHost({
      dbPath: '/tmp/db.sqlite',
      spawn: worker.spawn,
      requestTimeoutMs: 50
    })
    try {
      const inflight = host.search(query(['x']))
      inflight.catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(worker.received).toHaveLength(1)
      worker.exitAll(1)
      await expect(inflight).rejects.toThrow(/退出/)
      // 重建后 handler 仍然不回：这一次按超时失败（说明重建确实发生了）
      await expect(host.search(query(['y']))).rejects.toThrow(/超时/)
      expect(host.spawnCount).toBe(2)
    } finally {
      host.dispose()
    }
  })

  it('dispose 之后再 search 直接失败，不再 fork', async () => {
    const worker = createFakeWorker()
    const host = createSearchHost({ dbPath: '/tmp/db.sqlite', spawn: worker.spawn })
    host.dispose()
    await expect(host.search(query(['x']))).rejects.toThrow(/已关闭/)
    expect(worker.spawnCount).toBe(0)
  })
})
