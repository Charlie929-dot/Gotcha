/**
 * 个人记忆 · 存储与召回（日记 = 第二本账）
 *
 * 三件事：
 * 1）**增量同步**：日记目录里每份 md 按 (mtime, size) 判新旧，变了才重新解析；
 *    条目的稳定键是 `sha1(日期 + 段落 + 起始行 + 正文)`，正文改了就是新条目、
 *    旧条目在同一次事务里删掉——重复跑 sync 结果完全一致（幂等）。
 * 2）**召回**：关键词逐词打分（命中次数 + 长度权重 + 标签/双链加权）+ 时间衰减，
 *    每条结果都带 `reasons`（人话，「因为提到了 X」），这是「它到底懂不懂我」的唯一判据。
 * 3）**画像**：条目 / 天数 / 连续记录 / 高频话题 / 待办完成率，落成可解释的观测。
 *
 * 召回不用 FTS5：日记语料是「每人几千条 × 每条一两百字」的量级，LIKE 全表扫在
 * better-sqlite3 里是毫秒级；FTS 的 trigram 对 1–2 个汉字反而搜不到（和 events_fts
 * 同一个坑），还要额外维护触发器。等语料真的上万条、或接入向量检索时再换。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { Db } from '../db'
import { dayStartTs, parseDailyNote, type MemoryItemKind } from './vault'

export interface SyncVaultResult {
  /** 目录里认得的 `.md` 文件数 */
  scanned: number
  /** mtime/size 没变、直接跳过解析的文件数 */
  unchanged: number
  /** 模板 / 取不到日期 / 没有有效条目的文件数 */
  skipped: number
  added: number
  updated: number
  removed: number
  /** 索引里现有的条目总数 */
  items: number
}

export interface MemoryItemRow {
  id: number
  uid: string
  source_path: string
  day_key: string
  section: string
  kind: MemoryItemKind
  text: string
  ts: number | null
  line_start: number
  line_end: number
  tags: string[]
  refs: string[]
}

export interface MemoryHit extends MemoryItemRow {
  score: number
  /** 人话理由：提到「X」（3 次）、标签「考研」、距今天 12 天 … */
  reasons: string[]
}

/** 浏览 / 管理（设置抽屉的「记忆条目」）：按天倒序分页，关键词或日期前缀过滤 */
export interface MemoryListQuery {
  /**
   * 关键词（空格分词、逐词 OR，与召回同口径）；纯日期（`2026-09` / `2026-09-29`）
   * 按 `day_key` 前缀匹配——想翻某一月 / 某一天时不用记日期语法。
   */
  search?: string
  kind?: MemoryItemKind
  offset?: number
  limit?: number
}

export interface MemoryListResult {
  items: MemoryItemRow[]
  /** 满足条件的总条数（不是这一页） */
  total: number
  hasMore: boolean
}

/** 删一条的结果：删掉的整行 + 回收站现有条数（界面显示「已删除 · 撤销」用） */
export interface DeleteMemoryResult {
  item: MemoryItemRow
  deleted: number
}

export interface RecallQuery {
  /** 拆好的关键词（逐词 OR，与问记忆的 search_info 同口径） */
  keywords?: readonly string[]
  /** 起止毫秒时间戳（按天过滤时传当天的 00:00 / 次日 00:00） */
  from?: number
  to?: number
  /** 只查某一天（`2026-10-28`） */
  day?: string
  tag?: string
  kind?: MemoryItemKind
  limit?: number
  /** 固定钟（测试注入） */
  now?: number
}

export interface RecallResult {
  hits: MemoryHit[]
  /** 参与打分 / 过滤的候选条目数（诊断用） */
  candidates: number
  /** keywords / filter（纯过滤时没有关键词） */
  mode: 'keywords' | 'filter'
}

export interface MemoryStats {
  items: number
  days: number
  firstDay: string | null
  lastDay: string | null
  /** 截至 lastDay 的连续记录天数 */
  streakDays: number
  tasks: { open: number; done: number }
  topTags: Array<{ tag: string; items: number; days: number }>
  topRefs: Array<{ ref: string; items: number; days: number }>
}

