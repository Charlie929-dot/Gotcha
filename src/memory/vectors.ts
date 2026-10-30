/**
 * 个人记忆 · 向量索引（`mem_vectors`，schema v10）
 *
 * 设计见 `docs/agent/llm-call.md` §4（D57）：日记 / 对话 / 观测的正文用**本地** bge 算向量，
 * 零出网；每轮 act 用「当前问题」检索 top 6–8 条「想到了什么」注入下一次调用。
 *
 * 这一层只做索引的存取与增量判断，**不自己建 embedder**（由组合根注入，测试给假实现）：
 *
 * - 增量：`text_hash` 与 `mem_items.text` 的指纹一致就跳过，不重算；
 * - 孤儿：条目删了 / 正文改了换 uid，旧向量按「`item_id` 不在 `mem_items` 里」清掉；
 * - 换模型：按 `model` 各存一份（主键含 model），查询只取当前模型。
 *
 * 排序（余弦 / 时间衰减 / 去重 / MMR）在 `recall.ts`；这里只负责把库里的行喂给它。
 */

import type { Db } from '../db'
import type { Embedder } from '../understand/embedding/types'
import type { RecallCandidate } from './recall'
import { textHash } from './recall'
import { dayStartTs } from './vault'

/** 送进 embedder 的正文上限：日记一条通常一两百字，遇到超长条目也别让一次推理撑爆 */
const EMBED_TEXT_MAX_CHARS = 2_000
const DEFAULT_LIMIT = 200
const DEFAULT_BATCH = 16

/** 向量来源（`mem_vectors.item_type`）；本轮只索引 diary，其余随对话 / 成长层落地 */
export type MemoryVectorItemType = 'diary' | 'conversation' | 'observation' | 'self'

/** `Float32Array` → 可入库的小端字节（复制一份，避免与调用方共享 buffer） */
export function packVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}

/** 字节 → `Float32Array`；长度与当前模型维度对不上（坏行 / 换模型）返回 null，调用方跳过 */
export function unpackVector(blob: Buffer | Uint8Array | null, dim: number): Float32Array | null {
  if (!blob) return null
  if (dim <= 0 || blob.byteLength !== dim * 4) return null
  const copy = Buffer.from(blob)
  return new Float32Array(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength))
}

export interface VectorIndexOptions {
  /** 一次调用最多索引多少条（剩下的下一次再跑，避免长时间占 CPU） */
  limit?: number
  /** 每次送 embedder 多少条 */
  batchSize?: number
  now?: number
}

export interface VectorIndexResult {
  model: string
  /** 扫过的条目数 */
  scanned: number
  /** 这次真算了向量的条数 */
  embedded: number
  /** 指纹没变、跳过的条数 */
  unchanged: number
  /** 空正文 / 维度不符算不出来、跳过的条数 */
  skipped: number
  /** 还没索引的条数（= 下一次要处理的量） */
  remaining: number
}

interface PendingRow {
  uid: string
  dayKey: string
  text: string
  storedHash: string | null
  storedVector: Buffer | null
}

function pendingRows(db: Db, model: string): PendingRow[] {
  return db
    .prepare(
      `SELECT i.uid AS uid, i.day_key AS dayKey, i.text AS text,
              v.text_hash AS storedHash, v.vector AS storedVector
         FROM mem_items i
         LEFT JOIN mem_vectors v
           ON v.item_type = 'diary' AND v.item_id = i.uid AND v.model = ?
        ORDER BY i.ts IS NULL, i.ts DESC, i.id DESC`
    )
    .all(model) as PendingRow[]
}

/** 还差多少条没索引（诊断 / 进度用；全表扫一遍，几千条是毫秒级） */
export function countPendingVectors(db: Db, model: string): number {
  return pendingRows(db, model).filter(
    (row) => row.storedVector === null || row.storedHash !== textHash(row.text)
  ).length
}

/**
 * 增量索引日记向量：逐批算、逐批写，返回这次算了多少、还剩多少。
 *
 * 不抛「模型缺失」：embedder 由调用方拿（缺模型时组合根直接不调这里）。
 * 单条算失败（bad input）只计 skipped，不中断整批 —— 一条坏数据不该让整晚的索引停摆。
 */
