/**
 * 信息链 · 派生层存储（契约 v0.8 / D45）
 *
 * 派生层（标签 / 双链 / 向量 / 进度）与证据层不同：**可随时全删重建**，所以这里允许
 * DELETE（证据层只 INSERT）。所有查询/写入都不碰证据表，唯一读证据层的地方是
 * `listPendingDeriveSegments` 的 `MAX(chain_content.id)`——只取水位，不读正文。
 *
 * 「要不要重算」用 `content_max_id` 水位判断：内容又读回来一条就比它大；比完再算指纹，
 * 指纹没变就只推水位、不重抽（省 token）。
 */

import type { ChainContentRow, ChainDeriveRow, ChainVectorRow } from '../schema'
import { listContents, type ChainDb } from '../store'

/* ------------------------------------------------------------------ */
/* 向量                                                                 */
/* ------------------------------------------------------------------ */

/** `Float32Array` → 可入库的小端字节（复制一份，避免与调用方共享 buffer） */
export function packVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}

/** 字节 → `Float32Array`；长度对不上（坏行 / 换模型）返回 null，由调用方重建 */
export function unpackVector(blob: Buffer | Uint8Array | null, dim: number): Float32Array | null {
  if (!blob) return null
  if (blob.byteLength !== dim * 4) return null
  const copy = Buffer.from(blob)
  return new Float32Array(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength))
}

export interface SegmentVector {
  model: string
  dim: number
  vec: Float32Array
  textHash: string
  contentMaxId: number
}

export function getSegmentVector(db: ChainDb, segmentId: number): SegmentVector | null {
  const row = db.prepare('SELECT * FROM chain_vector WHERE segment_id = ?').get(segmentId) as
    | ChainVectorRow
    | undefined
  if (!row) return null
  const vec = unpackVector(row.vec, row.dim)
  if (!vec) return null
  return {
    model: row.model,
    dim: row.dim,
    vec,
    textHash: row.text_hash,
    contentMaxId: row.content_max_id
  }
}

export function putSegmentVector(
  db: ChainDb,
  input: { segmentId: number; model: string; vec: Float32Array; textHash: string; contentMaxId: number }
): void {
  if (input.vec.length === 0) throw new Error('派生向量不能为空')
  db.prepare(
    `INSERT INTO chain_vector (segment_id, model, dim, vec, text_hash, content_max_id)
     VALUES (@segmentId, @model, @dim, @vec, @textHash, @contentMaxId)
     ON CONFLICT(segment_id) DO UPDATE SET
       model = excluded.model, dim = excluded.dim, vec = excluded.vec,
       text_hash = excluded.text_hash, content_max_id = excluded.content_max_id`
  ).run({
    segmentId: input.segmentId,
    model: input.model,
    dim: input.vec.length,
    vec: packVector(input.vec),
    textHash: input.textHash,
    contentMaxId: input.contentMaxId
  })
}

export function deleteSegmentVector(db: ChainDb, segmentId: number): void {
  db.prepare('DELETE FROM chain_vector WHERE segment_id = ?').run(segmentId)
}

/* ------------------------------------------------------------------ */
/* 抽取进度（链上「这一段这个指纹已经抽过」）                            */
/* ------------------------------------------------------------------ */

export function getDeriveMarker(db: ChainDb, segmentId: number): ChainDeriveRow | null {
  const row = db.prepare('SELECT * FROM chain_derive WHERE segment_id = ?').get(segmentId) as
    | ChainDeriveRow
    | undefined
  return row ?? null
}

export function putDeriveMarker(
  db: ChainDb,
  input: { segmentId: number; textHash: string; contentMaxId: number; derivedAt: number }
): void {
  db.prepare(
    `INSERT INTO chain_derive (segment_id, text_hash, content_max_id, derived_at)
     VALUES (@segmentId, @textHash, @contentMaxId, @derivedAt)
     ON CONFLICT(segment_id) DO UPDATE SET
       text_hash = excluded.text_hash, content_max_id = excluded.content_max_id,
       derived_at = excluded.derived_at`
  ).run(input)
}

export function deleteDeriveMarker(db: ChainDb, segmentId: number): void {
  db.prepare('DELETE FROM chain_derive WHERE segment_id = ?').run(segmentId)
}

/* ------------------------------------------------------------------ */
/* 待派生队列                                                           */
/* ------------------------------------------------------------------ */

export interface PendingSegment {
  segmentId: number
  maxContentId: number
  vectorTextHash: string | null
  vectorContentMaxId: number | null
  deriveTextHash: string | null
  deriveContentMaxId: number | null
}

/**
 * 已收口、有内容、且「向量或抽取落后于内容水位」的段，最近优先。
 *
 * `includeExtract=false`（未确认出网 / 没有客户端）时只列向量待办——本地向量零出网，
 * 不需要确认门；抽取则等授权后再补。
 */
