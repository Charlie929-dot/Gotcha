/**
 * 信息链 · 检索入口（契约 §6 的「可检索回溯」）
 *
 * 这一段的目标是：**给一句话 / 一段时间 / 一个标签或双链名，找回那一刻的段，
 * 并能顺着段反查到事件、截图与原文**。它是只读层：
 *
 * - 不写任何表（含派生层），不改水位、不叫醒派生；
 * - 派生层缺失（没有向量 / 没抽过标签）不影响证据回查——检索只是入口，证据在证据层；
 * - 结果里每条命中都带 `segment` 行与命中内容 id，调用方拿 `getSegmentDetail()` 就能
 *   把「为什么命中」落到事件 / 截图 / 原文（契约 §6 的反查方向）。
 *
 * 三条检索路：
 *
 * 1. **正文关键词**（`chain_content`）：SQL 侧用 `normalizeOcrSql` 去掉空白再 `LIKE`。
 *    为什么必须去空白：WinRT OCR 的中文 98.9% 是「记 忆 球」这种逐字空格形态（gotchas），
 *    不去空白连「记忆球」都搜不到；索引侧与查询侧用**同一个**去空白口径（老 `events_fts`
 *    同款做法）。**本轮不建 FTS 索引**：`chain_content` 单条可达 2 万字，trigram 索引按
 *    老库实测约 4× 文本体积，信息链还在万段以下时先全扫（见契约 §6「已知边界」）；
 *    以后要加索引只换这一条 SQL，API 不用动。
 * 2. **段向量**（`chain_vector`）：与查询向量做余弦，纯本地、零出网。向量行是可重建的，
 *    维度对不上（换了模型）或字节坏掉的行**不参与比较**（计入 `stats.skippedVectors`），
 *    不会因此把检索打成报错——但统计数会如实给出，不静默。
 * 3. **过滤**：时间 / 日期 / 应用 / 标签名 / 双链名。标签与双链都按 `nameKey` 归一后
 *    同名匹配（大小写、空白、名字两侧标点不影响；`记忆系统设计` 与 `记忆系统 设计` 同一条）。
 *    双链名可以用**正式名或别名**（`chain_link.aliases`）。
 *
 * 关键词与向量都有结果时用 **RRF（reciprocal rank fusion，`k = 60`）** 融合：
 * `score = Σ 1 / (k + rank)`。选 RRF 而不是「加权平均」的理由：余弦（0–1）与
 * 「命中条数」不是一个量纲，任何权重都得按语料标定；RRF 只看名次，不用调参，
 * 两边都命中的段天然排在只命中一边的前面。名次口径：向量按余弦降序，关键词按
 * （命中条数、最近命中时刻）降序。
 *
 * 同分时按段的开始时间倒序（新的在前）。
 */

import { normalizeOcrSql } from '../db/schema'
import { cosineSimilarity, nameKey } from './derive/names'
import { listLinks, listTagNames, unpackVector } from './derive/store'
import type { ChainSegmentRow } from './schema'
import type { ChainDb } from './store'

/** RRF 常数：Cormack 等给出的常用值，不按语料调（改它等于改排序口径，要重新验收） */
export const RRF_K = 60

export const DEFAULT_SEARCH_LIMIT = 20
/** 单次最多返回多少条（再多也不适合直接看，分页留到以后有 UI 再说） */
export const MAX_SEARCH_LIMIT = 200

/** 命中摘要：关键词两侧各留多少字符 */
export const SNIPPET_RADIUS = 40

/**
 * 关键词扫描上限系数：先按时间倒序取 `limit × 该系数`（至少 200）条命中行，
 * 再按段聚合排名。语料大时它决定「一次查询最多扫多少行」——宁可少看几条老命中，
 * 也不让一个高频词把主进程扫卡（真机库里 `的` 这种词能命中每一段）。
 */
export const KEYWORD_SCAN_FACTOR = 20

/** 补摘要时一条 SQL 里最多绑多少个内容 id（SQLite 默认变量上限 999，留余量） */
const SNIPPET_FETCH_CHUNK = 200