export async function indexDiaryVectors(
  db: Db,
  embedder: Embedder,
  options: VectorIndexOptions = {}
): Promise<VectorIndexResult> {
  const limit = options.limit ?? DEFAULT_LIMIT
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH)
  const now = options.now ?? Date.now()
  const model = embedder.model
  const rows = pendingRows(db, model)
  const pending = rows.filter(
    (row) => row.storedVector === null || row.storedHash !== textHash(row.text)
  )
  const batchRows = pending.slice(0, Math.max(0, limit))

  const upsert = db.prepare(
    `INSERT INTO mem_vectors (item_type, item_id, model, vector, text_hash, updated_at)
     VALUES ('diary', @uid, @model, @vector, @hash, @now)
     ON CONFLICT(item_type, item_id, model) DO UPDATE SET
       vector = excluded.vector,
       text_hash = excluded.text_hash,
       updated_at = excluded.updated_at`
  )

  let embedded = 0
  let skipped = 0
  for (let offset = 0; offset < batchRows.length; offset += batchSize) {
    const chunk = batchRows.slice(offset, offset + batchSize).filter((row) => row.text.trim() !== '')
    skipped += Math.min(batchSize, batchRows.length - offset) - chunk.length
    if (chunk.length === 0) continue
    const vectors = await embedder.embed(
      chunk.map((row) => row.text.slice(0, EMBED_TEXT_MAX_CHARS))
    )
    if (vectors.length !== chunk.length) {
      // 契约是「按输入顺序返回同数量向量」；对不上就当这一批失败，不写半批
      skipped += chunk.length
      continue
    }
    const write = db.transaction(() => {
      for (let index = 0; index < chunk.length; index += 1) {
        const row = chunk[index]
        const vec = vectors[index]
        if (!vec || vec.length !== embedder.dim) {
          skipped += 1
          continue
        }
        upsert.run({
          uid: row.uid,
          model,
          vector: packVector(vec),
          hash: textHash(row.text),
          now
        })
        embedded += 1
      }
    })
    write()
  }

  return {
    model,
    scanned: rows.length,
    embedded,
    unchanged: rows.length - pending.length,
    skipped,
    remaining: pending.length - embedded - skipped
  }
}

/** 孤儿清理：条目已不在 `mem_items` 里的日记向量整行删掉（返回删了几条） */
export function pruneOrphanVectors(db: Db): number {
  const result = db
    .prepare(
      `DELETE FROM mem_vectors
        WHERE item_type = 'diary'
          AND item_id NOT IN (SELECT uid FROM mem_items)`
    )
    .run()
  return result.changes
}

export interface DiaryVectorRow {
  uid: string
  dayKey: string
  ts: number | null
  text: string
  vec: Float32Array
}

/** 读出某模型的日记向量（坏长度跳过）；给回想 / 诊断用 */
export function listDiaryVectors(db: Db, model: string, dim: number): DiaryVectorRow[] {
  const rows = db
    .prepare(
      `SELECT v.item_id AS uid, i.day_key AS dayKey, i.ts AS ts, i.text AS text, v.vector AS vector
         FROM mem_vectors v
         JOIN mem_items i ON i.uid = v.item_id
        WHERE v.item_type = 'diary' AND v.model = ?`
    )
    .all(model) as Array<{
    uid: string
    dayKey: string
    ts: number | null
    text: string
    vector: Buffer
  }>
  const result: DiaryVectorRow[] = []
  for (const row of rows) {
    const vec = unpackVector(row.vector, dim)
    if (vec === null) continue
    result.push({ uid: row.uid, dayKey: row.dayKey, ts: row.ts, text: row.text, vec })
  }
  return result
}

/** 日记向量 → 回想候选（`recall.selectRecalls` 的输入）；没有时间的条目用当天 00:00 兜底 */
export function listDiaryRecallCandidates(db: Db, model: string, dim: number): RecallCandidate[] {
  return listDiaryVectors(db, model, dim).map((row) => ({
    id: `diary:${row.uid}`,
    vec: row.vec,
    ts: row.ts ?? dayStartTs(row.dayKey),
    payload: { uid: row.uid, dayKey: row.dayKey, text: row.text }
  }))
}

/** 索引状态（设置抽屉 / 日志用） */
export function memoryVectorStats(
  db: Db,
  model: string
): { items: number; vectors: number; pending: number; models: string[] } {
  const items = (db.prepare('SELECT COUNT(*) AS count FROM mem_items').get() as { count: number }).count
  const vectors = (
    db.prepare("SELECT COUNT(*) AS count FROM mem_vectors WHERE item_type = 'diary'").get() as {
      count: number
    }
  ).count
  const models = (
    db.prepare('SELECT DISTINCT model FROM mem_vectors ORDER BY model').all() as Array<{ model: string }>
  ).map((row) => row.model)
  return { items, vectors, pending: countPendingVectors(db, model), models }
}
