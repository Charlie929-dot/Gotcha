/**
 * 主题向量回填（docs/m2-graph-redesign.md §4.3）
 *
 * - 文本口径：`title + "。" + summary`（summary 为空则只用 title）；
 * - 只读 `nodes`，把归一化向量写进 `node_embeddings`（模型名 + 维度一起记）；
 * - `onlyMissing`（默认）只算还没有该模型向量的主题，供增量回填；
 * - 失败不抛到调用方：返回 `ok:false` + 错误码（日志里只带 code，不带主题正文）。
 */

import type { Db } from '../db'
import { writeThemeVectors, type ThemeVector } from './graph-edges'
import {
  EMBEDDING_MODEL_NAME,
  type Embedder,
  type EmbeddingErrorCode
} from './embedding/types'

export interface ThemeEmbeddingResult {
  ok: boolean
  error?: { code: EmbeddingErrorCode; message: string }
  /** 参与本次回填的主题数 */
  themes: number
  /** 实际写入向量数 */
  embedded: number
  /** 维度与声明不一致而未写入的条数（正常应为 0） */
  skipped: number
  model: string
  dim: number
  ms: number
}

/** 主题文本：标题 + 摘要（摘要为空不加多余标点） */
export function themeEmbeddingText(title: string, summary: string): string {
  const head = title.trim()
  const tail = summary.trim()
  if (head === '') return tail
  if (tail === '') return head
  return `${head}。${tail}`
}

interface ThemeTextRow {
  id: number
  title: string | null
  summary: string | null
}

interface ThemeText {
  id: number
  text: string
}

export interface ListThemeTextsOptions {
  /** 只取没有当前模型向量的主题（默认 false） */
  onlyMissing?: boolean
  model?: string
}

/** 列出待算向量的主题（纯读；用例可断言文本口径） */
export function listThemeTexts(db: Db, options: ListThemeTextsOptions = {}): ThemeText[] {
  const model = options.model ?? EMBEDDING_MODEL_NAME
  const rows = (
    options.onlyMissing
      ? db
          .prepare(
            `SELECT n.id, n.title, n.summary FROM nodes n
             WHERE n.level = 1
               AND NOT EXISTS (
                 SELECT 1 FROM node_embeddings e WHERE e.node_id = n.id AND e.model = ?
               )
             ORDER BY n.id ASC`
          )
          .all(model)
      : db
          .prepare('SELECT id, title, summary FROM nodes WHERE level = 1 ORDER BY id ASC')
          .all()
  ) as ThemeTextRow[]

  const texts: ThemeText[] = []
  for (const row of rows) {
    const text = themeEmbeddingText(row.title ?? '', row.summary ?? '')
    // 空标题 + 空摘要没有语义信号，算出来会是噪声向量，直接跳过
    if (text === '') continue
    texts.push({ id: row.id, text })
  }
  return texts
}

export interface EmbedThemeVectorsOptions {
  /** 写入 updated_at 的时间；用例注入固定值 */
  now?: number
  /** 只算缺向量的主题（默认 true） */
  onlyMissing?: boolean
  /** 每次写库的主题数（默认 64；推理批大小由 embedder 自己决定） */
  writeChunkSize?: number
}

/**
 * 计算并写入主题向量。
 * 推理失败时**已写成功的批次保留**（幂等，下次补算），返回 `ok:false`。
 */
export async function embedThemeVectors(
  db: Db,
  embedder: Embedder,
  options: EmbedThemeVectorsOptions = {}
): Promise<ThemeEmbeddingResult> {
  const started = Date.now()
  const now = options.now ?? started
  const onlyMissing = options.onlyMissing !== false
  const chunkSize = Math.max(1, Math.floor(options.writeChunkSize ?? 64))

  const texts = listThemeTexts(db, { onlyMissing, model: embedder.model })
  const base: ThemeEmbeddingResult = {
    ok: true,
    themes: texts.length,
    embedded: 0,
    skipped: 0,
    model: embedder.model,
    dim: embedder.dim,
    ms: 0
  }
  if (texts.length === 0) {
    base.ms = Date.now() - started
    return base
  }

  try {
    for (let start = 0; start < texts.length; start += chunkSize) {
      const chunk = texts.slice(start, start + chunkSize)
      const vectors = await embedder.embed(chunk.map((item) => item.text))
      if (vectors.length !== chunk.length) {
        throw new Error(`向量条数不一致：期望 ${chunk.length}，实际 ${vectors.length}`)
      }
      const payload: ThemeVector[] = chunk.map((item, index) => ({
        nodeId: item.id,
        vec: vectors[index]
      }))
      const written = writeThemeVectors(db, payload, {
        model: embedder.model,
        dim: embedder.dim,
        now
      })
      base.embedded += written.written
      base.skipped += written.skipped
    }
  } catch (error) {
    const code: EmbeddingErrorCode =
      error && typeof error === 'object' && 'code' in error
        ? ((error as { code: EmbeddingErrorCode }).code ?? 'run-failed')
        : 'run-failed'
    base.ok = false
    base.error = { code, message: error instanceof Error ? error.message : String(error) }
  }

  base.ms = Date.now() - started
  return base
}