export interface ChainSearchFilter {
  /** 段与 [from, to] 有交集（`from` / `to` 是毫秒时间戳） */
  from?: number
  to?: number
  /** 本地日期 `yyyy-mm-dd`（按段的 `start_ts` 归日） */
  dayKey?: string
  /** 应用名（`chain_segment.app`，精确匹配） */
  app?: string
  /** 标签名（归一后同名匹配） */
  tag?: string
  /** 双链名（正式名或别名，归一后同名匹配） */
  link?: string
  /** 默认只看已收口的段 */
  includeOpen?: boolean
}

export interface ChainSearchQuery extends ChainSearchFilter {
  /** 正文关键词（去空白后子串匹配；`%` `_` 按字面） */
  text?: string
  /** 查询向量（不用预先 L2 归一化，余弦自己算范数；维度要与库里的向量对得上） */
  vector?: Float32Array
  /** 余弦下限，默认 0（只看排序，不做阈值） */
  minSimilarity?: number
  /** 返回条数上限，默认 20、最大 200 */
  limit?: number
}

export interface ChainHitCounts {
  events: number
  shots: number
  contents: number
}

/** 一条命中：段 + 为什么命中 + 命中的内容 id（证据入口） */
export interface ChainHit {
  segment: ChainSegmentRow
  /** 融合分（RRF）；只用一种检索时为该路名次的倒数，没有检索路（纯过滤）为 0 */
  score: number
  /** 与查询向量的余弦（没有向量查询 / 该段没有可用向量时为 null） */
  similarity: number | null
  /** 关键词命中的内容条数（同一段里命中几条） */
  matches: number
  /** 命中的内容 id（最多 3 条，按内容时间倒序）——拿它去 `getSegmentDetail()` 核验原文 */
  contentIds: number[]
  /** 命中位置附近的正文摘要（关键词检索才有） */
  snippet: string | null
  tags: string[]
  links: string[]
  counts: ChainHitCounts
}

export interface ChainSearchStats {
  /** hybrid = 关键词 + 向量融合；vector / keyword = 只有一路；filter = 纯过滤 */
  mode: 'hybrid' | 'vector' | 'keyword' | 'filter'
  /** 参与余弦比较的向量行数（维度对得上的行；不含被跳过的） */
  vectors: number
  /** 因换模型（维度不同）或字节损坏被跳过的向量行数 */
  skippedVectors: number
  /** 关键词扫描读到的命中内容行数（聚合前） */
  keywordRows: number
}

export interface ChainSearchResult {
  hits: ChainHit[]
  stats: ChainSearchStats
}

/* ------------------------------------------------------------------ */
/* 归一与摘要                                                          */
/* ------------------------------------------------------------------ */

/**
 * 与 SQL 侧 `normalizeOcrSql` **同口径**的去空白（空格 / Tab / 换行 / 回车 /
 * 全角空格 / NBSP）。中文逐字空格与英文词间空格都去掉，两边一致才搜得到。
 */
export function despaceSearchText(text: string): string {
  return text.replace(/[ \t\n\r\u3000\u00a0]/g, '')
}

/** LIKE 里的 `%` / `_` / `\` 按字面匹配 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** 原文逐字符压成「去空白 + 小写」的串，并记下每个字符在原串里的下标 */
function packWithMap(text: string): { packed: string; at: number[] } {
  let packed = ''
  const at: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (' \t\n\r\u3000\u00a0'.includes(char)) continue
    packed += char.toLowerCase()
    at.push(index)
  }
  return { packed, at }
}

/**
 * 命中摘要：关键词两侧各 `radius` 个字符，空白折叠。
 *
 * 先按原文找（大小写不敏感）；找不到就把两边都去空白再找，并把命中位置**映射回
 * 原文**（OCR 的「记 忆 球」形态在原文里搜不到「记忆球」，但摘要要取带空格的原文）。
 * 命中不到返回 null。
 */