export interface MemoryObservation {
  uid: string
  topic: string
  statement: string
  source: string
  confidence: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function nowMs(): number {
  return Date.now()
}

/** 归一化：小写 + 折叠空白（中文没有空格，英文相邻词仍然保留单空格） */
export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim()
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/gu, (char) => `\\${char}`)
}

/** path 是否在 dir 下（同步范围判定：换目录不许误删别的目录的记忆） */
function isUnderRoot(root: string, path: string): boolean {
  const base = root.replace(/[\\/]+$/u, '')
  return path === base || path.startsWith(`${base}\\`) || path.startsWith(`${base}/`)
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

interface Row {
  id: number
  uid: string
  source_path: string
  day_key: string
  section: string
  kind: string
  text: string
  ts: number | null
  line_start: number
  line_end: number
  tags: string
  refs: string
}

function toItem(row: Row): MemoryItemRow {
  return {
    id: row.id,
    uid: row.uid,
    source_path: row.source_path,
    day_key: row.day_key,
    section: row.section,
    kind: row.kind as MemoryItemKind,
    text: row.text,
    ts: row.ts,
    line_start: row.line_start,
    line_end: row.line_end,
    tags: parseJsonArray(row.tags),
    refs: parseJsonArray(row.refs)
  }
}

/** 条目稳定键：正文 / 段落 / 起始行任一变化都算新条目（旧条目在同步时被删） */
function itemUid(item: {
  dayKey: string
  section: string
  lineStart: number
  text: string
}): string {
  return createHash('sha1')
    .update(`${item.dayKey}\u0000${item.section}\u0000${item.lineStart}\u0000${item.text}`)
    .digest('hex')
}

/* ------------------------------------------------------------------ */
/* 增量同步                                                            */
/* ------------------------------------------------------------------ */

export interface SyncVaultOptions {
  /** 固定钟（测试注入） */
  now?: number
  /** 只同步这些文件（测试用）；默认扫目录下全部 `.md` */
  only?: readonly string[]
}

/**
 * 同步日记目录。**幂等**：同一批内容跑两次，第二次 unchanged 全中、库内容不变。
 * 单个文件解析失败不影响其它文件（跳过并计数），不让一份坏笔记毁掉整次同步。
 */
export function syncVault(db: Db, vaultDir: string, options: SyncVaultOptions = {}): SyncVaultResult {
  const now = options.now ?? nowMs()
  const result: SyncVaultResult = {
    scanned: 0,
    unchanged: 0,
    skipped: 0,
    added: 0,
    updated: 0,
    removed: 0,
    items: 0
  }
  if (!existsSync(vaultDir)) return result

  const names = (options.only ?? readdirSync(vaultDir))
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
  const knownSources = new Map<string, { mtime: number; size: number; dayKey: string | null }>()
  for (const row of db.prepare('SELECT path, mtime, size, day_key FROM mem_sources').all() as Array<{
    path: string
    mtime: number
    size: number
    day_key: string | null
  }>) {
    knownSources.set(row.path, { mtime: row.mtime, size: row.size, dayKey: row.day_key })
  }

  // 用户在设置抽屉里删掉的条目：日记原文还在，整份重解析时必须按 uid 跳过，
  // 否则「改别的段落」就会把删掉的条目一并带回来（回收站见 mem_deleted）。
  const suppressed = new Set(
    (db.prepare('SELECT uid FROM mem_deleted').all() as Array<{ uid: string }>).map((row) => row.uid)
  )

  const seenPaths = new Set<string>()
  for (const name of names) {
    const path = join(vaultDir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    result.scanned += 1
    seenPaths.add(path)
    const known = knownSources.get(path)
    if (known && known.mtime === stat.mtimeMs && known.size === stat.size) {
      result.unchanged += 1
      continue
    }

    let parsed
    try {
      parsed = parseDailyNote(name, readFileSync(path, 'utf8'))
    } catch {
      parsed = null
    }
    if (parsed === null) {
      // 模板 / 没有日期：把上一次的条目清掉，别留着旧内容冒充「今天写的」
      db.transaction(() => {
        db.prepare('DELETE FROM mem_items WHERE source_path = ?').run(path)
        upsertSource(db, path, null, stat.mtimeMs, stat.size, 0, now)
      })()
      result.skipped += 1
      continue
    }

    db.transaction(() => {
      const existing = new Map<string, number>()
      for (const row of db
        .prepare('SELECT uid, text FROM mem_items WHERE source_path = ?')
        .all(path) as Array<{ uid: string; text: string }>) {
        existing.set(row.uid, 1)
      }
      const keep = new Set<string>()
      const insert = db.prepare(
        `INSERT INTO mem_items
           (uid, source_path, day_key, section, kind, text, text_norm, ts, line_start, line_end,
            tags, refs, created_at, updated_at)
         VALUES (@uid, @path, @dayKey, @section, @kind, @text, @textNorm, @ts, @lineStart, @lineEnd,
                 @tags, @refs, @now, @now)
         ON CONFLICT(uid) DO UPDATE SET
           text = excluded.text,
           text_norm = excluded.text_norm,
           ts = excluded.ts,
           line_end = excluded.line_end,
           tags = excluded.tags,
           refs = excluded.refs,
           updated_at = excluded.updated_at`
      )
      for (const item of parsed.items) {
        const uid = itemUid(item)
        // 删过的条目：不插回、也不进 keep（它本来就不在库里；万一旧行还在，下面的移除循环会清掉）
        if (suppressed.has(uid)) continue
        keep.add(uid)
        // 待办的完成态也进 tags（`open` / `done`）：召回与统计共用一列，不用再读 meta
        const tags = [...item.tags]
        if (item.kind === 'task') tags.push(item.done === true ? 'done' : 'open')
        insert.run({
          uid,
          path,
          dayKey: item.dayKey,
          section: item.section,
          kind: item.kind,
          text: item.text,
          textNorm: normalizeMemoryText(item.text),
          ts: item.ts,
          lineStart: item.lineStart,
          lineEnd: item.lineEnd,
          tags: JSON.stringify(tags),
          refs: JSON.stringify(item.refs),
          now
        })
        if (existing.has(uid)) result.updated += 1
        else result.added += 1
      }
      const remove = db.prepare('DELETE FROM mem_items WHERE uid = ?')
      for (const uid of existing.keys()) {
        if (keep.has(uid)) continue
        remove.run(uid)
        result.removed += 1
      }
      upsertSource(db, path, parsed.dayKey, stat.mtimeMs, stat.size, parsed.items.length, now)
    })()
  }

  // 目录里删掉的文件：条目跟着走（记忆不该比源文件活得久）。
  // **只清本次同步目录下的来源**：同一台机器可能先后同步过两个日记目录
  // （比如 D:\Github\charlie_vault 与 %USERPROFILE%\charlie_vault），
  // 换目录时把另一个目录的记忆整批删掉是最坏的副作用（真实踩过：一次删了 2382 条）。
  for (const [path] of knownSources) {
    if (seenPaths.has(path) || !isUnderRoot(vaultDir, path)) continue
    db.transaction(() => {
      const removed = db.prepare('DELETE FROM mem_items WHERE source_path = ?').run(path).changes
      db.prepare('DELETE FROM mem_sources WHERE path = ?').run(path)
      result.removed += removed
    })()
  }

  result.items = (db.prepare('SELECT COUNT(*) AS count FROM mem_items').get() as { count: number }).count
  return result
}

/**
 * 忘掉某个目录下的全部记忆（隐私 / 清理用）：只删 `dir` 下的来源，别的目录不动。
 * 同步时「换目录不误删」靠的是同一条范围判定，两边口径共用 `isUnderRoot`。
 */
export function forgetVault(db: Db, vaultDir: string): number {
  const rows = db.prepare('SELECT path FROM mem_sources').all() as Array<{ path: string }>
  let removed = 0
  for (const row of rows) {
    if (!isUnderRoot(vaultDir, row.path)) continue
    db.transaction(() => {
      removed += db.prepare('DELETE FROM mem_items WHERE source_path = ?').run(row.path).changes
      db.prepare('DELETE FROM mem_sources WHERE path = ?').run(row.path)
    })()
  }
  return removed
}

/** 当前索引里有哪些来源（诊断 / `forget` 前先看一眼） */
export function listMemorySources(db: Db): Array<{ path: string; items: number; lastSyncedAt: number }> {
  return (
    db
      .prepare(
        `SELECT s.path AS path, s.synced_at AS synced_at,
                (SELECT COUNT(*) FROM mem_items i WHERE i.source_path = s.path) AS items
         FROM mem_sources s
         ORDER BY s.path ASC`
      )
      .all() as Array<{ path: string; synced_at: number; items: number }>
  ).map((row) => ({ path: row.path, items: row.items, lastSyncedAt: row.synced_at }))
}

function upsertSource(  db: Db,
  path: string,
  dayKey: string | null,
  mtime: number,
  size: number,
  itemCount: number,
  now: number
): void {
  db.prepare(
    `INSERT INTO mem_sources (path, day_key, mtime, size, item_count, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       day_key = excluded.day_key,
       mtime = excluded.mtime,
       size = excluded.size,
       item_count = excluded.item_count,
       synced_at = excluded.synced_at`
  ).run(path, dayKey, mtime, size, itemCount, now)
}

/* ------------------------------------------------------------------ */
/* 召回                                                                */
/* ------------------------------------------------------------------ */

const TYPE_WEIGHT: Record<MemoryItemKind, number> = {
  diary: 1,
  task: 0.9,
  note: 0.8,
  quote: 0.6
}

const RECALL_LIMIT_DEFAULT = 8
const RECALL_LIMIT_MAX = 20

/**
 * 关键词召回。打分只依赖条目本身（不看会话 / 不看模型），因此同一问题问两次结果一致。
 *
 * 分数构成：
 * - 词命中：每次命中加权，长词（更具体）权重更高；
 * - 结构加权：命中标签 / 双链 > 命中正文；
 * - 时间衰减：越近越靠前（半衰期约 45 天），但**不覆盖**词命中——只做同分时的排序依据；
 * - 类别：日记 > 待办 > 摘录。
 */
export function recallMemory(db: Db, query: RecallQuery): RecallResult {
  const now = query.now ?? nowMs()
  const limit = Math.min(
    RECALL_LIMIT_MAX,
    Math.max(1, Math.round(query.limit ?? RECALL_LIMIT_DEFAULT))
  )
  const keywords = (query.keywords ?? [])
    .map((keyword) => normalizeMemoryText(keyword))
    .filter((keyword) => keyword !== '')
    .slice(0, 8)

  const where: string[] = []
  const params: unknown[] = []
  if (query.day !== undefined && query.day !== '') {
    where.push('day_key = ?')
    params.push(query.day)
  }
  if (query.kind !== undefined) {
    where.push('kind = ?')
    params.push(query.kind)
  }
  if (query.tag !== undefined && query.tag !== '') {
    where.push('tags LIKE ?')
    params.push(`%"${escapeLike(query.tag.toLowerCase())}"%`)
  }
  if (query.from !== undefined || query.to !== undefined) {
    where.push('(ts IS NOT NULL AND ts >= ? AND ts <= ?)')
    params.push(query.from ?? 0, query.to ?? Number.MAX_SAFE_INTEGER)
  }
  if (keywords.length > 0) {
    const clauses: string[] = []
    for (const keyword of keywords) {
      clauses.push("text_norm LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(keyword)}%`)
    }
    where.push(`(${clauses.join(' OR ')})`)
  }

  const sql =
    where.length === 0
      ? 'SELECT * FROM mem_items ORDER BY COALESCE(ts, 0) DESC LIMIT 500'
      : `SELECT * FROM mem_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(ts, 0) DESC LIMIT 500`
  const rows = db.prepare(sql).all(...params) as Row[]

  const hits: MemoryHit[] = []
  for (const row of rows) {
    const item = toItem(row)
    const norm = normalizeMemoryText(item.text)
    let score = 0
    const reasons: string[] = []
    for (const keyword of keywords) {
      let count = 0
      let index = norm.indexOf(keyword)
      while (index >= 0 && count < 5) {
        count += 1
        index = norm.indexOf(keyword, index + keyword.length)
      }
      if (count === 0) continue
      const specificity = 1 + Math.min(keyword.length, 8) / 16
      score += (0.8 + Math.min(count, 5) * 0.25) * specificity
      reasons.push(count > 1 ? `提到「${keyword}」${count} 次` : `提到「${keyword}」`)
    }
    if (keywords.length > 0 && reasons.length === 0) continue

    const tagHit = keywords.find((keyword) =>
      item.tags.some((tag) => normalizeMemoryText(tag).includes(keyword))
    )
    if (tagHit !== undefined) {
      score += 1.2
      reasons.push(`标签「${tagHit}」`)
    }
    const refHit = keywords.find((keyword) =>
      item.refs.some((ref) => normalizeMemoryText(ref).includes(keyword))
    )
    if (refHit !== undefined) {
      score += 1.2
      reasons.push(`关联「${refHit}」`)
    }
    if (keywords.length === 0) reasons.push('按时间列出')

    score += TYPE_WEIGHT[item.kind] ?? 0.6
    const stamp = item.ts ?? dayStartTs(item.day_key)
    if (stamp !== null) {
      const daysAgo = Math.max(0, (now - stamp) / 86_400_000)
      score += 0.6 / (1 + daysAgo / 45)
      if (daysAgo < 1) reasons.push('今天写的')
      else if (daysAgo < 31) reasons.push(`距今天 ${Math.round(daysAgo)} 天`)
      else reasons.push(`${item.day_key}`)
    }
    hits.push({ ...item, score, reasons })
  }

  hits.sort((a, b) => b.score - a.score || (b.ts ?? 0) - (a.ts ?? 0) || b.id - a.id)
  return {
    hits: hits.slice(0, limit),
    candidates: rows.length,
    mode: keywords.length > 0 ? 'keywords' : 'filter'
  }
}

/** 读某一天的全部条目（按原文顺序）；没有这天返回 null */
export function readMemoryDay(
  db: Db,
  dayKey: string
): { dayKey: string; items: MemoryItemRow[]; text: string } | null {
  const rows = db
    .prepare('SELECT * FROM mem_items WHERE day_key = ? ORDER BY line_start ASC, id ASC')
    .all(dayKey) as Row[]
  if (rows.length === 0) return null
  const items = rows.map(toItem)
  const lines: string[] = []
  let section = ''
  for (const item of items) {
    if (item.section !== section) {
      section = item.section
      lines.push(`## ${section}`)
    }
    const mark = item.kind === 'task' ? '- [ ] ' : '- '
    lines.push(`${mark}${item.text}`)
  }
  return { dayKey, items, text: lines.join('\n') }
}

/* ------------------------------------------------------------------ */
/* 浏览 / 删除（回收站）                                                */
/* ------------------------------------------------------------------ */

const LIST_LIMIT_DEFAULT = 20
const LIST_LIMIT_MAX = 50
/** 回收站上限：删掉的条目留整行，够撤销就行；超出按删除时间丢最旧的 */
const DELETED_KEEP = 500
const DATE_TOKEN_RE = /^\d{4}(?:-\d{2}){0,2}$/u

interface DeletedRow {
  uid: string
  source_path: string
  day_key: string
  section: string
  kind: string
  text: string
  text_norm: string
  ts: number | null
  line_start: number
  line_end: number
  tags: string
  refs: string
  deleted_at: number
}

/**
 * 浏览条目（设置抽屉的「记忆条目」）：按天倒序、同一天按原文顺序（待办在日记前）。
 * `search` 里纯日期的词按 `day_key` 前缀匹配（`2026-09` / `2026-09-29`），其余按正文 LIKE。
 */
export function listMemoryItems(db: Db, query: MemoryListQuery = {}): MemoryListResult {
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Math.round(query.limit ?? LIST_LIMIT_DEFAULT)))
  const offset = Math.max(0, Math.round(query.offset ?? 0))
  const where: string[] = []
  const params: unknown[] = []
  if (query.kind !== undefined) {
    where.push('kind = ?')
    params.push(query.kind)
  }
  const tokens = (query.search ?? '')
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '')
    .slice(0, 6)
  if (tokens.length > 0) {
    const clauses: string[] = []
    for (const token of tokens) {
      if (DATE_TOKEN_RE.test(token)) {
        clauses.push('day_key LIKE ?')
        params.push(`${token}%`)
      } else {
        clauses.push("text_norm LIKE ? ESCAPE '\\'")
        params.push(`%${escapeLike(normalizeMemoryText(token))}%`)
      }
    }
    where.push(`(${clauses.join(' OR ')})`)
  }
  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM mem_items${clause}`).get(...params) as { count: number }
  ).count
  const rows = db
    .prepare(
      `SELECT * FROM mem_items${clause}
       ORDER BY day_key DESC, COALESCE(ts, 0) ASC, line_start ASC, id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Row[]
  return { items: rows.map(toItem), total, hasMore: offset + rows.length < total }
}

