/**
 * onnxruntime-node 会话封装（docs/m2-graph-redesign.md §10）
 *
 * - 模型与词表是用户本地资产：`%APPDATA%/Gotcha/models/bge-small-zh-v1.5/`，不自动下载、不进 git；
 * - 懒加载：主进程只在真正要算向量时才 import 原生模块，采集/时间线不受影响；
 * - 池化：取每个序列第 0 位（`[CLS]`）再 L2 归一化（bge 的 CLS pooling 口径）；
 * - 日志红线：错误只带 code / 路径存在性，不带主题正文或向量。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BERT_MAX_LENGTH, encodeText, loadVocab, type BertVocab } from './tokenizer'
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL_NAME,
  EmbeddingError,
  type Embedder
} from './types'

/** ORT 张量的数据（int64 输入是 BigInt64Array，浮点输出是 Float32Array） */
export type OrtTensorData = ArrayLike<number> | ArrayLike<bigint>

/** 运行一次推理所需的最小 ORT 形状（便于用例注入假实现） */
export interface OrtTensorLike {
  data: OrtTensorData
  dims: number[]
}

export interface OrtSessionLike {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>
}

export interface OrtModuleLike {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSessionLike>
  }
  Tensor: new (type: string, data: OrtTensorData, dims: number[]) => OrtTensorLike
}

export interface LocalEmbedderOptions {
  /** 模型目录（含 `model.onnx` 与 `vocab.txt`） */
  modelDir: string
  modelName?: string
  /** 每次推理的文本条数（默认 8） */
  batchSize?: number
  /** 含特殊符号的最大 token 数（默认 512） */
  maxLength?: number
  /** ORT 线程数（默认 1：主进程里别抢满核） */
  intraOpNumThreads?: number
  /** 用例注入假 ORT；缺省动态 import('onnxruntime-node') */
  loadOrt?: () => Promise<OrtModuleLike>
}

/**
 * `model.onnx` 的合理下界：真模型 90 MB 量级，git-lfs 指针文件只有 ~130 B。
 * 低于这个数量级一律当「没就绪」。
 */
export const MIN_MODEL_ONNX_BYTES = 1_000_000

/** 模型目录下的关键文件 */
export function modelFiles(modelDir: string): { modelPath: string; vocabPath: string; configPath: string } {
  return {
    modelPath: join(modelDir, 'model.onnx'),
    vocabPath: join(modelDir, 'vocab.txt'),
    configPath: join(modelDir, 'config.json')
  }
}

/**
 * 模型是否就绪（UI 用来区分「未安装模型」与「计算失败」）。
 *
 * `model.onnx` 还要**够大**才认：仓库里这个文件走 git-lfs，没装 lfs 的机器克隆下来是
 * 130 字节的文本指针——只看 `existsSync` 会把它当「就绪」，然后在 ORT 加载时才炸，
 * 报错跟真正的原因对不上（2026-10-25 随模型入库时加）。
 */
export function isModelReady(modelDir: string): boolean {
  const { modelPath, vocabPath } = modelFiles(modelDir)
  try {
    return statSync(modelPath).size >= MIN_MODEL_ONNX_BYTES && existsSync(vocabPath)
  } catch {
    return false
  }
}

/** 从 config.json 读 hidden_size（缺失/坏文件回退 512） */
export function readModelDim(modelDir: string): number {
  const { configPath } = modelFiles(modelDir)
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { hidden_size?: unknown }
    return typeof parsed.hidden_size === 'number' && parsed.hidden_size > 0
      ? parsed.hidden_size
      : EMBEDDING_DIM
  } catch {
    return EMBEDDING_DIM
  }
}

/** 读 vocab.txt（utf8；失败抛 `vocab-missing`） */
export function readVocab(modelDir: string): BertVocab {
  const { vocabPath } = modelFiles(modelDir)
  if (!existsSync(vocabPath)) {
    throw new EmbeddingError('vocab-missing', `缺少 vocab.txt：${modelDir}`)
  }
  return loadVocab(readFileSync(vocabPath, 'utf8'))
}

/**
 * `[CLS]` 池化 + L2 归一化。
 * `data` 是 ORT 的 `last_hidden_state` 展平 Float32（形状 [batch, seq, dim]）。
 */