export function buildSnippet(text: string, query: string, radius = SNIPPET_RADIUS): string | null {
  const needle = query.replace(/\s+/g, ' ').trim()
  if (needle === '' || text === '') return null

  let start = text.toLowerCase().indexOf(needle.toLowerCase())
  let end = start + needle.length
  if (start < 0) {
    const { packed, at } = packWithMap(text)
    const packedNeedle = despaceSearchText(needle).toLowerCase()
    if (packedNeedle === '') return null
    const hit = packed.indexOf(packedNeedle)
    if (hit < 0) return null
    start = at[hit]
    end = at[hit + packedNeedle.length - 1] + 1
  }

  const from = Math.max(0, start - radius)
  const to = Math.min(text.length, end + radius)
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim()
  if (body === '') return null
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`
}

/* ------------------------------------------------------------------ */
/* 过滤条件 → SQL                                                      */
/* ------------------------------------------------------------------ */

interface FilterSql {
  /** 以 `s` 为 `chain_segment` 别名的 WHERE 子句（空串 = 不过滤） */
  where: string
  params: unknown[]
}

/**
 * 把过滤条件翻成 SQL。返回 `null` 表示「这个条件不可能有结果」
 * （例如库里根本没有这个标签名），调用方直接给空结果，不必查库。
 */
function buildFilterSql(db: ChainDb, filter: ChainSearchFilter): FilterSql | null {
  const where: string[] = []
  const params: unknown[] = []

  if (filter.includeOpen !== true) where.push('s.closed = 1')
  if (filter.dayKey !== undefined) {
    where.push('s.day_key = ?')
    params.push(filter.dayKey)
  }
  if (filter.from !== undefined) {
    // 与 [from, to] 有交集的段都要；开着的段结束时间未定，一律算在内（与 querySegments 同口径）
    where.push('(s.closed = 0 OR s.end_ts >= ?)')
    params.push(filter.from)
  }
  if (filter.to !== undefined) {
    where.push('s.start_ts <= ?')
    params.push(filter.to)
  }
  if (filter.app !== undefined) {
    where.push('s.app = ?')
    params.push(filter.app)
  }

  if (filter.tag !== undefined) {
    const key = nameKey(filter.tag)
    const names = listTagNames(db).filter((name) => nameKey(name) === key)
    if (names.length === 0) return null
    where.push(`s.id IN (SELECT segment_id FROM chain_tag WHERE name IN (${names.map(() => '?').join(', ')}))`)
    params.push(...names)
  }

  if (filter.link !== undefined) {
    const key = nameKey(filter.link)
    const ids = listLinks(db)
      .filter((link) => nameKey(link.name) === key || link.aliases.some((alias) => nameKey(alias) === key))
      .map((link) => link.id)
    if (ids.length === 0) return null
    where.push(
      `s.id IN (SELECT segment_id FROM chain_link_segment WHERE link_id IN (${ids.map(() => '?').join(', ')}))`
    )
    params.push(...ids)
  }

  return { where: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params }
}

/* ------------------------------------------------------------------ */
/* 关键词路                                                             */
/* ------------------------------------------------------------------ */

interface KeywordRank {
  segmentId: number
  matches: number
  /** 这一条（最近的一条命中内容）的落库时刻，用来打破同分 */
  latestAt: number
  contentIds: number[]
  snippet: string | null
}

/**
 * 扫描行：只有小列 + 每个关键词一个命中标记（`m0`/`m1`…）。
 *
 * 为什么要标记列而不是把 `text` 取回来自己比：`chain_content.text` 平均 17k 字，
 * 467 行就有 8 MB，`SELECT c.text` 会让扫描 + `ORDER BY` 的临时 B 树一起搬 8 MB
 * （实测 237 ms，而只取 id/段/时刻是 39 ms）。命中判断本来就由 SQL 的 `LIKE`
 * 做完了（归一列上的 LIKE 与旧 JS `includes` 同口径、且更严），所以这里只回 0/1。
 */
interface KeywordRow {
  id: number
  segmentId: number
  capturedAt: number
  /** 第 i 个关键词是否命中（列名 `m{i}`），由一条 SQL 内联算出 */
  [flag: `m${number}`]: number
}

/** 一个关键词的排名（按 命中条数 → 最近命中时刻 → 段 id 降序） */
interface KeywordRanking {
  ranking: number[]
  ranks: Map<number, KeywordRank>
  /** 扫描窗口内这个词命中的内容行数（= 旧实现 LIMIT 之后的 rows.length） */
  rows: number
}

/**
 * `chain_content.text_norm` 是否就位（v3 迁移前的老库没有这一列）。
 * 每个连接只探测一次：没有这一列时查询退回老的 `normalizeOcrSql(text)` 表达式，
 * 结果口径完全一致，只是慢一些——不让「还没迁移」变成「检索直接报错」。
 */
const textNormReady = new WeakMap<object, boolean>()

function hasTextNorm(db: ChainDb): boolean {
  const cached = textNormReady.get(db)
  if (cached !== undefined) return cached
  let ready = false
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('chain_content')").all() as Array<{
      name: string
    }>
    ready = columns.some((column) => column.name === 'text_norm')
  } catch {
    ready = false
  }
  textNormReady.set(db, ready)
  return ready
}

/**
 * 只给「真正会返回的名次」取正文做摘要（性能方案 P0-3 收尾）。
 *
 * 摘要只用于最终返回的每路前 `snippetLimit` 条，所以扫描阶段完全不碰 `text`；
 * 排名定下来后再按内容 id 取一次（8 个词 × limit 8 ≈ 30 条 / 17k 字，实测 6 ms）。
 */
function attachSnippets(
  db: ChainDb,
  unique: ReadonlyArray<{ text: string }>,
  sorted: ReadonlyArray<ReadonlyArray<KeywordRank>>,
  snippetLimit: number
): void {
  const wanted: Array<{ rank: KeywordRank; slot: number; contentId: number }> = []
  const ids = new Set<number>()
  for (let slot = 0; slot < sorted.length; slot += 1) {
    for (const rank of sorted[slot].slice(0, Math.max(0, snippetLimit))) {
      const contentId = rank.contentIds[0]
      if (contentId === undefined) continue
      wanted.push({ rank, slot, contentId })
      ids.add(contentId)
    }
  }
  if (ids.size === 0) return

  const textById = new Map<number, string>()
  const list = [...ids]
  for (let index = 0; index < list.length; index += SNIPPET_FETCH_CHUNK) {
    const chunk = list.slice(index, index + SNIPPET_FETCH_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    for (const row of db
      .prepare(`SELECT id, text FROM chain_content WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: number; text: string }>) {
      textById.set(row.id, row.text)
    }
  }

  for (const item of wanted) {
    const text = textById.get(item.contentId)
    item.rank.snippet = text === undefined ? null : buildSnippet(text, unique[item.slot].text)
  }
}

