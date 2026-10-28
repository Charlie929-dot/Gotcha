/**
 * 信息链 · 存储与查询（契约 §2 / §3 / §6 的最小闭环）
 *
 * 写入纪律（契约 v0.4）：
 * - 段：开段时**插入一行**（`closed=0`，`end_ts` 暂等于 `start_ts`），收口时**一次** UPDATE
 *   落定 `end_ts` / `active_ms` / `idle_ms` / `title_last` / `closed`；其余字段此后永不改。
 *   为什么不是「收口时再插」：子行（事件 / 截图 / 内容）要立刻拿到 `segment_id`，
 *   而一段可能长达数小时，全缓冲在内存里迟早丢东西。
 * - 事件 / 截图 / 内容：只有 INSERT。过期只置空载荷字段（§2.3），行与 id 永不删。
 * - 派生层（标签 / 双链 / 向量）不在这里写，可随时全删重建。
 *
 * 所有写入先过 `invariants.ts` 的校验；不合法就**抛错**，不修补、不降级。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { validateContent, validateSegment } from './invariants'
import { collectUrls, contentUrlsOf, decodeContentUrls, CONTENT_URLS_MAX } from './content/urls'
import {
  CHAIN_CONTENT_SOURCES,
  CHAIN_EVENT_KINDS,
  CHAIN_SHOT_SOURCES,
  CHAIN_SHOT_TIERS,
  type ChainContentRow,
  type ChainContentSource,
  type ChainEventKind,
  type ChainEventRow,
  type ChainSegmentRow,
  type ChainShotRow,
  type ChainShotSource,
  type ChainShotTier
} from './schema'
import type { SegmentDraft, SegmentOpenDraft } from './segmenter'

export type ChainDb = Database.Database

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期 `yyyy-mm-dd`（段按 `start_ts` 归日） */
export function dayKeyOf(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 内容指纹：去掉空白差异后的 sha256 前 16 位（判重 / 变化率用） */
export function contentHash(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function assertKind(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`${label}不合法：${value}`)
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 开段：插入一行 `closed=0` 的段。
 *
 * 同时挡住契约 §3 第 1 条（同一时刻最多一个段在占用）：已有开着的段、或与已收口段重叠，
 * 都直接抛错——这类错误必须暴露，不能靠「反正也是同一个窗口」糊过去。
 */
export function openSegment(db: ChainDb, draft: SegmentOpenDraft, now: number): number {
  if (!Number.isFinite(draft.startTs)) throw new Error('段缺少开始时间')
  const openCount = (db.prepare('SELECT COUNT(*) AS n FROM chain_segment WHERE closed = 0').get() as { n: number }).n
  if (openCount > 0) throw new Error('已有开着的段，不能同时开两段')

  const lastEnd = (db.prepare('SELECT MAX(end_ts) AS endTs FROM chain_segment WHERE closed = 1').get() as {
    endTs: number | null
  }).endTs
  if (lastEnd !== null && draft.startTs < lastEnd) {
    throw new Error(`新段开始 ${draft.startTs} 早于上一段结束 ${lastEnd}，段不能重叠`)
  }

  const result = db
    .prepare(
      `INSERT INTO chain_segment
         (start_ts, end_ts, active_ms, idle_ms, day_key, app, exe, pid, hwnd, title_first, title_last, created_at, closed)
       VALUES (@startTs, @startTs, 0, 0, @dayKey, @app, @exe, @pid, @hwnd, @title, @title, @now, 0)`
    )
    .run({
      startTs: draft.startTs,
      dayKey: dayKeyOf(draft.startTs),
      app: draft.app,
      exe: draft.exe,
      pid: draft.pid,
      hwnd: draft.hwnd,
      title: draft.title,
      now
    })
  return Number(result.lastInsertRowid)
}

/**
 * 收口：一次 UPDATE 落定时长与结束标题。
 *
 * 必须保证 **所有子行都落在 `[start_ts, end_ts]`**（契约 §3 第 3 条）。写入顺序上
 * 子行先来，所以这里比对子行最大时刻——比出来的问题就是段机与写入端不同步，得暴露。
 */
export function closeSegment(db: ChainDb, id: number, draft: SegmentDraft): void {
  const current = getSegment(db, id)
  if (!current) throw new Error(`段 ${id} 不存在`)
  if (current.closed === 1) throw new Error(`段 ${id} 已经收口，不能再收`)

  const row: ChainSegmentRow = {
    ...current,
    start_ts: draft.startTs,
    end_ts: draft.endTs,
    active_ms: draft.activeMs,
    idle_ms: draft.idleMs,
    title_first: draft.titleFirst,
    title_last: draft.titleLast,
    closed: 1
  }
  const problems = validateSegment(row)
  if (problems.length > 0) throw new Error(`段 ${id} 收口不合法：${problems.join('；')}`)

  const maxChild = (db
    .prepare(
      `SELECT MAX(ts) AS ts FROM (
         SELECT MAX(ts) AS ts FROM chain_event WHERE segment_id = @id
         UNION ALL SELECT MAX(ts) FROM chain_shot WHERE segment_id = @id
         UNION ALL SELECT MAX(captured_at) FROM chain_content WHERE segment_id = @id
       )`
    )
    .get({ id }) as { ts: number | null }).ts
  if (maxChild !== null && maxChild > draft.endTs) {
    throw new Error(`段 ${id} 的结束时间 ${draft.endTs} 早于它的子行 ${maxChild}`)
  }

  const result = db
    .prepare(
      `UPDATE chain_segment
          SET end_ts = @endTs, active_ms = @activeMs, idle_ms = @idleMs, title_last = @titleLast, closed = 1
        WHERE id = @id AND closed = 0`
    )
    .run({ id, endTs: draft.endTs, activeMs: draft.activeMs, idleMs: draft.idleMs, titleLast: draft.titleLast })
  if (result.changes !== 1) throw new Error(`段 ${id} 收口没有生效`)
}

export interface NewChainEvent {
  segmentId: number
  ts: number
  kind: ChainEventKind
  x?: number | null
  y?: number | null
  delta?: number | null
}

export function insertEvent(db: ChainDb, input: NewChainEvent): number {
  assertKind(input.kind, CHAIN_EVENT_KINDS, '事件类型')
  const segment = requireSegment(db, input.segmentId)
  assertWithinSegment(segment, input.ts, '事件')

  const result = db
    .prepare(
      `INSERT INTO chain_event (segment_id, ts, kind, x, y, delta)
       VALUES (@segmentId, @ts, @kind, @x, @y, @delta)`
    )
    .run({
      segmentId: input.segmentId,
      ts: input.ts,
      kind: input.kind,
      x: input.x ?? null,
      y: input.y ?? null,
      delta: input.delta ?? null
    })
  return Number(result.lastInsertRowid)
}

export interface NewChainShot {
  segmentId: number
  eventId?: number | null
  ts: number
  path?: string | null
  width?: number | null
  height?: number | null
  bytes?: number | null
  source: ChainShotSource
  tier?: ChainShotTier
  container?: string | null
}

export function insertShot(db: ChainDb, input: NewChainShot): number {
  assertKind(input.source, CHAIN_SHOT_SOURCES, '截图来源')
  const tier = input.tier ?? 'hot'
  assertKind(tier, CHAIN_SHOT_TIERS, '截图层级')

  const segment = requireSegment(db, input.segmentId)
  assertWithinSegment(segment, input.ts, '截图')

  const eventId = input.eventId ?? null
  if (eventId !== null) {
    const event = db.prepare('SELECT id, segment_id FROM chain_event WHERE id = ?').get(eventId) as
      | { id: number; segment_id: number }
      | undefined
    if (!event) throw new Error(`截图挂的事件 ${eventId} 不存在`)
    if (event.segment_id !== input.segmentId) throw new Error('截图与它的事件不属于同一段')
  }

  const result = db
    .prepare(
      `INSERT INTO chain_shot (segment_id, event_id, ts, path, width, height, bytes, source, tier, container)
       VALUES (@segmentId, @eventId, @ts, @path, @width, @height, @bytes, @source, @tier, @container)`
    )
    .run({
      segmentId: input.segmentId,
      eventId,
      ts: input.ts,
      path: input.path ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      bytes: input.bytes ?? null,
      source: input.source,
      tier,
      container: input.container ?? null
    })
  return Number(result.lastInsertRowid)
}

export interface NewChainContent {
  segmentId: number
  capturedAt: number
  source: ChainContentSource
  text: string
  /** 缺省按正文算 */
  hash?: string
}

export function insertContent(db: ChainDb, input: NewChainContent): number {
  assertKind(input.source, CHAIN_CONTENT_SOURCES, '内容来源')
  const segment = requireSegment(db, input.segmentId)
  assertWithinSegment(segment, input.capturedAt, '内容')

  const row: ChainContentRow = {
    id: 0,
    segment_id: input.segmentId,
    captured_at: input.capturedAt,
    source: input.source,
    text: input.text,
    chars: input.text.length,
    hash: input.hash ?? contentHash(input.text)
  }
  const problems = validateContent(row)
  if (problems.length > 0) throw new Error(`内容不合法：${problems.join('；')}`)

  const result = db
    .prepare(
      `INSERT INTO chain_content (segment_id, captured_at, source, text, chars, hash, urls)
       VALUES (@segmentId, @capturedAt, @source, @text, @chars, @hash, @urls)`
    )
    .run({
      segmentId: row.segment_id,
      capturedAt: row.captured_at,
      source: row.source,
      text: row.text,
      chars: row.chars,
      hash: row.hash,
      urls: contentUrlsOf(row.text)
    })
  return Number(result.lastInsertRowid)
}

function requireSegment(db: ChainDb, id: number): ChainSegmentRow {
  const row = getSegment(db, id)
  if (!row) throw new Error(`段 ${id} 不存在`)
  return row
}

/** 段还开着时只要求「不在开始之前」；收口后要求落在闭区间内 */
function assertWithinSegment(segment: ChainSegmentRow, ts: number, label: string): void {
  if (ts < segment.start_ts) throw new Error(`${label}时刻 ${ts} 早于段开始 ${segment.start_ts}`)
  if (segment.closed === 1 && ts > segment.end_ts) {
    throw new Error(`${label}时刻 ${ts} 晚于段结束 ${segment.end_ts}`)
  }
}

/* ------------------------------------------------------------------ */
/* 崩溃收尾                                                            */
/* ------------------------------------------------------------------ */

/**
 * 启动时收尾：把上次异常退出留下的 `closed=0` 段按「最后一个子行时刻」收口。
 *
 * 崩溃时段的真实结束时刻已经不可知，所以不编造：结束时间取最后一个子行，
 * `idle_ms` 记 0（无法还原空闲洞），`title_last` 沿用已知标题。
 */
export function finalizeAbandonedSegments(db: ChainDb): number {
  const open = db.prepare('SELECT * FROM chain_segment WHERE closed = 0 ORDER BY id').all() as ChainSegmentRow[]
  if (open.length === 0) return 0

  const update = db.prepare(
    `UPDATE chain_segment
        SET end_ts = @endTs, active_ms = @endTs - start_ts, idle_ms = 0, title_last = @titleLast, closed = 1
      WHERE id = @id AND closed = 0`
  )
  const run = db.transaction((rows: ChainSegmentRow[]) => {
    for (const row of rows) {
      const lastChild =
        (db
          .prepare(
            `SELECT MAX(ts) AS ts FROM (
               SELECT MAX(ts) AS ts FROM chain_event WHERE segment_id = @id
               UNION ALL SELECT MAX(ts) FROM chain_shot WHERE segment_id = @id
               UNION ALL SELECT MAX(captured_at) FROM chain_content WHERE segment_id = @id
             )`
          )
          .get({ id: row.id }) as { ts: number | null }).ts ?? row.start_ts
      update.run({ id: row.id, endTs: Math.max(row.start_ts, lastChild), titleLast: row.title_first })
    }
  })
  run(open)
  return open.length
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export interface SegmentFilter {
  /** 闭区间 */
  from?: number
  to?: number
  dayKey?: string
  /** 段应用名（`chain_segment.app`） */
  app?: string
  /** 进程名（小写） */
  exe?: string
  /** 默认只看已收口的段 */
  includeOpen?: boolean
  limit?: number
}

const SEGMENT_COLUMNS = `id, start_ts, end_ts, active_ms, idle_ms, day_key, app, exe, pid, hwnd, title_first, title_last, created_at, closed`

export function getSegment(db: ChainDb, id: number): ChainSegmentRow | null {
  const row = db.prepare(`SELECT ${SEGMENT_COLUMNS} FROM chain_segment WHERE id = ?`).get(id)
  return (row as ChainSegmentRow | undefined) ?? null
}

/**
 * 按时间 / 应用查段，按开始时间倒序（新的在前）。
 *
 * 开着的段 `end_ts` 只是暂定值，所以时间过滤对它用「`start_ts` 落在范围内」，
 * 不拿未落定的结束时间去卡。
 */
export function querySegments(db: ChainDb, filter: SegmentFilter = {}): ChainSegmentRow[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (filter.includeOpen !== true) where.push('closed = 1')
  if (filter.dayKey !== undefined) {
    where.push('day_key = @dayKey')
    params.dayKey = filter.dayKey
  }
  if (filter.from !== undefined) {
    // 与 [from, to] 有交集的段都要：开着的段结束时间未定，一律算在内
    where.push('(closed = 0 OR end_ts >= @from)')
    params.from = filter.from
  }
  if (filter.to !== undefined) {
    where.push('start_ts <= @to')
    params.to = filter.to
  }
  if (filter.app !== undefined) {
    where.push('app = @app')
    params.app = filter.app
  }
  if (filter.exe !== undefined) {
    where.push('exe = @exe')
    params.exe = filter.exe
  }

  const limit = Math.max(1, filter.limit ?? 200)
  const sql = `SELECT ${SEGMENT_COLUMNS} FROM chain_segment
               ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY start_ts DESC, id DESC
               LIMIT ${limit}`
  return db.prepare(sql).all(params) as ChainSegmentRow[]
}

export function listEvents(db: ChainDb, segmentId: number): ChainEventRow[] {
  return db
    .prepare('SELECT id, segment_id, ts, kind, x, y, delta FROM chain_event WHERE segment_id = ? ORDER BY ts ASC, id ASC')
    .all(segmentId) as ChainEventRow[]
}

const SHOT_COLUMNS = `id, segment_id, event_id, ts, path, width, height, bytes, source, tier, container`

export function listShots(db: ChainDb, segmentId: number): ChainShotRow[] {
  return db
    .prepare(`SELECT ${SHOT_COLUMNS} FROM chain_shot WHERE segment_id = ? ORDER BY ts ASC, id ASC`)
    .all(segmentId) as ChainShotRow[]
}

/**
 * 保留期扫描：比 `beforeTs` 老的截图，外加**还停留在 hot 层的 PNG**（采集编码改 JPEG
 * 之前写下的老行，年龄再轻也要归一化——否则 hot 里永远混着两种格式）。
 */
export function selectShotsForRetention(db: ChainDb, beforeTs: number): ChainShotRow[] {
  return db
    .prepare(
      `SELECT ${SHOT_COLUMNS} FROM chain_shot
        WHERE ts < @beforeTs OR (tier = 'hot' AND path LIKE '%.png')
        ORDER BY ts ASC, id ASC`
    )
    .all({ beforeTs }) as ChainShotRow[]
}

/** 已经在某个归档容器里的截图（升级 cold → archive 时要连它们一起重建） */
export function listShotsInContainer(db: ChainDb, container: string): ChainShotRow[] {
  return db
    .prepare(`SELECT ${SHOT_COLUMNS} FROM chain_shot WHERE container = ? ORDER BY ts ASC, id ASC`)
    .all(container) as ChainShotRow[]
}

/** 保留期对一行的更新（唯一允许改 `tier` / `container` / `path` / `bytes` / `width` / `height` 的入口） */
export interface ShotRetentionUpdate {
  id: number
  tier: ChainShotTier
  path: string | null
  container: string | null
  width: number | null
  height: number | null
  bytes: number | null
}

/**
 * 批量的保留期更新（一个事务）。
 *
 * 状态一致性由这里把关（契约 §3 第 6 条的保留期例外）：
 * hot / warm 必须在原文件上（`path` 非空、`container` 为空）；
 * cold / archive 必须在容器里（`container` 非空、`path` 置空）。写不进去就抛错，不修补。
 */
export function updateShotRetention(db: ChainDb, updates: readonly ShotRetentionUpdate[]): void {
  if (updates.length === 0) return
  for (const update of updates) {
    assertKind(update.tier, CHAIN_SHOT_TIERS, '截图层级')
    const archived = update.tier === 'cold' || update.tier === 'archive'
    if (archived && (update.container === null || update.path !== null)) {
      throw new Error(`截图 ${update.id} 在 ${update.tier} 层必须只有容器路径、没有文件路径`)
    }
    if (!archived && (update.container !== null || update.path === null)) {
      throw new Error(`截图 ${update.id} 在 ${update.tier} 层必须有文件路径、不能挂容器`)
    }
    if (update.bytes !== null && (!Number.isInteger(update.bytes) || update.bytes < 0)) {
      throw new Error(`截图 ${update.id} 的字节数非法：${String(update.bytes)}`)
    }
  }

  const statement = db.prepare(
    `UPDATE chain_shot
        SET tier = @tier, path = @path, container = @container,
            width = @width, height = @height, bytes = @bytes
      WHERE id = @id`
  )
  const run = db.transaction((rows: ShotRetentionUpdate[]) => {
    for (const update of rows) {
      const result = statement.run({
        id: update.id,
        tier: update.tier,
        path: update.path,
        container: update.container,
        width: update.width,
        height: update.height,
        bytes: update.bytes
      })
      if (result.changes !== 1) throw new Error(`截图 ${update.id} 不存在，保留期更新失败`)
    }
  })
  run(updates as ShotRetentionUpdate[])
}

export function listContents(db: ChainDb, segmentId: number): ChainContentRow[] {
  return db
    .prepare(
      `SELECT id, segment_id, captured_at, source, text, chars, hash
         FROM chain_content WHERE segment_id = ? ORDER BY captured_at ASC, id ASC`
    )
    .all(segmentId) as ChainContentRow[]
}

export interface SegmentDetail {
  segment: ChainSegmentRow
  events: ChainEventRow[]
  shots: ChainShotRow[]
  contents: ChainContentRow[]
}

/**
 * `chain_content.urls` 是否就位（chain v4 迁移前的老库没有这一列）。
 *
 * 只缓存**肯定**结果：否定结果每次都重新探测——同一个连接上「先查了没列的库、随后
 * `ensureChainSchema` 补了列」是真实会发生的顺序（启动时迁移、只读脚本先开连接），
 * 缓存住 false 会让之后所有检索一直走慢路径。
 */
const contentUrlsReady = new WeakMap<object, true>()

function hasContentUrls(db: ChainDb): boolean {
  if (contentUrlsReady.get(db)) return true
  let ready = false
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('chain_content')").all() as Array<{
      name: string
    }>
    ready = columns.some((column) => column.name === 'urls')
  } catch {
    ready = false
  }
  if (ready) contentUrlsReady.set(db, true)
  return ready
}

/**
 * 只读这些段的网址（去重、按内容时间顺序、最多 `CONTENT_URLS_MAX` 条）。
 *
 * 性能方案 P1-6：`search_info` 以前为抽网址把每条命中段的**整段正文**取回内存
 * （limit 8 时 2.3 MB、19 ms）。网址在写入时已落到 `chain_content.urls`，这里只读几十字节。
 * 老库（v4 之前）没有这一列时退回现场扫正文，口径不变。
 */
export function listSegmentUrls(db: ChainDb, segmentIds: readonly number[]): Map<number, string[]> {
  const ids = [...new Set(segmentIds.filter((id) => Number.isInteger(id) && id > 0))]
  const result = new Map<number, string[]>()
  if (ids.length === 0) return result
  const withUrls = hasContentUrls(db)
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400)
    if (!withUrls) {
      const rows = db
        .prepare(
          `SELECT segment_id, text FROM chain_content
            WHERE segment_id IN (${chunk.map(() => '?').join(',')})
            ORDER BY captured_at ASC, id ASC`
        )
        .all(...chunk) as Array<{ segment_id: number; text: string }>
      for (const row of rows) {
        const urls = result.get(row.segment_id) ?? []
        collectUrls([row.text], urls)
        result.set(row.segment_id, urls)
      }
      continue
    }
    const rows = db
      .prepare(
        `SELECT segment_id, urls FROM chain_content
          WHERE segment_id IN (${chunk.map(() => '?').join(',')})
          ORDER BY captured_at ASC, id ASC`
      )
      .all(...chunk) as Array<{ segment_id: number; urls: string | null }>
    for (const row of rows) {
      const current = result.get(row.segment_id) ?? []
      for (const url of decodeContentUrls(row.urls)) {
        if (current.includes(url)) continue
        if (current.length >= CONTENT_URLS_MAX) break
        current.push(url)
      }
      result.set(row.segment_id, current)
    }
  }
  return result
}