export function clsPoolAndNormalize(
  data: OrtTensorData,
  dims: readonly number[],
  expectedBatch: number
): Float32Array[] {
  const batch = dims[0]
  const seq = dims[1]
  const dim = dims[2]
  if (dims.length !== 3 || batch !== expectedBatch || seq <= 0 || dim <= 0) {
    throw new EmbeddingError(
      'run-failed',
      `意外的输出形状：[${dims.join(', ')}]（期望 [${expectedBatch}, seq, dim]）`
    )
  }
  const vectors: Float32Array[] = []
  for (let b = 0; b < batch; b += 1) {
    const vector = new Float32Array(dim)
    let sum = 0
    const offset = b * seq * dim // 第 0 位即 [CLS]
    for (let k = 0; k < dim; k += 1) {
      const value = Number(data[offset + k])
      const safe = Number.isFinite(value) ? value : 0
      vector[k] = safe
      sum += safe * safe
    }
    const norm = Math.sqrt(sum)
    if (norm > 0) {
      for (let k = 0; k < dim; k += 1) vector[k] /= norm
    }
    vectors.push(vector)
  }
  return vectors
}

/** 按批把 token id 填成 int64 张量（不足 seq 长度补 PAD，attention mask 对应 0） */
export function buildFeeds(
  ort: OrtModuleLike,
  session: Pick<OrtSessionLike, 'inputNames'>,
  encoded: readonly { inputIds: number[]; attentionMask: number[] }[],
  padId: number
): Record<string, OrtTensorLike> {
  if (encoded.length === 0) return {}
  const batch = encoded.length
  let seq = 0
  for (const item of encoded) seq = Math.max(seq, item.inputIds.length)

  const inputIds = new BigInt64Array(batch * seq)
  const attentionMask = new BigInt64Array(batch * seq)
  for (let b = 0; b < batch; b += 1) {
    const item = encoded[b]
    for (let i = 0; i < seq; i += 1) {
      const index = b * seq + i
      if (i < item.inputIds.length) {
        inputIds[index] = BigInt(item.inputIds[i])
        attentionMask[index] = 1n
      } else {
        inputIds[index] = BigInt(padId)
        attentionMask[index] = 0n
      }
    }
  }

  const feeds: Record<string, OrtTensorLike> = {
    input_ids: new ort.Tensor('int64', inputIds, [batch, seq]),
    attention_mask: new ort.Tensor('int64', attentionMask, [batch, seq])
  }
  if (session.inputNames.includes('token_type_ids')) {
    feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(batch * seq), [batch, seq])
  }
  return feeds
}

/** 从 ORT 输出里挑 `last_hidden_state`（没有就取第一个输出） */
export function pickHiddenState(
  session: Pick<OrtSessionLike, 'outputNames'>,
  outputs: Record<string, OrtTensorLike>
): OrtTensorLike | null {
  if (outputs.last_hidden_state) return outputs.last_hidden_state
  const first = session.outputNames[0]
  return first ? (outputs[first] ?? null) : null
}

/**
 * 创建本地 embedder（懒加载 ORT；模型缺失时抛 `model-missing`，由调用方降级）。
 * 会话常驻：同一进程重复回填复用同一个 session。
 */
export async function createLocalEmbedder(options: LocalEmbedderOptions): Promise<Embedder> {
  const { modelPath } = modelFiles(options.modelDir)
  if (!existsSync(modelPath)) {
    throw new EmbeddingError('model-missing', `缺少 model.onnx：${options.modelDir}`)
  }
  const vocab = readVocab(options.modelDir)
  const dim = readModelDim(options.modelDir)
  const maxLength = Math.max(2, Math.min(options.maxLength ?? BERT_MAX_LENGTH, BERT_MAX_LENGTH))
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 8))

  const ort = options.loadOrt
    ? await options.loadOrt()
    : ((await import('onnxruntime-node')) as unknown as OrtModuleLike)

  let session: OrtSessionLike
  try {
    session = await ort.InferenceSession.create(modelPath, {
      intraOpNumThreads: options.intraOpNumThreads ?? 1,
      graphOptimizationLevel: 'all'
    })
  } catch (error) {
    throw new EmbeddingError(
      'session-failed',
      `无法加载模型会话：${error instanceof Error ? error.message : String(error)}`
    )
  }

  const model = options.modelName ?? EMBEDDING_MODEL_NAME

  return {
    model,
    dim,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      const vectors: Float32Array[] = []
      for (let start = 0; start < texts.length; start += batchSize) {
        const chunk = texts.slice(start, start + batchSize)
        const encoded = chunk.map((text) => encodeText(text, vocab, { maxLength }))
        let hidden: OrtTensorLike | null = null
        try {
          const outputs = await session.run(buildFeeds(ort, session, encoded, vocab.padId))
          hidden = pickHiddenState(session, outputs)
        } catch (error) {
          throw new EmbeddingError(
            'run-failed',
            `推理失败：${error instanceof Error ? error.message : String(error)}`
          )
        }
        if (!hidden) throw new EmbeddingError('run-failed', '模型没有返回 last_hidden_state')
        vectors.push(...clsPoolAndNormalize(hidden.data, hidden.dims, chunk.length))
      }
      return vectors
    }
  }
}
