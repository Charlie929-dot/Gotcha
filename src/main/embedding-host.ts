/**
 * 主进程侧的向量推理宿主（P1-4）
 *
 * 把 `onnxruntime-node` 会话搬进 `utilityProcess`：主进程只发 `{type:'embed'}`、等 `{type:'result'}`，
 * 推理期间（512 token ≈ 258 ms）事件循环照常跑，球 / 热键 / IPC 不再被卡。
 *
 * - **懒启动**：第一次 `embed()` 才 fork（`utilityProcess.fork` 要求 app ready；这里不主动起进程）；
 * - **串行**：一次只放一条请求进去（会话本身也不是为并发设计的），排队顺序 = 调用顺序；
 * - **模型缺失同步拒绝**：`getEmbedder()` 里先看文件（与进程内老口径一致），不白起一个进程；
 * - **崩了能自愈**：worker 退出 / 超时 → 在途请求全部 reject，下一次调用重新 fork（会话重建 ~1s）；
 * - **红线**：日志与错误里没有正文，也没有向量；错误只带 code + 截断后的 message。
 *
 * 单测用注入的 `spawn`（内存假 worker，跑真协议），不依赖 Electron。
 */

import type { Embedder } from '../understand/embedding/types'
import { EMBEDDING_MODEL_NAME, EmbeddingError } from '../understand/embedding/types'
import { isModelReady, readModelDim } from '../understand/embedding/session'
import type {
  EmbedProfile,
  EmbedRequestMessage,
  EmbedResponseMessage
} from '../understand/embedding/remote'
import { EMBED_WORKER_MAX_TEXTS } from '../understand/embedding/remote'

/** worker 句柄：只留主进程用得到的三件事（便于单测注入） */
export interface EmbeddingWorkerHandle {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number) => void): void
  kill(): void
}

export type EmbeddingHostLogLevel = 'info' | 'warn' | 'error'

export interface EmbeddingHostOptions {
  /** 起一个 worker；缺省 `utilityProcess.fork(<out>/main/embedding-worker.js)` */
  spawn?: () => EmbeddingWorkerHandle
  /** worker 脚本路径（缺省 `join(__dirname, 'embedding-worker.js')`） */
  workerPath?: string
  log?: (level: EmbeddingHostLogLevel, msg: string, data?: Record<string, unknown>) => void
  /** 单次请求超时（默认 60s：冷启动要加载 90 MB 模型） */
  requestTimeoutMs?: number
}

export interface EmbeddingHost {
  /** 取某个 profile 的 embedder（同步；模型缺失直接抛 `EmbeddingError('model-missing')`） */
  getEmbedder(profile: EmbedProfile): Embedder
  /** 关掉 worker（应用退出时调用；之后再 embed 一律 reject） */
  dispose(): void
  /** 已经 fork 过几次（用例断言「退出后会重建」） */
  readonly spawnCount: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

interface Pending {
  resolve: (response: EmbedResponseMessage) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** 缺省 spawn：延迟 require electron，单测（纯 node）不会走到这里 */
function defaultSpawn(workerPath: string): () => EmbeddingWorkerHandle {
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { utilityProcess } = require('electron') as typeof import('electron')
    const child = utilityProcess.fork(workerPath, [], { serviceName: 'gotcha-embedding' })
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

export function createEmbeddingHost(options: EmbeddingHostOptions = {}): EmbeddingHost {
  const requestTimeoutMs = Math.max(50, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  const spawn =
    options.spawn ??
    defaultSpawn(options.workerPath ?? joinWorkerPath())

  let worker: EmbeddingWorkerHandle | null = null
  let spawnCount = 0
  let disposed = false
  let nextId = 0
  const pending = new Map<number, Pending>()
  /** 串行闸门：上一条回包（或失败）后才发下一条 */
  let gate: Promise<unknown> = Promise.resolve()

  const log = options.log ?? (() => undefined)

  const failAll = (error: unknown): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const ensureWorker = (): EmbeddingWorkerHandle => {
    if (disposed) throw new EmbeddingError('run-failed', '向量工作进程已关闭')
    if (worker) return worker
    let created: EmbeddingWorkerHandle
    try {
      created = spawn()
    } catch (error) {
      // 产物缺失 / 权限问题：包成 EmbeddingError，调用方按「向量不可用」降级，别把裸 Error 抛给派生层
      throw new EmbeddingError(
        'session-failed',
        `无法启动向量工作进程：${error instanceof Error ? error.message : String(error)}`
      )
    }
    spawnCount += 1
    created.onMessage((message) => {
      const response = message as EmbedResponseMessage | null
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
      // 在途请求没有回包了：全部按失败处理，调用方自己决定降级
      failAll(new EmbeddingError('run-failed', `向量工作进程退出（code=${code}）`))
      log('warn', 'embedding worker exited', { code, pending: pending.size })
    })
    worker = created
    log('info', 'embedding worker started', { spawnCount })
    return created
  }

  const run = (profile: EmbedProfile, texts: readonly string[]): Promise<EmbedResponseMessage> => {
    const target = ensureWorker()
    const id = ++nextId
    return new Promise<EmbedResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new EmbeddingError('run-failed', `向量推理超时（${requestTimeoutMs} ms）`))
        // 卡住的 worker 不能再用：杀掉，下一次调用重建
        if (worker === target) {
          worker = null
          target.kill()
        }
      }, requestTimeoutMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      pending.set(id, { resolve, reject, timer })
      const message: EmbedRequestMessage = {
        type: 'embed',
        id,
        profile,
        texts: [...texts]
      }
      target.postMessage(message)
    })
  }