/**
 * 只读这些段「最长那条正文」的开头（兜底摘要用）。
 *
 * `getSegmentDetail` 里兜底摘要取的是正文最长那行（`chars` 最大）的前几十字，
 * 所以这里只要 `substr(text, 1, chars)`，不把整段正文拉进内存。
 */
export function listSegmentLongestHeads(
  db: ChainDb,
  segmentIds: readonly number[],
  headChars = 2000
): Map<number, string> {
  const ids = [...new Set(segmentIds.filter((id) => Number.isInteger(id) && id > 0))]
  const result = new Map<number, string>()
  if (ids.length === 0) return result
  const limit = Math.max(1, Math.floor(headChars))
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400)
    // 先只按元数据排名（不碰 text），再回表取那几行的开头：
    // 直接在窗口函数里 SELECT text 会让 SQLite 把每条正文都读出来（等于旧路径），
    // 排名只用 chars / captured_at / id 就便宜得多。
    const rows = db
      .prepare(
        `WITH picked AS (
           SELECT id FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY segment_id ORDER BY chars DESC, captured_at ASC, id ASC
                    ) AS rn
               FROM chain_content
              WHERE segment_id IN (${chunk.map(() => '?').join(',')})
           )
           WHERE rn = 1
         )
         SELECT c.segment_id, substr(c.text, 1, ?) AS head
           FROM chain_content c JOIN picked ON picked.id = c.id`
      )
      .all(...chunk, limit) as Array<{ segment_id: number; head: string | null }>
    for (const row of rows) {
      if (typeof row.head === 'string') result.set(row.segment_id, row.head)
    }
  }
  return result
}