/**
 * 多关键词一次扫描（性能方案 P0-3）。
 *
 * 旧实现每个关键词各发一条 SQL：8 个词就是 8 次全表 LIKE + 8 遍逐行归一化
 * （`normalizeOcrSql` 是 6 层 replace），实测一次工具调用 818 ms 全压在主进程。
 * 现在：一条 SQL 用 OR 扫一次、按时间倒序流式读，每个词各自累计到 scanLimit 条就停。
 * 每个词的名次口径（命中条数 → 最近命中时刻 → 段 id）与逐词查询完全一致。
 *
 * 命中判断只由 SQL 的 `LIKE` 做（归一列上的 LIKE 是旧 JS `includes` 的子集：
 * 空白已由归一列去掉、大小写只差非 ASCII 部分，所以不会多召回），不再把
 * 每行 17k 字的正文搬回主进程逐词 `includes`——那一步在大库上要 200 ms 以上。
 *
 * 已知取舍：8 个词共用一个「最新命中行」扫描窗口（第 i 个词取满它自己的 scanLimit
 * 为止）。旧实现是每词各取 200 条；如果最近 1600 条命中全被一个高频词占满，
 * 低频词会少拿几行——用一次扫描换掉 8 次扫描的代价，记在性能方案 §4.5。
 */