/**
 * 删一条：整行搬进回收站（`mem_deleted`），再从索引删掉。
 * 同步时会按 uid 跳过回收站里的条目，所以「改日记别的段落」不会把它带回来；
 * 条目正文改写后 uid 会变，那是用户新写的一条，不受这次删除影响。
 */
export function deleteMemoryItem(
  db: Db,
  itemId: number,
  options: { now?: number } = {}
): DeleteMemoryResult | null {
  const row = db.prepare('SELECT * FROM mem_items WHERE id = ?').get(itemId) as Row | undefined
  if (row === undefined) return null
  const now = options.now ?? nowMs()
  const item = toItem(row)
  db.transaction(() => {
    db.prepare(
      `INSERT INTO mem_deleted
         (uid, source_path, day_key, section, kind, text, text_norm, ts, line_start, line_end,
          tags, refs, deleted_at)
       VALUES (@uid, @sourcePath, @dayKey, @section, @kind, @text, @textNorm, @ts, @lineStart,
               @lineEnd, @tags, @refs, @now)
       ON CONFLICT(uid) DO UPDATE SET deleted_at = excluded.deleted_at`
    ).run({
      uid: item.uid,
      sourcePath: item.source_path,
      dayKey: item.day_key,
      section: item.section,
      kind: item.kind,
      text: item.text,
      textNorm: normalizeMemoryText(item.text),
      ts: item.ts,
      lineStart: item.line_start,
      lineEnd: item.line_end,
      tags: JSON.stringify(item.tags),
      refs: JSON.stringify(item.refs),
      now
    })
    db.prepare('DELETE FROM mem_items WHERE id = ?').run(itemId)
    pruneDeleted(db)
  })()
  return { item, deleted: countDeleted(db) }
}

