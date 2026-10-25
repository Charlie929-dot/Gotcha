/**
 * 事件向量缓存（docs/m2-graph-redesign.md §5.1 / §5.2）
 *
 * 为什么单独一张表：主题 `title+summary` 向量用于**连线**（`node_embeddings`），
 * 合并判定与时刻/主题质心要的是**成员事件**向量，文本口径和语义都不同，混存会互相污染。
 *
 * - 只算「被主题主归属（owner）时刻引用」的事件：合并质心与次归属都只需要这些；
 * - 幂等：`onlyMissing` 默认只补没有向量的行，中断后下次继续（已写批次保留）；
 * - 文本口径：`window_title。ocr_text`（标题已在正文开头时不重复），压缩空白后截断；
 * - 失败不抛到调用方：返回 `ok:false` + 错误码；日志只带 code，不带正文。
 */

import type { Db } from '../db'
import { decodeVector, encodeVector } from './graph-edges'
import {
  EMBEDDING_MODEL_NAME,
  type Embedder,
  type EmbeddingErrorCode
} from './embedding/types'

/** 送模型的字符上限（bge 的 512 token 截断之前先控字符数，减少无意义分词） */
export const EVENT_TEXT_MAX_CHARS = 600

/** 事件文本：标题 + 。 + OCR（归一空白；标题已在正文开头不重复） */
export function eventEmbeddingText(
  windowTitle: string | null | undefined,
  ocrText: string | null | undefined
): string {
  const head = (windowTitle ?? '').replace(/\s+/g, ' ').trim()
  const tail = (ocrText ?? '').replace(/\s+/g, ' ').trim()
  if (head === '') return capText(tail)
  if (tail === '') return capText(head)
  if (tail.startsWith(head)) return capText(tail)
  return capText(`${head}。${tail}`)
}

function capText(text: string): string {
  return text.length > EVENT_TEXT_MAX_CHARS ? text.slice(0, EVENT_TEXT_MAX_CHARS) : text
}

export interface EventText {
  id: number
  text: string
}

interface EventTextRow {
  id: number
  window_title: string | null
  ocr_text: string | null
}

export interface ListEventTextsOptions {
  onlyMissing?: boolean
  model?: string
  scope?: 'assigned' | 'all'
  /**
   * 只算这些事件（在线路径：新时刻的成员事件，它们还没被任何主题归属引用，
   * `scope='assigned'` 的口径永远覆盖不到）。给了这个就忽略 `scope`。
   */
  eventIds?: readonly number[]
}

/** IN 查询分块：SQLite 变量上限足够高，这里按批切只为查询计划稳定 */
const EVENT_ID_CHUNK = 500

/**
 * 列出待算向量的事件（纯读）。
 * `scope='assigned'`（默认）只取被 owner 归属时刻引用的事件；`scope='all'` 取全部事件；
 * `eventIds` 只取指定事件（在线路径增量，优先于 scope）。
 */
export function listEventTexts(db: Db, options: ListEventTextsOptions = {}): EventText[] {
  const model = options.model ?? EMBEDDING_MODEL_NAME
  const scope = options.scope ?? 'assigned'
  const onlyMissing = options.onlyMissing === true
  const texts: EventText[] = []

  const missingSql = `NOT EXISTS (
      SELECT 1 FROM event_embeddings ee WHERE ee.event_id = e.id AND ee.model = ?
    )`

  if (options.eventIds) {
    const ids = [
      ...new Set(options.eventIds.filter((id) => Number.isInteger(id) && id > 0))
    ].sort((a, b) => a - b)
    if (ids.length === 0) return texts
    const sql = `SELECT e.id, e.window_title, e.ocr_text FROM events e
       WHERE e.id IN (${ids.map(() => '?').join(',')})${onlyMissing ? ` AND ${missingSql}` : ''}
       ORDER BY e.id ASC`
    const seen = new Set<number>()
    for (let start = 0; start < ids.length; start += EVENT_ID_CHUNK) {
      const chunk = ids.slice(start, start + EVENT_ID_CHUNK)
      const rows = (onlyMissing
        ? db.prepare(sql).all(...chunk, model)
        : db.prepare(sql).all(...chunk)) as EventTextRow[]
      for (const row of rows) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        const text = eventEmbeddingText(row.window_title, row.ocr_text)
        if (text === '') continue
        texts.push({ id: row.id, text })
      }
    }
    return texts
  }

  const assignedSql = `
    SELECT e.id, e.window_title, e.ocr_text
    FROM events e
    WHERE e.id IN (
      SELECT DISTINCT CAST(je.value AS INTEGER)
      FROM theme_moments tm
      JOIN moments m ON m.id = tm.moment_id
      JOIN json_each(CASE WHEN json_valid(m.event_ids) THEN m.event_ids ELSE '[]' END) je
      WHERE tm.source IN ('owner', 'manual')
    )`
  const allSql = `SELECT e.id, e.window_title, e.ocr_text FROM events e`

  const sql =
    scope === 'assigned'
      ? `${assignedSql}${onlyMissing ? ` AND ${missingSql}` : ''} ORDER BY e.id ASC`
      : `${allSql}${onlyMissing ? ` WHERE ${missingSql}` : ''} ORDER BY e.id ASC`

  const rows = (onlyMissing ? db.prepare(sql).all(model) : db.prepare(sql).all()) as EventTextRow[]
  for (const row of rows) {
    const text = eventEmbeddingText(row.window_title, row.ocr_text)
    if (text === '') continue
    texts.push({ id: row.id, text })
  }
  return texts
}

