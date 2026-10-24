/**
 * 本地向量运行时（docs/m2-graph-redesign.md §10）
 *
 * 只定契约：主题向量回填 / 边构建 / 后续在线 assigner 都吃 `Embedder`，
 * 用例注入假实现即可离线跑（零模型、零网络）。
 */

/** 模型标识：写进 `node_embeddings.model`，换模型时旧向量不参与连线 */
export const EMBEDDING_MODEL_NAME = 'bge-small-zh-v1.5'

/** bge-small-zh-v1.5 的 hidden_size（config.json；运行时可覆盖） */
export const EMBEDDING_DIM = 512

export interface Embedder {
  readonly model: string
  readonly dim: number
  /** 按输入顺序返回**已 L2 归一化**的向量 */
  embed(texts: readonly string[]): Promise<Float32Array[]>
}

export type EmbeddingErrorCode =
  | 'model-missing'
  | 'vocab-missing'
  | 'session-failed'
  | 'run-failed'
  | 'empty-input'

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode

  constructor(code: EmbeddingErrorCode, message: string) {
    super(message)
    this.name = 'EmbeddingError'
    this.code = code
  }
}
