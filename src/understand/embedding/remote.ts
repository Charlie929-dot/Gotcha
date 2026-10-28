/**
 * 本地向量推理的跨进程协议（主进程 ↔ utilityProcess；P1-4）
 *
 * 为什么要有它：`onnxruntime-node` 的 `session.run()` 在推理期间**独占 JS 线程**
 * （512 token 约 258 ms，见 `性能优化方案.md` §3 D2）。段收口一次就卡一次主进程，
 * 球/热键/窗口全跟着停。把会话搬进 `utilityProcess` 后主进程只发消息、等回包，
 * 推理再慢也不会挡住事件循环。
 *
 * 约定：
 * - 一次消息只带**一种** request；`id` 由主进程分配，回应原样带回；
 * - 文本与向量**不落日志**：错误只回 code + 截断后的 message（可能是模型路径，不含正文）；
 * - profile 带模型目录与推理参数（图谱 256 token / 信息链 512 token 各一份），
 *   同一个 profile key 在 worker 里只会建一次会话；
 * - 建会话失败不缓存（装好模型后重试就能成功）。
 */

import type { Embedder, EmbeddingErrorCode } from './types'
import { EmbeddingError } from './types'

export interface EmbedProfile {
  /** 会话缓存 key（'chain' / 'graph'；同 key 必须同参数） */
  key: string
  modelDir: string
  maxLength: number
  batchSize: number
  intraOpNumThreads: number
}

export interface EmbedRequestMessage {
  type: 'embed'
  id: number
  profile: EmbedProfile
  texts: string[]
}

export type EmbedResponseMessage =
  | {
      type: 'result'
      id: number
      ok: true
      model: string
      dim: number
      vectors: Float32Array[]
    }
  | { type: 'result'; id: number; ok: false; code: EmbeddingErrorCode; message: string }

/** 单条消息的文本条数上限（防御异常调用方把主进程内存灌爆） */
export const EMBED_WORKER_MAX_TEXTS = 64
/** 单条文本字符上限（段正文在调用方已经截断过，这里只兜底） */
export const EMBED_WORKER_MAX_TEXT_CHARS = 20_000

const ERROR_CODES: readonly EmbeddingErrorCode[] = [
  'model-missing',
  'vocab-missing',
  'session-failed',
  'run-failed',
  'empty-input'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): EmbeddingErrorCode {
  if (error instanceof EmbeddingError && ERROR_CODES.includes(error.code)) return error.code
  return 'run-failed'
}

/** 错误信息只保留一行、截断到 200 字：够定位，不把正文带进日志 */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw.replace(/\s+/g, ' ').trim()
  return line.length <= 200 ? line : `${line.slice(0, 200)}…`
}

/** 读 profile（坏输入返回 null，不抛） */
export function readEmbedProfile(value: unknown): EmbedProfile | null {
  if (!isRecord(value)) return null
  const key = value.key
  const modelDir = value.modelDir
  const maxLength = value.maxLength
  const batchSize = value.batchSize
  const intraOpNumThreads = value.intraOpNumThreads
  if (typeof key !== 'string' || key === '' || key.length > 32) return null
  if (typeof modelDir !== 'string' || modelDir === '') return null
  if (typeof maxLength !== 'number' || !Number.isFinite(maxLength)) return null
  if (typeof batchSize !== 'number' || !Number.isFinite(batchSize)) return null
  if (typeof intraOpNumThreads !== 'number' || !Number.isFinite(intraOpNumThreads)) return null
  return {
    key,
    modelDir,
    maxLength,
    batchSize,
    intraOpNumThreads
  }
}

export interface EmbedWorkerHandlerDeps {
  /** 建一个真实会话（缺省由 worker 入口注入 `createLocalEmbedder`） */
  createEmbedder: (profile: EmbedProfile) => Promise<Embedder>
}

export interface EmbedWorkerHandler {
  /** 处理一条消息；不是 embed 请求返回 null（worker 入口只回非 null 的） */
  handle(message: unknown): Promise<EmbedResponseMessage | null>
  /** 已建会话数（用例断言「同 profile 只建一次」） */
  readonly sessionCount: number
}

/**
 * worker 侧的消息处理（纯逻辑，不碰 `process.parentPort`，单测直接调）。
 */
export function createEmbedWorkerHandler(deps: EmbedWorkerHandlerDeps): EmbedWorkerHandler {
  const sessions = new Map<string, Promise<Embedder>>()

  const session = (profile: EmbedProfile): Promise<Embedder> => {
    const cached = sessions.get(profile.key)
    if (cached) return cached
    const created = deps.createEmbedder(profile).catch((error: unknown) => {
      // 建会话失败不缓存：用户装好模型 / 换了目录后下一次请求要能成功
      sessions.delete(profile.key)
      throw error
    })
    sessions.set(profile.key, created)
    return created
  }

  return {
    get sessionCount(): number {
      return sessions.size
    },
    async handle(message: unknown): Promise<EmbedResponseMessage | null> {
      if (!isRecord(message) || message.type !== 'embed') return null
      const id = message.id
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null

      const profile = readEmbedProfile(message.profile)
      const texts = message.texts
      if (
        !profile ||
        !Array.isArray(texts) ||
        texts.length > EMBED_WORKER_MAX_TEXTS ||
        texts.some(
          (text) =>
            typeof text !== 'string' ||
            text.length > EMBED_WORKER_MAX_TEXT_CHARS
        )
      ) {
        return { type: 'result', id, ok: false, code: 'run-failed', message: '请求不合法' }
      }
      if (texts.length === 0) {
        return { type: 'result', id, ok: false, code: 'empty-input', message: '没有要算的文本' }
      }

      try {
        const embedder = await session(profile)
        const vectors = await embedder.embed(texts as string[])
        return {
          type: 'result',
          id,
          ok: true,
          model: embedder.model,
          dim: embedder.dim,
          vectors
        }
      } catch (error) {
        return { type: 'result', id, ok: false, code: errorCode(error), message: safeMessage(error) }
      }
    }
  }
}