/**
 * 还没有当前模型向量的事件数（判断质心是否算得完整；只统计已归属时刻引用、且有文本的事件）。
 * 空文本事件永远不会算向量（算出来是噪声），不计入缺失，否则质心会永远「不完整」。
 */
export function countMissingEventVectors(db: Db, model = EMBEDDING_MODEL_NAME): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
       WHERE e.id IN (
         SELECT DISTINCT CAST(je.value AS INTEGER)
         FROM theme_moments tm
         JOIN moments m ON m.id = tm.moment_id
         JOIN json_each(CASE WHEN json_valid(m.event_ids) THEN m.event_ids ELSE '[]' END) je
         WHERE tm.source IN ('owner', 'manual')
       )
       AND TRIM(COALESCE(e.window_title, '') || COALESCE(e.ocr_text, '')) != ''
       AND NOT EXISTS (SELECT 1 FROM event_embeddings ee WHERE ee.event_id = e.id AND ee.model = ?)`
    )
    .get(model) as { n: number }
  return row.n
}

export interface EventEmbeddingResult {
  ok: boolean
  error?: { code: EmbeddingErrorCode; message: string }
  /** 本次参与计算的事件数 */
  events: number
  /** 实际写入向量数 */
  embedded: number
  /** 维度与声明不一致而未写入的条数（正常应为 0） */
  skipped: number
  model: string
  dim: number
  ms: number
}

export interface EmbedEventVectorsOptions {
  now?: number
  /** 只算缺向量的事件（默认 true） */
  onlyMissing?: boolean
  /** 每次写库的事件数（默认 64；推理批大小由 embedder 自己决定） */
  writeChunkSize?: number
  /** 只算这些事件（在线路径：新时刻的成员事件）；缺省走 `scope='assigned'` */
  eventIds?: readonly number[]
}

/**
 * 计算并写入事件向量。推理失败时已写成功的批次保留（幂等重跑会补），返回 `ok:false`。
 */
export async function embedEventVectors(
  db: Db,
  embedder: Embedder,
  options: EmbedEventVectorsOptions = {}
): Promise<EventEmbeddingResult> {
  const started = Date.now()
  const now = options.now ?? started
  const onlyMissing = options.onlyMissing !== false
  const chunkSize = Math.max(1, Math.floor(options.writeChunkSize ?? 64))

  const texts = listEventTexts(db, {
    onlyMissing,
    model: embedder.model,
    ...(options.eventIds ? { eventIds: options.eventIds } : {})
  })
  const result: EventEmbeddingResult = {
    ok: true,
    events: texts.length,
    embedded: 0,
    skipped: 0,
    model: embedder.model,
    dim: embedder.dim,
    ms: 0
  }
  if (texts.length === 0) {
    result.ms = Date.now() - started
    return result
  }

  try {
    for (let start = 0; start < texts.length; start += chunkSize) {
      const chunk = texts.slice(start, start + chunkSize)
      const vectors = await embedder.embed(chunk.map((item) => item.text))
      if (vectors.length !== chunk.length) {
        throw new Error(`向量条数不一致：期望 ${chunk.length}，实际 ${vectors.length}`)
      }
      const written = writeEventVectors(db, chunk.map((item, index) => ({ eventId: item.id, vec: vectors[index] })), {
        model: embedder.model,
        dim: embedder.dim,
        now
      })
      result.embedded += written.written
      result.skipped += written.skipped
    }
  } catch (error) {
    const code: EmbeddingErrorCode =
      error && typeof error === 'object' && 'code' in error
        ? ((error as { code: EmbeddingErrorCode }).code ?? 'run-failed')
        : 'run-failed'
    result.ok = false
    result.error = { code, message: error instanceof Error ? error.message : String(error) }
  }

  result.ms = Date.now() - started
  return result
}

export interface WriteEventVectorsResult {
  written: number
  skipped: number
}

/** 写入 / 覆盖事件向量（调用方保证已 L2 归一化且维度一致） */
export function writeEventVectors(
  db: Db,
  rows: readonly { eventId: number; vec: Float32Array }[],
  options: { model: string; dim: number; now?: number }
): WriteEventVectorsResult {
  const now = options.now ?? Date.now()
  const dim = Math.floor(options.dim)
  const insert = db.prepare(
    `INSERT INTO event_embeddings (event_id, model, dim, vec, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       vec = excluded.vec,
       updated_at = excluded.updated_at`
  )
  let written = 0
  let skipped = 0
  const run = db.transaction(() => {
    for (const row of rows) {
      if (!Number.isInteger(row.eventId) || row.eventId <= 0 || dim <= 0 || row.vec.length !== dim) {
        skipped += 1
        continue
      }
      insert.run(row.eventId, options.model, dim, encodeVector(row.vec), now)
      written += 1
    }
  })
  run()
  return { written, skipped }
}

export interface ReadEventVectorsResult {
  model: string | null
  vectors: Map<number, Float32Array>
  /** 维度不一致 / BLOB 损坏而跳过的条数 */
  skipped: number
}

/** 读事件向量（`model` 给定时只取该模型；换模型后旧向量不参与质心） */
export function readEventVectors(
  db: Db,
  options: { model?: string } = {}
): ReadEventVectorsResult {
  const rows = (
    options.model
      ? db
          .prepare('SELECT event_id, model, dim, vec FROM event_embeddings WHERE model = ? ORDER BY event_id ASC')
          .all(options.model)
      : db.prepare('SELECT event_id, model, dim, vec FROM event_embeddings ORDER BY event_id ASC').all()
  ) as Array<{ event_id: number; model: string; dim: number; vec: Buffer }>

  const vectors = new Map<number, Float32Array>()
  let model: string | null = null
  let skipped = 0
  for (const row of rows) {
    if (model === null) model = row.model
    const vec = decodeVector(row.vec)
    if (row.dim !== vec.length) {
      skipped += 1
      continue
    }
    vectors.set(row.event_id, vec)
  }
  return { model, vectors, skipped }
}

/**
 * 只读这些事件的向量（在线路径重算单个主题质心用：不把整表 BLOB 拉进内存）。
 * `model` 缺省不限模型；维度不一致 / BLOB 损坏的条数记在 `skipped`。
 */
export function readEventVectorsByIds(
  db: Db,
  eventIds: readonly number[],
  options: { model?: string } = {}
): ReadEventVectorsResult {
  const ids = [...new Set(eventIds.filter((id) => Number.isInteger(id) && id > 0))].sort(
    (a, b) => a - b
  )
  const vectors = new Map<number, Float32Array>()
  if (ids.length === 0) return { model: options.model ?? null, vectors, skipped: 0 }

  let model: string | null = options.model ?? null
  let skipped = 0
  for (let start = 0; start < ids.length; start += EVENT_ID_CHUNK) {
    const chunk = ids.slice(start, start + EVENT_ID_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = (
      options.model
        ? db
            .prepare(
              `SELECT event_id, model, dim, vec FROM event_embeddings
                WHERE model = ? AND event_id IN (${placeholders}) ORDER BY event_id ASC`
            )
            .all(options.model, ...chunk)
        : db
            .prepare(
              `SELECT event_id, model, dim, vec FROM event_embeddings
                WHERE event_id IN (${placeholders}) ORDER BY event_id ASC`
            )
            .all(...chunk)
    ) as Array<{ event_id: number; model: string; dim: number; vec: Buffer }>
    for (const row of rows) {
      if (model === null) model = row.model
      const vec = decodeVector(row.vec)
      if (row.dim !== vec.length) {
        skipped += 1
        continue
      }
      vectors.set(row.event_id, vec)
    }
  }
  return { model, vectors, skipped }
}