export function listPendingDeriveSegments(
  db: ChainDb,
  options: { includeExtract: boolean; limit?: number } = { includeExtract: false }
): PendingSegment[] {
  const limit = Math.max(1, Math.floor(options.limit ?? 200))
  const extractCondition = options.includeExtract
    ? 'OR d.segment_id IS NULL OR COALESCE(d.content_max_id, 0) < m.max_id'
    : ''
  const sql = `
    SELECT s.id AS segmentId,
           m.max_id AS maxContentId,
           v.text_hash AS vectorTextHash,
           v.content_max_id AS vectorContentMaxId,
           d.text_hash AS deriveTextHash,
           d.content_max_id AS deriveContentMaxId
      FROM chain_segment s
      JOIN (SELECT segment_id, MAX(id) AS max_id FROM chain_content GROUP BY segment_id) m
        ON m.segment_id = s.id
      LEFT JOIN chain_vector v ON v.segment_id = s.id
      LEFT JOIN chain_derive d ON d.segment_id = s.id
     WHERE s.closed = 1
       AND (
         v.segment_id IS NULL OR COALESCE(v.content_max_id, 0) < m.max_id
         ${extractCondition}
       )
     ORDER BY s.id DESC
     LIMIT @limit`
  return db.prepare(sql).all({ limit }) as PendingSegment[]
}

/* ------------------------------------------------------------------ */
/* 标签                                                                 */
/* ------------------------------------------------------------------ */

/** 已有标签名（去重；合并分带的候选池） */
export function listTagNames(db: ChainDb): string[] {
  const rows = db.prepare('SELECT name FROM chain_tag GROUP BY name ORDER BY name').all() as Array<{
    name: string
  }>
  return rows.map((row) => row.name)
}

/** 用一批标签整段替换（重抽时不会留下上一版的名字） */
export function replaceSegmentTags(
  db: ChainDb,
  segmentId: number,
  tags: readonly { name: string; source: string }[]
): void {
  const insert = db.prepare('INSERT INTO chain_tag (segment_id, name, source) VALUES (?, ?, ?)')
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM chain_tag WHERE segment_id = ?').run(segmentId)
    const seen = new Set<string>()
    for (const tag of tags) {
      const name = tag.name.trim()
      if (name === '') throw new Error('标签名不能为空')
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      insert.run(segmentId, name, tag.source)
    }
  })
  transaction()
}

export interface SegmentTag {
  name: string
  source: string
}

export function listSegmentTags(db: ChainDb, segmentId: number): SegmentTag[] {
  return db
    .prepare('SELECT name, source FROM chain_tag WHERE segment_id = ? ORDER BY id')
    .all(segmentId) as SegmentTag[]
}

/* ------------------------------------------------------------------ */
/* 双链                                                                 */
/* ------------------------------------------------------------------ */

export interface LinkRow {
  id: number
  name: string
  aliases: string[]
}

function parseAliases(raw: string | null): string[] {
  if (raw === null || raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  } catch {
    // 坏别名只是少几个匹配入口，不阻塞派生
    return []
  }
}

export function listLinks(db: ChainDb): LinkRow[] {
  const rows = db.prepare('SELECT id, name, aliases FROM chain_link ORDER BY id').all() as Array<{
    id: number
    name: string
    aliases: string | null
  }>
  return rows.map((row) => ({ id: row.id, name: row.name, aliases: parseAliases(row.aliases) }))
}

/** 新建双链单元（同名唯一，已存在就返回原 id） */
export function insertLink(db: ChainDb, name: string): number {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('双链名字不能为空')
  const existing = db.prepare('SELECT id FROM chain_link WHERE name = ?').get(trimmed) as
    | { id: number }
    | undefined
  if (existing) return existing.id
  const result = db.prepare('INSERT INTO chain_link (name) VALUES (?)').run(trimmed)
  return Number(result.lastInsertRowid)
}

/** 覆盖别名列表（去重、去空、保留顺序） */
export function setLinkAliases(db: ChainDb, linkId: number, aliases: readonly string[]): void {
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const alias of aliases) {
    const name = alias.trim()
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push(name)
  }
  db.prepare('UPDATE chain_link SET aliases = ? WHERE id = ?').run(
    cleaned.length === 0 ? null : JSON.stringify(cleaned),
    linkId
  )
}

/** 用一批 (link, weight) 整段替换该段的双链关系 */
export function replaceSegmentLinks(
  db: ChainDb,
  segmentId: number,
  links: readonly { linkId: number; weight: number }[]
): void {
  const insert = db.prepare(
    'INSERT INTO chain_link_segment (link_id, segment_id, weight) VALUES (?, ?, ?)'
  )
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM chain_link_segment WHERE segment_id = ?').run(segmentId)
    const seen = new Set<number>()
    for (const link of links) {
      if (!Number.isInteger(link.linkId) || link.linkId <= 0) throw new Error('双链 id 不合法')
      if (!Number.isFinite(link.weight) || link.weight < 0 || link.weight > 1) {
        throw new Error(`双链权重不合法：${link.weight}`)
      }
      if (seen.has(link.linkId)) continue
      seen.add(link.linkId)
      insert.run(link.linkId, segmentId, link.weight)
    }
  })
  transaction()
}

export interface SegmentLink {
  linkId: number
  name: string
  weight: number
}

export function listSegmentLinks(db: ChainDb, segmentId: number): SegmentLink[] {
  return db
    .prepare(
      `SELECT l.id AS linkId, l.name AS name, ls.weight AS weight
         FROM chain_link_segment ls JOIN chain_link l ON l.id = ls.link_id
        WHERE ls.segment_id = ? ORDER BY l.id`
    )
    .all(segmentId) as SegmentLink[]
}

/** 该段的全部内容（按写入顺序；只给派生层用） */
export function listSegmentContents(db: ChainDb, segmentId: number): ChainContentRow[] {
  return listContents(db, segmentId)
}