function rankKeywords(
  db: ChainDb,
  filter: FilterSql,
  texts: readonly string[],
  scanLimit: number,
  snippetLimit: number
): { rankings: KeywordRanking[]; rows: number } {
  // 去空白后相同的词（含重复传参）共用一个扫描槽位，排名对象也共用——
  // 与旧实现「重复关键词各查一次、得到同样的排名」在 RRF 里等价。
  const unique: Array<{ text: string; like: string; packed: string }> = []
  const slotOf: number[] = []
  for (const text of texts) {
    const packed = despaceSearchText(text).toLowerCase()
    if (packed === '') {
      slotOf.push(-1)
      continue
    }
    let slot = unique.findIndex((item) => item.packed === packed)
    if (slot < 0) {
      slot = unique.length
      unique.push({ text, like: escapeLike(despaceSearchText(text)), packed })
    }
    slotOf.push(slot)
  }

  const emptyRanking = (): KeywordRanking => ({ ranking: [], ranks: new Map(), rows: 0 })
  if (unique.length === 0) {
    return { rankings: texts.map(emptyRanking), rows: 0 }
  }

  const perSlot = unique.map((item) => ({
    text: item.text,
    ranks: new Map<number, KeywordRank>(),
    rows: 0
  }))
  const normColumn = hasTextNorm(db) ? 'c.text_norm' : normalizeOcrSql('c.text')
  const like = (alias: string): string => `${normColumn} LIKE ${alias} ESCAPE '\\'`
  // 占位符按「出现顺序」绑定（better-sqlite3 不认 `?1` 这种编号写法）：先 SELECT 里的
  // 标记列，再 filter 的条件，最后 WHERE 里的 OR；同一个词因此会绑两次。
  const flags = unique.map((_, index) => `(${like('?')}) AS m${index}`).join(', ')
  const where = unique.map(() => `(${like('?')})`).join(' OR ')
  const statement = db.prepare(
    `SELECT c.id AS id, c.segment_id AS segmentId, c.captured_at AS capturedAt, ${flags}
       FROM chain_content c JOIN chain_segment s ON s.id = c.segment_id
      ${filter.where === '' ? 'WHERE' : `${filter.where} AND`} (${where})
      ORDER BY c.captured_at DESC, c.id DESC`
  )
  const patterns = unique.map((item) => `%${item.like}%`)
  const params = [...patterns, ...filter.params, ...patterns]

  // 流式读 + 逐词截窗：不把命中行全部 materialize 进内存（大库上一词命中上万行很常见）
  for (const row of statement.iterate(...params) as IterableIterator<KeywordRow>) {
    for (let slot = 0; slot < unique.length; slot += 1) {
      const bucket = perSlot[slot]
      if (bucket.rows >= scanLimit) continue
      if (!row[`m${slot}`]) continue
      bucket.rows += 1
      const existing = bucket.ranks.get(row.segmentId)
      if (existing) {
        existing.matches += 1
        if (existing.contentIds.length < 3) existing.contentIds.push(row.id)
      } else {
        bucket.ranks.set(row.segmentId, {
          segmentId: row.segmentId,
          matches: 1,
          latestAt: row.capturedAt,
          contentIds: [row.id],
          snippet: null
        })
      }
    }
    // 每个词都取满了：后面的行再新也不会改变任何一个词的名次
    if (perSlot.every((bucket) => bucket.rows >= scanLimit)) break
  }

  const sorted = perSlot.map((bucket) =>
    [...bucket.ranks.values()].sort(
      (a, b) => b.matches - a.matches || b.latestAt - a.latestAt || b.segmentId - a.segmentId
    )
  )
  attachSnippets(db, unique, sorted, snippetLimit)

  const built = perSlot.map((bucket, index) => ({
    ranking: sorted[index].map((rank) => rank.segmentId),
    ranks: bucket.ranks,
    rows: bucket.rows
  }))
  return {
    rankings: slotOf.map((slot) => (slot >= 0 ? built[slot] : emptyRanking())),
    rows: built.reduce((sum, item) => sum + item.rows, 0)
  }
}

/* ------------------------------------------------------------------ */
/* 向量路                                                               */
/* ------------------------------------------------------------------ */

interface VectorRank {
  ranking: number[]
  similarities: Map<number, number>
  vectors: number
  skipped: number
}

