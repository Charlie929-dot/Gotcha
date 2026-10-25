/**
 * 主题向量回填（docs/m2-graph-redesign.md §4.3；增量口径见 §5.1 / P2 · S3）
 *
 * - 文本口径：`title + "。" + summary`（summary 为空则只用 title）；
 * - 只读 `nodes`，把归一化向量写进 `node_embeddings`（模型名 + 维度 + **文本指纹**一起记）；
 * - 增量：`planThemeTextVectors` 按指纹挑出「缺向量 / 换了模型 / 标题或摘要变了 / 老行没有指纹」
 *   的主题，其余直接复用——归纳批量路径会原地改摘要，只看 `onlyMissing` 会永远留着过期向量；
 * - 失败不抛到调用方：返回 `ok:false` + 错误码（日志里只带 code，不带主题正文）。
 */

import type { Db } from '../db'
import { writeThemeVectors, type ThemeVector } from './graph-edges'
import { stableFingerprint } from './vector-fingerprint'
import {
  EMBEDDING_MODEL_NAME,
  type Embedder,
  type EmbeddingErrorCode
} from './embedding/types'

export interface ThemeEmbeddingResult {
  ok: boolean
  error?: { code: EmbeddingErrorCode; message: string }
  /** 参与本次回填的主题数（＝需要重算的条数） */
  themes: number
  /** 实际写入向量数 */
  embedded: number
  /** 维度与声明不一致而未写入的条数（正常应为 0） */
  skipped: number
  /** 文本指纹一致、本次没有推理的条数 */
  reused: number
  /** 标题与摘要都为空、永远不算向量的条数 */
  skippedEmpty: number
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
  vec_model: string | null
  text_hash: string | null
}

interface ThemeText {
  id: number
  text: string
}

export interface StaleThemeText extends ThemeText {
  /** 生成这条文本的指纹，写库时一起落 `node_embeddings.text_hash` */
  fingerprint: string
}

export interface ThemeTextPlan {
  /** 全部有文本的存活主题（升序）——`onlyMissing: false` 的口径 */
  all: ThemeText[]
  /** 需要（重新）推理的主题（升序） */
  stale: StaleThemeText[]
  /** 文本指纹与库里一致、可以直接复用的主题数 */
  reused: number
  /** 标题与摘要都为空、永远不算向量的主题数 */
  skippedEmpty: number
  /** 参与统计的存活主题总数（`all.length + skippedEmpty`） */
  themes: number
}

export interface PlanThemeTextOptions {
  model?: string
  /** 强制全部重算（不看指纹）；调试 / 换模型后手动重算用 */
  force?: boolean
}

/**
 * 挑出「需要重算标题向量」的主题（纯读，确定性）。
 *
 * 判据：库里没有这一行、或模型不是当前模型、或 `text_hash` 与当前文本指纹不一致
 * （含老库的 NULL 行——第一次增量维护各自重算一次后自愈）。
 */
export function planThemeTextVectors(
  db: Db,
  options: PlanThemeTextOptions = {}
): ThemeTextPlan {
  const model = options.model ?? EMBEDDING_MODEL_NAME
  const force = options.force === true
  const rows = db
    .prepare(
      `SELECT n.id AS id, n.title AS title, n.summary AS summary,
              e.model AS vec_model, e.text_hash AS text_hash
         FROM nodes n
         LEFT JOIN node_embeddings e ON e.node_id = n.id
        WHERE n.level = 1 AND n.merged_into IS NULL
        ORDER BY n.id ASC`
    )
    .all() as ThemeTextRow[]

  const all: ThemeText[] = []
  const stale: StaleThemeText[] = []
  let reused = 0
  let skippedEmpty = 0
  for (const row of rows) {
    const text = themeEmbeddingText(row.title ?? '', row.summary ?? '')
    // 空标题 + 空摘要没有语义信号，算出来会是噪声向量，直接跳过（也不计入 reused）
    if (text === '') {
      skippedEmpty += 1
      continue
    }
    const fingerprint = stableFingerprint(text)
    all.push({ id: row.id, text })
    if (!force && row.vec_model === model && row.text_hash === fingerprint) {
      reused += 1
      continue
    }
    stale.push({ id: row.id, text, fingerprint })
  }

  return { all, stale, reused, skippedEmpty, themes: all.length + skippedEmpty }
}

export interface ListThemeTextsOptions {
  /** 只取要（重新）算的主题（指纹不一致 / 缺向量 / 老行没有指纹） */
  onlyMissing?: boolean
  model?: string
}

/**
 * 列出待算向量的主题（纯读；用例可断言文本口径）。
 * `onlyMissing` 走的是**指纹**口径（见 `planThemeTextVectors`），不是「有没有行」。
 */
export function listThemeTexts(db: Db, options: ListThemeTextsOptions = {}): ThemeText[] {
  const plan = planThemeTextVectors(db, { model: options.model ?? EMBEDDING_MODEL_NAME })
  return (options.onlyMissing ? plan.stale : plan.all).map((item) => ({
    id: item.id,
    text: item.text
  }))
}

export interface EmbedThemeVectorsOptions {
  /** 写入 updated_at 的时间；用例注入固定值 */
  now?: number
  /** 只算「指纹变了 / 缺向量」的主题（默认 true；false＝强制全部重算） */
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

  const plan = planThemeTextVectors(db, {
    model: embedder.model,
    force: !onlyMissing
  })
  const texts = plan.stale
  const base: ThemeEmbeddingResult = {
    ok: true,
    themes: texts.length,
    embedded: 0,
    skipped: 0,
    reused: plan.reused,
    skippedEmpty: plan.skippedEmpty,
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
        vec: vectors[index],
        textHash: item.fingerprint
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
