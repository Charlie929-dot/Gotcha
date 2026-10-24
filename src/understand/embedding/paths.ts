/**
 * 本地向量模型的位置约定（docs/m2-graph-redesign.md §10）
 *
 * 模型是用户本地资产：默认放 `userData/models/bge-small-zh-v1.5/`，
 * 不随安装包分发、不自动下载；`graph.embedding_model_dir` 可覆盖。
 */

import { join } from 'node:path'
import { EMBEDDING_MODEL_NAME } from './types'

/** 模型目录名（与 EMBEDDING_MODEL_NAME 一致，便于换模型时一眼对应） */
export const EMBEDDING_MODEL_DIR_NAME = EMBEDDING_MODEL_NAME

/** 默认模型目录：`<userData>/models/bge-small-zh-v1.5` */
export function defaultEmbeddingModelDir(userDataDir: string): string {
  return join(userDataDir, 'models', EMBEDDING_MODEL_DIR_NAME)
}

/** 设置值优先（去空白）；空串 / 非法值回退默认目录 */
export function resolveEmbeddingModelDir(userDataDir: string, setting: string | null | undefined): string {
  const trimmed = (setting ?? '').trim()
  if (trimmed === '') return defaultEmbeddingModelDir(userDataDir)
  return trimmed
}