/** 段向量余弦（全量扫，段数到万级再说；派生层可重建，坏行只跳过不报错） */
function rankByVector(
  db: ChainDb,
  filter: FilterSql,
  queryVec: Float32Array,
  minSimilarity: number,
  cap: number
): VectorRank {
  const rows = db
    .prepare(
      `SELECT v.segment_id AS segmentId, v.dim AS dim, v.vec AS vec
         FROM chain_vector v JOIN chain_segment s ON s.id = v.segment_id
         ${filter.where}`
    )
    .all(...filter.params) as Array<{ segmentId: number; dim: number; vec: Buffer }>

  const scored: Array<{ segmentId: number; similarity: number }> = []
  let compared = 0
  let skipped = 0
  for (const row of rows) {
    if (row.dim !== queryVec.length || row.vec.byteLength !== row.dim * 4) {
      skipped += 1
      continue
    }
    const vec = unpackVector(row.vec, row.dim)
    if (!vec) {
      skipped += 1
      continue
    }
    compared += 1
    const similarity = cosineSimilarity(queryVec, vec)
    if (similarity < minSimilarity) continue
    scored.push({ segmentId: row.segmentId, similarity })
  }

  scored.sort((a, b) => b.similarity - a.similarity || b.segmentId - a.segmentId)
  const top = scored.slice(0, Math.max(1, cap))
  return {
    ranking: top.map((item) => item.segmentId),
    similarities: new Map(top.map((item): [number, number] => [item.segmentId, item.similarity])),
    vectors: compared,
    skipped
  }
}

/* ------------------------------------------------------------------ */
/* 融合与落库读                                                         */
/* ------------------------------------------------------------------ */

/** RRF：名次（1 起）→ 分；同分靠调用方按时间排 */
function fuse(rankings: readonly (readonly number[])[]): Map<number, number> {
  const scores = new Map<number, number>()
  for (const ranking of rankings) {
    ranking.forEach((segmentId, index) => {
      const score = 1 / (RRF_K + index + 1)
      scores.set(segmentId, (scores.get(segmentId) ?? 0) + score)
    })
  }
  return scores
}

interface RankedHit {
  segmentId: number
  score: number
  similarity: number | null
  keyword: KeywordRank | null
}

/** 一条命中里与关键词无关的部分（段行 / 标签 / 双链 / 子行计数） */
interface HitBase {
  segment: ChainSegmentRow
  tags: string[]
  links: string[]
  counts: ChainHitCounts
}

/** 段行 / 标签 / 双链 / 子行计数：一次批查询，避免每条命中各查一遍 */
function loadHitBase(db: ChainDb, ids: readonly number[]): Map<number, HitBase> {
  const result = new Map<number, HitBase>()
  if (ids.length === 0) return result
  const placeholders = ids.map(() => '?').join(', ')

  const segments = new Map<number, ChainSegmentRow>()
  for (const row of db
    .prepare(`SELECT * FROM chain_segment WHERE id IN (${placeholders})`)
    .all(...ids) as ChainSegmentRow[]) {
    segments.set(row.id, row)
  }

  const tags = new Map<number, string[]>()
  for (const row of db
    .prepare(`SELECT segment_id AS segmentId, name FROM chain_tag WHERE segment_id IN (${placeholders}) ORDER BY id`)
    .all(...ids) as Array<{ segmentId: number; name: string }>) {
    const list = tags.get(row.segmentId) ?? []
    list.push(row.name)
    tags.set(row.segmentId, list)
  }

  const links = new Map<number, string[]>()
  for (const row of db
    .prepare(
      `SELECT ls.segment_id AS segmentId, l.name AS name
         FROM chain_link_segment ls JOIN chain_link l ON l.id = ls.link_id
        WHERE ls.segment_id IN (${placeholders}) ORDER BY l.id`
    )
    .all(...ids) as Array<{ segmentId: number; name: string }>) {
    const list = links.get(row.segmentId) ?? []
    list.push(row.name)
    links.set(row.segmentId, list)
  }

  const countOf = (sql: string): Map<number, number> => {
    const map = new Map<number, number>()
    for (const row of db.prepare(sql).all(...ids) as Array<{ segmentId: number; n: number }>) {
      map.set(row.segmentId, row.n)
    }
    return map
  }
  const events = countOf(
    `SELECT segment_id AS segmentId, COUNT(*) AS n FROM chain_event WHERE segment_id IN (${placeholders}) GROUP BY segment_id`
  )
  const shots = countOf(
    `SELECT segment_id AS segmentId, COUNT(*) AS n FROM chain_shot WHERE segment_id IN (${placeholders}) GROUP BY segment_id`
  )
  const contents = countOf(
    `SELECT segment_id AS segmentId, COUNT(*) AS n FROM chain_content WHERE segment_id IN (${placeholders}) GROUP BY segment_id`
  )

  for (const segment of segments.values()) {
    result.set(segment.id, {
      segment,
      tags: tags.get(segment.id) ?? [],
      links: links.get(segment.id) ?? [],
      counts: {
        events: events.get(segment.id) ?? 0,
        shots: shots.get(segment.id) ?? 0,
        contents: contents.get(segment.id) ?? 0
      }
    })
  }
  return result
}

