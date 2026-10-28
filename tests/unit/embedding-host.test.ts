import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmbeddingHost, type EmbeddingWorkerHandle } from '../../src/main/embedding-host'
import {
  createEmbedWorkerHandler,
  EMBED_WORKER_MAX_TEXTS,
  readEmbedProfile,
  type EmbedProfile,
  type EmbedRequestMessage,
  type EmbedResponseMessage
} from '../../src/understand/embedding/remote'
import { EmbeddingError, type Embedder } from '../../src/understand/embedding/types'

const tempDirs: string[] = []
function makeModelDir(hiddenSize = 8): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-embed-host-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'model.onnx'), Buffer.alloc(1_000_000))
  writeFileSync(join(dir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\n你\n好\n')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ hidden_size: hiddenSize }))
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function profile(modelDir: string, key = 'chain'): EmbedProfile {
  return { key, modelDir, maxLength: 512, batchSize: 1, intraOpNumThreads: 4 }
}

/** 假 embedder：按文本长度造向量，便于断言顺序 */
function fakeEmbedder(dim = 8): Embedder {
  return {
    model: 'bge-small-zh-v1.5',
    dim,
    embed: async (texts) =>
      texts.map((text) => {
        const vector = new Float32Array(dim)
        vector[0] = text.length
        return vector
      })
  }
}

interface FakeWorkerOptions {
  /** 处理一条请求（缺省跑真协议 + 假 embedder） */
  handler?: (message: EmbedRequestMessage) => Promise<EmbedResponseMessage | null>
  /** 忽略请求（模拟卡死） */
  silent?: boolean
}

interface FakeWorker {
  spawn: () => EmbeddingWorkerHandle
  exitAll: (code: number) => void
  received: EmbedRequestMessage[]
  spawnCount: number
  inFlightPeak: () => number
}

function createFakeWorker(options: FakeWorkerOptions = {}): FakeWorker {
  const protocol = createEmbedWorkerHandler({ createEmbedder: async () => fakeEmbedder() })
  const handle: (message: EmbedRequestMessage) => Promise<EmbedResponseMessage | null> =
    options.handler ?? ((message) => protocol.handle(message))
  const received: EmbedRequestMessage[] = []
  let spawnCount = 0
  let inFlight = 0
  let peak = 0
  const workers: Array<{
    messageListeners: Array<(message: unknown) => void>
    exitListeners: Array<(code: number) => void>
  }> = []

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
          const message = raw as EmbedRequestMessage
          received.push(message)
          if (options.silent) return
          inFlight += 1
          peak = Math.max(peak, inFlight)
          void Promise.resolve()
            .then(() => handle(message))
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

describe('embedding host：主进程只发消息、不跑推理（P1-4）', () => {
  it('走协议拿到向量；同 profile 复用同一个 embedder 对象', async () => {
    const dir = makeModelDir()
    const worker = createFakeWorker()
    const host = createEmbeddingHost({ spawn: worker.spawn })
    try {
      const embedder = host.getEmbedder(profile(dir))
      expect(embedder.model).toBe('bge-small-zh-v1.5')
      expect(embedder.dim).toBe(8)

      const [first, second] = await embedder.embed(['你好', '你好你好'])
      expect(Array.from(first)).toEqual([2, 0, 0, 0, 0, 0, 0, 0])
      expect(second[0]).toBe(4)
      expect(host.getEmbedder(profile(dir))).toBe(embedder)
      expect(worker.received[0]?.profile.key).toBe('chain')
    } finally {
      host.dispose()
    }
  })

  it('超过单条消息上限（64 条）时自动分片：顺序不变、每条消息都不超限', async () => {
    // 真实库里 401 条双链名会一次进 embed()；协议层的 64 条上限由宿主吸收，
    // 否则整段派生会因为「一次发了 401 条」直接失败（真机 10-28 晚踩到）。
    const dir = makeModelDir()
    const worker = createFakeWorker()
    const host = createEmbeddingHost({ spawn: worker.spawn })
    try {
      const embedder = host.getEmbedder(profile(dir))
      const texts = Array.from({ length: 150 }, (_, index) => 'x'.repeat(index + 1))
      const vectors = await embedder.embed(texts)
      expect(vectors).toHaveLength(texts.length)
      expect(vectors.map((vector) => vector[0])).toEqual(texts.map((text) => text.length))
      expect(worker.received.map((message) => message.texts.length)).toEqual([64, 64, 22])
      expect(worker.received.every((message) => message.texts.length <= EMBED_WORKER_MAX_TEXTS)).toBe(
        true
      )
      // 分片仍然串行：一次只有一条在 worker 里
      expect(worker.inFlightPeak()).toBe(1)
    } finally {
      host.dispose()
    }
  })

  it('空文本不发请求、不起 worker', async () => {
    const dir = makeModelDir()
    const worker = createFakeWorker()
    const host = createEmbeddingHost({ spawn: worker.spawn })
    try {
      await expect(host.getEmbedder(profile(dir)).embed([])).resolves.toEqual([])
      expect(worker.spawnCount).toBe(0)
    } finally {
      host.dispose()
    }
  })

  it('模型缺失：getEmbedder 直接抛 model-missing，不起 worker', () => {
    const worker = createFakeWorker()
    const host = createEmbeddingHost({ spawn: worker.spawn })
    try {
      expect(() => host.getEmbedder(profile(join(tmpdir(), 'no-such-model-dir')))).toThrow(
        EmbeddingError
      )
      expect(worker.spawnCount).toBe(0)
    } finally {
      host.dispose()
    }
  })

  it('请求串行：并发调用一次只放一条进 worker', async () => {
    const dir = makeModelDir()
    const worker = createFakeWorker()
    const host = createEmbeddingHost({ spawn: worker.spawn })
    try {
      const embedder = host.getEmbedder(profile(dir))
      const results = await Promise.all([
        embedder.embed(['a']),
        embedder.embed(['bb']),
        embedder.embed(['ccc'])
      ])
      expect(results.map(([vector]) => vector[0])).toEqual([1, 2, 3])
      expect(worker.received.map((message) => message.id)).toEqual([1, 2, 3])
      expect(worker.inFlightPeak()).toBe(1)
    } finally {
      host.dispose()
    }
  })

  it('worker 回 ok:false → 抛对应 code 的 EmbeddingError', async () => {
    const dir = makeModelDir()
    const worker = createFakeWorker({
      handler: async (message) => ({
        type: 'result',
        id: message.id,
        ok: false,
        code: 'session-failed',
        message: '无法加载模型会话'
      })
    })
    const host = createEmbeddingHost({ spawn: worker.spawn })
    try {
      const error = await host
        .getEmbedder(profile(dir))
        .embed(['x'])
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EmbeddingError)
      expect((error as EmbeddingError).code).toBe('session-failed')
    } finally {
      host.dispose()
    }
  })

  it('worker 退出：在途请求失败，下一次调用重建进程', async () => {
    const dir = makeModelDir()
    let block: (() => void) | null = null
    const worker = createFakeWorker({
      handler: (message) => {
        // 第一条卡住（等测试放行），第二条正常
        if (message.id === 1) {
          return new Promise((resolve) => {
            block = () =>
              resolve({ type: 'result', id: message.id, ok: true, model: 'm', dim: 8, vectors: [] })
          })
        }
        return Promise.resolve({
          type: 'result',
          id: message.id,
          ok: true,
          model: 'm',
          dim: 8,
          vectors: [new Float32Array(8)]
        })
      }
    })
    const host = createEmbeddingHost({ spawn: worker.spawn })
    try {
      const embedder = host.getEmbedder(profile(dir))
      const first = embedder.embed(['a'])
      await new Promise((resolve) => setTimeout(resolve, 10))
      worker.exitAll(1)
      await expect(first).rejects.toMatchObject({ code: 'run-failed' })
      expect(block).not.toBeNull()

      const again = await embedder.embed(['bb'])
      expect(again).toHaveLength(1)
      expect(worker.spawnCount).toBe(2)
    } finally {
      host.dispose()
    }
  })

  it('推理超时：拒绝在途请求并杀掉 worker', async () => {
    const dir = makeModelDir()
    const worker = createFakeWorker({ silent: true })
    const host = createEmbeddingHost({ spawn: worker.spawn, requestTimeoutMs: 60 })
    try {
      const error = await host
        .getEmbedder(profile(dir))
        .embed(['x'])
        .catch((caught: unknown) => caught)
      expect((error as EmbeddingError).code).toBe('run-failed')
      expect((error as EmbeddingError).message).toContain('超时')
    } finally {
      host.dispose()
    }
  })

  it('dispose 之后不再接活', async () => {
    const dir = makeModelDir()
    const worker = createFakeWorker()
    const host = createEmbeddingHost({ spawn: worker.spawn })
    const embedder = host.getEmbedder(profile(dir))
    host.dispose()
    await expect(embedder.embed(['x'])).rejects.toMatchObject({ code: 'run-failed' })
  })
})

describe('worker 侧协议处理', () => {
  it('非法消息一律忽略（返回 null），坏 id / 坏 profile 回 run-failed', async () => {
    const handler = createEmbedWorkerHandler({ createEmbedder: async () => fakeEmbedder() })
    expect(await handler.handle(null)).toBeNull()
    expect(await handler.handle({ type: 'ping' })).toBeNull()
    expect(await handler.handle({ type: 'embed', id: 0, profile: null, texts: [] })).toBeNull()

    const badProfile = await handler.handle({ type: 'embed', id: 3, profile: { key: 'x' }, texts: ['a'] })
    expect(badProfile).toMatchObject({ id: 3, ok: false, code: 'run-failed' })
  })

  it('空文本回 empty-input；条数超上限回 run-failed', async () => {
    const handler = createEmbedWorkerHandler({ createEmbedder: async () => fakeEmbedder() })
    const dir = makeModelDir()
    expect(
      await handler.handle({ type: 'embed', id: 1, profile: profile(dir), texts: [] })
    ).toMatchObject({ ok: false, code: 'empty-input' })
    expect(
      await handler.handle({
        type: 'embed',
        id: 2,
        profile: profile(dir),
        texts: Array.from({ length: EMBED_WORKER_MAX_TEXTS + 1 }, () => 'x')
      })
    ).toMatchObject({ ok: false, code: 'run-failed' })
  })

  it('worker 起不来：包成 session-failed 的 EmbeddingError', async () => {
    const dir = makeModelDir()
    const host = createEmbeddingHost({
      spawn: () => {
        throw new Error('spawn ENOENT')
      }
    })
    try {
      const error = await host
        .getEmbedder(profile(dir))
        .embed(['x'])
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EmbeddingError)
      expect((error as EmbeddingError).code).toBe('session-failed')
      expect((error as EmbeddingError).message).toContain('ENOENT')
    } finally {
      host.dispose()
    }
  })

  it('同一 profile 只建一次会话；建会话失败不缓存', async () => {
    let created = 0
    let failNext = true
    const dir = makeModelDir()
    const handler = createEmbedWorkerHandler({
      createEmbedder: async () => {
        created += 1
        if (failNext) {
          failNext = false
          throw new EmbeddingError('model-missing', '缺少 model.onnx')
        }
        return fakeEmbedder()
      }
    })
    const failed = await handler.handle({ type: 'embed', id: 1, profile: profile(dir), texts: ['a'] })
    expect(failed).toMatchObject({ ok: false, code: 'model-missing' })

    const ok = await handler.handle({ type: 'embed', id: 2, profile: profile(dir), texts: ['a'] })
    expect(ok).toMatchObject({ ok: true, dim: 8 })
    await handler.handle({ type: 'embed', id: 3, profile: profile(dir), texts: ['b'] })
    expect(created).toBe(2)
    expect(handler.sessionCount).toBe(1)
  })

  it('readEmbedProfile 只认完整字段', () => {
    const dir = makeModelDir()
    expect(readEmbedProfile(profile(dir))).toEqual(profile(dir))
    expect(readEmbedProfile({ ...profile(dir), maxLength: '512' })).toBeNull()
    expect(readEmbedProfile({ ...profile(dir), key: '' })).toBeNull()
    expect(readEmbedProfile({ ...profile(dir), modelDir: 1 })).toBeNull()
  })
})