/** 段 → 事件 / 截图 / 内容，一次取全（契约 §6 的反查方向） */
export function getSegmentDetail(db: ChainDb, id: number): SegmentDetail | null {
  const segment = getSegment(db, id)
  if (!segment) return null
  return {
    segment,
    events: listEvents(db, id),
    shots: listShots(db, id),
    contents: listContents(db, id)
  }
}

export interface ContentHit extends ChainContentRow {
  segment_start: number
  segment_end: number
  segment_app: string | null
  segment_title: string | null
}

/**
 * 按正文找内容（`LIKE`，够用就好，不引全文索引）。
 *
 * `%` / `_` 按字面匹配；命中按时间倒序，附上它所属段的起止与应用，
 * 这样「找到一句话 → 回到那一刻」不用再查一次。
 */
export function searchContents(db: ChainDb, keyword: string, limit = 50, from?: number, to?: number): ContentHit[] {
  const trimmed = keyword.trim()
  if (trimmed === '') return []
  const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)
  const where = [`c.text LIKE @pattern ESCAPE '\\'`]
  const params: Record<string, unknown> = { pattern: `%${escaped}%`, limit: Math.max(1, limit) }
  if (from !== undefined) {
    where.push('s.start_ts >= @from')
    params.from = from
  }
  if (to !== undefined) {
    where.push('s.start_ts <= @to')
    params.to = to
  }
  return db
    .prepare(
      `SELECT c.id, c.segment_id, c.captured_at, c.source, c.text, c.chars, c.hash,
              s.start_ts AS segment_start, s.end_ts AS segment_end,
              s.app AS segment_app, s.title_first AS segment_title
         FROM chain_content c
         JOIN chain_segment s ON s.id = c.segment_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.start_ts DESC, c.captured_at DESC
        LIMIT @limit`
    )
    .all(params) as ContentHit[]
}