/** 排名 + 段信息 → 命中行（同分排序已在上游做过，这里只截断） */
function assembleHits(
  ranked: readonly RankedHit[],
  base: ReadonlyMap<number, HitBase>,
  limit: number
): ChainHit[] {
  const hits: ChainHit[] = []
  for (const item of ranked) {
    const row = base.get(item.segmentId)
    if (!row) continue // 段在排名与读行之间被删了（只可能是人为清理）：跳过，不编造
    hits.push({
      segment: row.segment,
      score: item.score,
      similarity: item.similarity,
      matches: item.keyword?.matches ?? 0,
      contentIds: item.keyword?.contentIds ?? [],
      snippet: item.keyword?.snippet ?? null,
      tags: row.tags,
      links: row.links,
      counts: row.counts
    })
    if (hits.length >= limit) break
  }
  return hits
}

function hydrate(db: ChainDb, ranked: readonly RankedHit[], limit: number): ChainHit[] {
  return assembleHits(ranked, loadHitBase(db, ranked.map((item) => item.segmentId)), limit)
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 检索段。三种输入可任意组合：
 *
 * - `text`：正文关键词；`vector`：语义；两者都有 → RRF 融合；
 * - 只有过滤条件（时间 / 应用 / 标签 / 双链）→ 按开始时间倒序列出这些段；
 * - 什么都没有 → 空结果（不会把整库段倒出来）。
 *
 * 只读：不写表、不改派生水位、不出网。
 */
export function searchChainSegments(db: ChainDb, query: ChainSearchQuery = {}): ChainSearchResult {
  const filter = buildFilterSql(db, query)
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(query.limit ?? DEFAULT_SEARCH_LIMIT)))
  const hasText = (query.text ?? '').replace(/\s+/g, '') !== ''
  const hasVector = query.vector !== undefined && query.vector.length > 0
  const hasFilter =
    query.from !== undefined ||
    query.to !== undefined ||
    query.dayKey !== undefined ||
    query.app !== undefined ||
    query.tag !== undefined ||
    query.link !== undefined ||
    query.includeOpen === true

  const empty: ChainSearchResult = {
    hits: [],
    stats: { mode: hasFilter ? 'filter' : hasText ? 'keyword' : hasVector ? 'vector' : 'filter', vectors: 0, skippedVectors: 0, keywordRows: 0 }
  }
  if (filter === null) return empty
  if (!hasText && !hasVector && !hasFilter) return empty

  // 只用关键词 / 向量时 `limit` 是「返回多少条」；排名最多留 3 倍，融合后再截断
  const rankCap = Math.max(limit * 3, 60)

  const keyword = hasText
    ? rankKeywords(db, filter, [query.text ?? ''], Math.max(limit * KEYWORD_SCAN_FACTOR, 200), limit)
        .rankings[0]
    : null
  const vector = hasVector
    ? rankByVector(db, filter, query.vector as Float32Array, query.minSimilarity ?? 0, rankCap)
    : null

  let ranked: RankedHit[]
  let mode: ChainSearchStats['mode']

  if (keyword && vector) {
    mode = 'hybrid'
    const fused = fuse([keyword.ranking, vector.ranking])
    ranked = [...fused.entries()]
      .map(([segmentId, score]) => ({
        segmentId,
        score,
        similarity: vector.similarities.get(segmentId) ?? null,
        keyword: keyword.ranks.get(segmentId) ?? null
      }))
      .sort((a, b) => b.score - a.score)
  } else if (vector) {
    mode = 'vector'
    ranked = vector.ranking.map((segmentId, index) => ({
      segmentId,
      score: 1 / (RRF_K + index + 1),
      similarity: vector.similarities.get(segmentId) ?? null,
      keyword: null
    }))
  } else if (keyword) {
    mode = 'keyword'
    ranked = keyword.ranking.map((segmentId, index) => ({
      segmentId,
      score: 1 / (RRF_K + index + 1),
      similarity: null,
      keyword: keyword.ranks.get(segmentId) ?? null
    }))
  } else {
    // 纯过滤：不涉及名次，按开始时间倒序
    mode = 'filter'
    const rows = db
      .prepare(`SELECT id, start_ts AS startTs FROM chain_segment s ${filter.where} ORDER BY s.start_ts DESC, s.id DESC LIMIT ?`)
      .all(...filter.params, limit) as Array<{ id: number; startTs: number }>
    ranked = rows.map((row) => ({ segmentId: row.id, score: 0, similarity: null, keyword: null }))
  }

  // 同分（或纯过滤）按段开始时间倒序：新的在前
  if (mode !== 'filter' && ranked.length > 0) {
    const timeOf = new Map(
      (
        db
          .prepare(
            `SELECT id, start_ts AS startTs FROM chain_segment WHERE id IN (${ranked.map(() => '?').join(', ')})`
          )
          .all(...ranked.map((item) => item.segmentId)) as Array<{ id: number; startTs: number }>
      ).map((row): [number, number] => [row.id, row.startTs])
    )
    ranked = [...ranked].sort(
      (a, b) => b.score - a.score || (timeOf.get(b.segmentId) ?? 0) - (timeOf.get(a.segmentId) ?? 0)
    )
  }

  return {
    hits: hydrate(db, ranked, limit),
    stats: {
      mode,
      vectors: vector?.vectors ?? 0,
      skippedVectors: vector?.skipped ?? 0,
      keywordRows: keyword?.rows ?? 0
    }
  }
}