/** 撤销删除：把回收站里的整行原样放回索引（uid 不变，下次同步也不会重复插） */
export function restoreMemoryItem(
  db: Db,
  uid: string,
  options: { now?: number } = {}
): MemoryItemRow | null {
  const row = db.prepare('SELECT * FROM mem_deleted WHERE uid = ?').get(uid) as DeletedRow | undefined
  if (row === undefined) return null
  const now = options.now ?? nowMs()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO mem_items
         (uid, source_path, day_key, section, kind, text, text_norm, ts, line_start, line_end,
          tags, refs, created_at, updated_at)
       VALUES (@uid, @sourcePath, @dayKey, @section, @kind, @text, @textNorm, @ts, @lineStart,
               @lineEnd, @tags, @refs, @now, @now)
       ON CONFLICT(uid) DO UPDATE SET
         text = excluded.text,
         text_norm = excluded.text_norm,
         ts = excluded.ts,
         tags = excluded.tags,
         refs = excluded.refs,
         updated_at = excluded.updated_at`
    ).run({
      uid: row.uid,
      sourcePath: row.source_path,
      dayKey: row.day_key,
      section: row.section,
      kind: row.kind,
      text: row.text,
      textNorm: row.text_norm,
      ts: row.ts,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      tags: row.tags,
      refs: row.refs,
      now
    })
    db.prepare('DELETE FROM mem_deleted WHERE uid = ?').run(uid)
  })()
  return toItem(db.prepare('SELECT * FROM mem_items WHERE uid = ?').get(uid) as Row)
}

/** 回收站里有几条（界面显示「已删除 N 条」） */
export function countDeleted(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM mem_deleted').get() as { count: number }).count
}

function pruneDeleted(db: Db): void {
  db.prepare(
    `DELETE FROM mem_deleted WHERE uid IN (
       SELECT uid FROM mem_deleted ORDER BY deleted_at DESC, rowid DESC LIMIT -1 OFFSET ?
     )`
  ).run(DELETED_KEEP)
}

/* ------------------------------------------------------------------ */
/* 画像 / 观测                                                          */
/* ------------------------------------------------------------------ */

export function memoryStats(db: Db): MemoryStats {
  const total = (db.prepare('SELECT COUNT(*) AS count FROM mem_items').get() as { count: number }).count
  const dayRow = db
    .prepare('SELECT COUNT(DISTINCT day_key) AS days, MIN(day_key) AS first, MAX(day_key) AS last FROM mem_items')
    .get() as { days: number; first: string | null; last: string | null }
  const tasks = db
    .prepare(
      `SELECT
         SUM(CASE WHEN tags LIKE '%"open"%' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN tags LIKE '%"done"%' THEN 1 ELSE 0 END) AS done
       FROM mem_items WHERE kind = 'task'`
    )
    .get() as { open: number | null; done: number | null }

  const rows = db.prepare('SELECT day_key, tags, refs FROM mem_items').all() as Array<{
    day_key: string
    tags: string
    refs: string
  }>
  const tagCounts = new Map<string, { items: number; days: Set<string> }>()
  const refCounts = new Map<string, { items: number; days: Set<string> }>()
  for (const row of rows) {
    for (const tag of parseJsonArray(row.tags)) {
      if (tag === 'done' || tag === 'open') continue
      const entry = tagCounts.get(tag) ?? { items: 0, days: new Set<string>() }
      entry.items += 1
      entry.days.add(row.day_key)
      tagCounts.set(tag, entry)
    }
    for (const ref of parseJsonArray(row.refs)) {
      const entry = refCounts.get(ref) ?? { items: 0, days: new Set<string>() }
      entry.items += 1
      entry.days.add(row.day_key)
      refCounts.set(ref, entry)
    }
  }
  const top = (
    counts: Map<string, { items: number; days: Set<string> }>
  ): Array<{ name: string; items: number; days: number }> =>
    [...counts.entries()]
      .map(([name, entry]) => ({ name, items: entry.items, days: entry.days.size }))
      .sort((a, b) => b.days - a.days || b.items - a.items || a.name.localeCompare(b.name))
      .slice(0, 8)

  return {
    items: total,
    days: dayRow.days,
    firstDay: dayRow.first,
    lastDay: dayRow.last,
    streakDays: streakDays(db),
    tasks: { open: tasks.open ?? 0, done: tasks.done ?? 0 },
    topTags: top(tagCounts).map((entry) => ({ tag: entry.name, items: entry.items, days: entry.days })),
    topRefs: top(refCounts).map((entry) => ({ ref: entry.name, items: entry.items, days: entry.days }))
  }
}

/** 截至最后一条记录日的连续天数（中间断一天就停） */
function streakDays(db: Db): number {
  const days = (
    db.prepare('SELECT DISTINCT day_key FROM mem_items ORDER BY day_key DESC').all() as Array<{
      day_key: string
    }>
  ).map((row) => row.day_key)
  if (days.length === 0) return 0
  let streak = 1
  for (let index = 1; index < days.length; index += 1) {
    const prev = dayStartTs(days[index - 1])
    const curr = dayStartTs(days[index])
    if (prev === null || curr === null) break
    if (Math.round((prev - curr) / 86_400_000) !== 1) break
    streak += 1
  }
  return streak
}

/**
 * 生成 / 刷新「关于我」的观测。**只写可解释的统计**，不编心理分析：
 * 每条观测都能指回具体条目数 / 天数，用户看到数字就知道该不该信。
 */
export function buildMemoryProfile(db: Db, options: { now?: number } = {}): MemoryObservation[] {
  const now = options.now ?? nowMs()
  const statements = composeObservations(memoryStats(db))
  const upsert = db.prepare(
    `INSERT INTO mem_observations (uid, topic, statement, detail_json, source, confidence, status, created_at, updated_at)
     VALUES (@uid, @topic, @statement, @detail, 'stats', 1.0, 'active', @now, @now)
     ON CONFLICT(uid) DO UPDATE SET
       statement = excluded.statement,
       detail_json = excluded.detail_json,
       updated_at = excluded.updated_at,
       status = 'active'`
  )
  db.transaction(() => {
    for (const observation of statements) {
      upsert.run({
        uid: `stats:${observation.topic}`,
        topic: observation.topic,
        statement: observation.statement,
        detail: JSON.stringify(observation.detail),
        now
      })
    }
  })()

  return readObservations(db)
}

/**
 * 只读画像（问记忆的工具路径用）：**不落盘**，避免拿着只读连接去写。
 * 统计每次都现算，所以即使观测表还没生成过，也能给出可解释的结论。
 */
export function previewMemoryProfile(
  db: Db
): { stats: MemoryStats; observations: MemoryObservationView[] } {
  const stats = memoryStats(db)
  return {
    stats,
    observations: composeObservations(stats).map((item) => ({
      topic: item.topic,
      statement: item.statement
    }))
  }
}

export interface MemoryObservationView {
  topic: string
  statement: string
}

/** 统计 → 人话。纯函数，落盘与只读两条路径共用同一套措辞（口径不能分叉）。 */
function composeObservations(
  stats: MemoryStats
): Array<{ topic: string; statement: string; detail: unknown }> {
  const observations: Array<{ topic: string; statement: string; detail: unknown }> = []
  if (stats.items === 0) {
    observations.push({
      topic: 'overview',
      statement: '还没有同步到任何日记条目',
      detail: { items: 0 }
    })
    return observations
  }
  observations.push({
    topic: 'overview',
    statement: `日记里一共记下 ${stats.items} 条，覆盖 ${stats.days} 天（${stats.firstDay} 到 ${stats.lastDay}）`,
    detail: { items: stats.items, days: stats.days, first: stats.firstDay, last: stats.lastDay }
  })
  if (stats.streakDays > 1) {
    observations.push({
      topic: 'rhythm',
      statement: `到 ${stats.lastDay} 为止连续记了 ${stats.streakDays} 天`,
      detail: { streakDays: stats.streakDays }
    })
  }
  if (stats.topRefs.length > 0) {
    const top = stats.topRefs[0]
    observations.push({
      topic: 'topics',
      statement: `最常出现的双链是「${top.ref}」（${top.items} 条 / ${top.days} 天）`,
      detail: { refs: stats.topRefs }
    })
  }
  if (stats.topTags.length > 0) {
    const top = stats.topTags[0]
    observations.push({
      topic: 'tags',
      statement: `最常用的标签是 #${top.tag}（${top.items} 条 / ${top.days} 天）`,
      detail: { tags: stats.topTags }
    })
  }
  if (stats.tasks.open + stats.tasks.done > 0) {
    const rate = Math.round((stats.tasks.done / (stats.tasks.open + stats.tasks.done)) * 100)
    observations.push({
      topic: 'tasks',
      statement: `待办里已完成 ${stats.tasks.done} 条、还没勾 ${stats.tasks.open} 条（完成率 ${rate}%）`,
      detail: { ...stats.tasks, rate }
    })
  }
  return observations
}

/** 当前生效的观测（最近更新的在前） */
export function readObservations(db: Db, limit = 20): MemoryObservation[] {
  const rows = db
    .prepare(
      `SELECT uid, topic, statement, source, confidence, updated_at
       FROM mem_observations
       WHERE status = 'active'
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`
    )
    .all(limit) as Array<{
    uid: string
    topic: string
    statement: string
    source: string
    confidence: number
    updated_at: number
  }>
  return rows.map((row) => ({
    uid: row.uid,
    topic: row.topic,
    statement: row.statement,
    source: row.source,
    confidence: row.confidence,
    updatedAt: row.updated_at
  }))
}