export interface AppUsage {
  app: string | null
  segments: number
  active_ms: number
}

export interface DaySummary {
  dayKey: string
  segments: number
  active_ms: number
  idle_ms: number
  events: number
  shots: number
  apps: AppUsage[]
}

/** 某天的段 / 事件 / 截图总量与按应用分布（查「今天记了什么」用） */
export function daySummary(db: ChainDb, dayKey: string): DaySummary {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS segments,
              COALESCE(SUM(active_ms), 0) AS activeMs,
              COALESCE(SUM(idle_ms), 0) AS idleMs
         FROM chain_segment WHERE day_key = ? AND closed = 1`
    )
    .get(dayKey) as { segments: number; activeMs: number; idleMs: number }

  const child = (table: string): number =>
    (db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE segment_id IN
           (SELECT id FROM chain_segment WHERE day_key = ? AND closed = 1)`
      )
      .get(dayKey) as { n: number }).n

  const apps = db
    .prepare(
      `SELECT app, COUNT(*) AS segments, COALESCE(SUM(active_ms), 0) AS activeMs
         FROM chain_segment WHERE day_key = ? AND closed = 1
        GROUP BY app ORDER BY activeMs DESC, segments DESC`
    )
    .all(dayKey) as Array<{ app: string | null; segments: number; activeMs: number }>

  return {
    dayKey,
    segments: totals.segments,
    active_ms: totals.activeMs,
    idle_ms: totals.idleMs,
    events: child('chain_event'),
    shots: child('chain_shot'),
    apps: apps.map((row) => ({ app: row.app, segments: row.segments, active_ms: row.activeMs }))
  }
}

/** 已收口的段是否两两不重叠（自检用；正常写入路径下必须为空） */
export function findSegmentOverlaps(db: ChainDb): Array<[number, number]> {
  const rows = db
    .prepare('SELECT id, start_ts, end_ts FROM chain_segment WHERE closed = 1 ORDER BY start_ts ASC, id ASC')
    .all() as Array<{ id: number; start_ts: number; end_ts: number }>
  const overlaps: Array<[number, number]> = []
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].start_ts < rows[index - 1].end_ts) overlaps.push([rows[index - 1].id, rows[index].id])
  }
  return overlaps
}