export interface ChainSearchBatchQuery extends ChainSearchFilter {
  /** 每个关键词一路（去空白后相同 / 重复的词共用一个扫描槽位） */
  texts: readonly string[]
  /** 每一路返回多少条（默认 20、最大 200） */
  limit?: number
}

export interface ChainSearchBatchResult {
  /** 每个关键词一路命中（顺序与 `texts` 对齐；没有可执行条件时每路都是空数组） */
  hitsPerText: ChainHit[][]
  stats: ChainSearchStats
}

/**
 * 多关键词检索（性能方案 P0-3 的「合并查询」）：一次 SQL 扫完所有关键词，
 * 段行 / 标签 / 双链 / 子行计数也只查一次（旧实现是每词一次 `searchChainSegments`）。
 *
 * 只做关键词路（语义路由调用方另外走一次向量检索），返回的每一路名次口径与
 * `searchChainSegments({ text })` 一致，调用方据此做 RRF 融合。
 */
export function searchChainSegmentsBatch(
  db: ChainDb,
  query: ChainSearchBatchQuery
): ChainSearchBatchResult {
  const filter = buildFilterSql(db, query)
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(query.limit ?? DEFAULT_SEARCH_LIMIT)))
  const empty = (): ChainSearchBatchResult => ({
    hitsPerText: query.texts.map(() => []),
    stats: { mode: 'keyword', vectors: 0, skippedVectors: 0, keywordRows: 0 }
  })
  if (filter === null || query.texts.length === 0) return empty()

  const scanned = rankKeywords(db, filter, query.texts, Math.max(limit * KEYWORD_SCAN_FACTOR, 200), limit)
  const keywordRows = scanned.rankings.reduce((sum, item) => sum + item.rows, 0)
  if (keywordRows === 0) return empty()

  const rankedPerText: RankedHit[][] = scanned.rankings.map((item) =>
    item.ranking.map((segmentId, index) => ({
      segmentId,
      score: 1 / (RRF_K + index + 1),
      similarity: null,
      keyword: item.ranks.get(segmentId) ?? null
    }))
  )
  // 各路段 id 先并集再 hydration：8 个词最多查 6 次，而不是 8 × 6 次
  const ids = [...new Set(rankedPerText.flat().map((item) => item.segmentId))]
  const base = loadHitBase(db, ids)
  return {
    hitsPerText: rankedPerText.map((ranked) => assembleHits(ranked, base, limit)),
    stats: { mode: 'keyword', vectors: 0, skippedVectors: 0, keywordRows }
  }
}