  const enqueue = (profile: EmbedProfile, texts: readonly string[]): Promise<Float32Array[]> => {
    const task = gate
      .catch(() => undefined)
      .then(async () => {
        if (disposed) throw new EmbeddingError('run-failed', '向量工作进程已关闭')
        const response = await run(profile, texts)
        if (!response.ok) throw new EmbeddingError(response.code, response.message)
        return response.vectors.map((vector) => toFloat32(vector))
      })
    gate = task.catch(() => undefined)
    return task
  }

  const embedders = new Map<string, Embedder>()

  return {
    get spawnCount(): number {
      return spawnCount
    },
    getEmbedder(profile: EmbedProfile): Embedder {
      const cacheKey = `${profile.key}@${profile.modelDir}@${profile.maxLength}@${profile.batchSize}@${profile.intraOpNumThreads}`
      const cached = embedders.get(cacheKey)
      if (cached) return cached
      if (!isModelReady(profile.modelDir)) {
        throw new EmbeddingError('model-missing', `缺少 model.onnx：${profile.modelDir}`)
      }
      const embedder: Embedder = {
        model: EMBEDDING_MODEL_NAME,
        dim: readModelDim(profile.modelDir),
        // 协议层上限（一条消息 64 条文本）由宿主吸收：调用方按「一批名字」一次传几百条是常态
        // （真实库 401 条双链名 → 一次 `embed()` 就超限，整段派生会因为一个协议限制直接失败）。
        embed: async (texts) => {
          if (texts.length === 0) return []
          if (texts.length <= EMBED_WORKER_MAX_TEXTS) return enqueue(profile, texts)
          const vectors: Float32Array[] = []
          for (let index = 0; index < texts.length; index += EMBED_WORKER_MAX_TEXTS) {
            vectors.push(
              ...(await enqueue(profile, texts.slice(index, index + EMBED_WORKER_MAX_TEXTS)))
            )
          }
          return vectors
        }
      }
      embedders.set(cacheKey, embedder)
      return embedder
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      failAll(new EmbeddingError('run-failed', '向量工作进程已关闭'))
      const current = worker
      worker = null
      current?.kill()
      embedders.clear()
    }
  }
}

/** 结构化克隆回来的 Float32Array 原样用；万一被序列化成普通数组也能兜住 */
function toFloat32(value: Float32Array | number[] | ArrayLike<number>): Float32Array {
  if (value instanceof Float32Array) return value
  return Float32Array.from(value as ArrayLike<number>)
}

function joinWorkerPath(): string {
  // 主进程 bundle 在 out/main/ 下，worker 与它同目录（见 electron.vite.config.ts 的第二个 input）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  return join(__dirname, 'embedding-worker.js')
}
