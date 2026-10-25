/**
 * 在线归属写库（M2 P2 · S6；docs/m2-graph-redesign.md §9.1）
 *
 * 把 S2（归属）、S4（命名 / 模糊确认）、S5（串行队列）落成真正的在线闭环里
 * **本地那一半**：选未归属时刻、落 `theme_moments`、建主题、把命名 / 确认结果写回节点。
 * 本模块不做出网调度（在 `theme-queue.ts`）、不读设置 / 不碰 Electron（在
 * `src/main/theme-online-runtime.ts`），只吃 `Db` + 已算好的向量与结果，便于单测。
 *
 * 三条硬约束：
 * - **不重复**：`theme_moments` 有行 = 这个时刻已经有归属，谁也别再写；
 *   批量归纳（补历史）按同一张表跳过（`cloud/batch.ts` 的 `readAssignedEventIds`）。
 * - **不丢追溯**：主归属写入时同步扩展节点 `ts_start/ts_end` 并把成员事件并进
 *   `source_events`（兼容字段，G1 的下钻 / 并集口径都读它）；次归属只写 `theme_moments`。
 * - **命名可补**：新主题先落本地兜底标题并打 `meta_json.namePending`，模型命名回来再覆盖；
 *   进程重启后 `selectPendingNameThemes()` 还能把它捞出来重排（队列在内存里，不能只靠内存）。
 *
 * 全程本地、零出网；本文件的日志 / 报错不含正文。
 */

import type { Db } from '../db'
import type { RedactableMoment } from './cloud/redact'
import type { Embedder } from './embedding/types'
import { embedEventVectors, readEventVectorsByIds, type EventEmbeddingResult } from './event-embeddings'
import { readMomentEventIdsFor } from './moments'
import { readOwnerMemberships } from './theme-membership'
import { parseSourceEventIds } from './source-events'
import { fallbackThemeName, type ThemeName, type ThemeNamingOutcome } from './theme-naming'
import type { AssignmentDecision, ConfirmTheme } from './theme-confirm'
import type { MomentAssignment } from './theme-assign'
import { refreshThemeCentroid } from './vector-maintenance'
import { truncateWithEllipsis } from './structure/schema'
import { computeMomentVectors, type ThemeCentroid } from './theme-centroids'

/** 在线路径只看最近这几天（与 `moment-runtime` 的回补上限对齐；更早的走「补历史」） */
export const ONLINE_MOMENT_LOOKBACK_DAYS = 2

/** 一轮最多处理多少个未归属时刻（embedding 是主进程开销，别一次扫太多） */
export const ONLINE_MAX_MOMENTS_PER_TICK = 20

/** 命名时最多带几个代表时刻（§9.1：只给代表时刻，不给整个主题） */
export const ONLINE_NAMING_MOMENTS = 3

/** 主题摘要 / 标题硬上限（与 `structure/schema.ts` 一致的存库口径） */
const NODE_TITLE_HARD_MAX = 40
const NODE_SUMMARY_HARD_MAX = 80

/**
 * 已合并节点跟随到存活根（合并只置 `merged_into`，不物理删）。
 * 循环上限 16 防环（坏数据；`theme-merge` 正常不会造环）；节点不存在 / 成环返回 null。
 */
export function resolveThemeRoot(db: Db, themeId: number): number | null {
  let current = Number.isInteger(themeId) && themeId > 0 ? themeId : 0
  if (current === 0) return null
  const read = db.prepare('SELECT merged_into FROM nodes WHERE id = ?')
  for (let depth = 0; depth < 16; depth += 1) {
    const row = read.get(current) as { merged_into: number | null } | undefined
    if (!row) return null
    if (row.merged_into === null) return current
    if (
      !Number.isInteger(row.merged_into) ||
      row.merged_into <= 0 ||
      row.merged_into === current
    ) {
      return null
    }
    current = row.merged_into
  }
  return null
}

export interface OnlineMoment {
  id: number
  startTs: number
  endTs: number
  dayKey: string
  app: string
  title: string
  ocr: string
  eventIds: number[]
}

interface MomentRow {
  id: number
  start_ts: number
  end_ts: number
  day_key: string
  app: string | null
  window_title: string | null
  ocr_summary: string | null
  event_ids: string | null
}

function toOnlineMoment(row: MomentRow): OnlineMoment {
  return {
    id: row.id,
    startTs: row.start_ts,
    endTs: row.end_ts,
    dayKey: row.day_key,
    app: row.app ?? '',
    title: row.window_title ?? '',
    ocr: row.ocr_summary ?? '',
    eventIds: parseSourceEventIds(row.event_ids)
  }
}

/** 出云 / 命名 / 确认共用的时刻形状（字段名与 `RedactableMoment` 对齐） */
export function toRedactableMoment(moment: OnlineMoment): RedactableMoment {
  return {
    app: moment.app,
    title: moment.title,
    startTs: moment.startTs,
    endTs: moment.endTs,
    ocr: moment.ocr,
    eventIds: [...moment.eventIds]
  }
}

/* ------------------------------------------------------------------ *
 * 选择：该处理哪些时刻 / 哪些主题还在等命名
 * ------------------------------------------------------------------ */

export interface SelectOnlineMomentsOptions {
  /** 只看 `start_ts >= since` 的时刻 */
  since: number
  /** 上限（缺省 `ONLINE_MAX_MOMENTS_PER_TICK`） */
  limit?: number
  /**
   * 已经进过节点 `source_events` 的事件（批量归纳先处理过的时刻）。
   * 这些时刻不再在线归属，否则同一段数据会被两条路径各建一次主题。
   */
  coveredEventIds?: ReadonlySet<number>
  /** 队列里已经在等确认的时刻（别重复入队 / 重复算） */
  excludeMomentIds?: ReadonlySet<number>
}

export interface SelectOnlineMomentsResult {
  moments: OnlineMoment[]
  /** 因为事件已被节点覆盖而跳过的时刻数 */
  skippedCovered: number
  /** 因为在队列里等确认而跳过的时刻数 */
  skippedPending: number
}

/**
 * 读「最近、还没有任何归属」的时刻（升序）。
 * 只按 `theme_moments` 判断是否有归属——这是 v3 的权威口径；`source_events` 只用于排除
 * 「批量归纳先到一步」的旧数据。
 */
export function selectOnlineMoments(
  db: Db,
  options: SelectOnlineMomentsOptions
): SelectOnlineMomentsResult {
  const limit = Math.max(1, Math.floor(options.limit ?? ONLINE_MAX_MOMENTS_PER_TICK))
  const pageSize = Math.max(limit * 2, 200)
  // 已被批量归纳覆盖的时刻会一直排在队首（它们仍是「未归属」），必须翻页往后找，
  // 否则模型就绪后的第一轮会被它们堵死、永远轮不到真正的新时刻。
  const maxScan = Math.max(pageSize * 5, 1_000)
  const statement = db.prepare(
    `SELECT m.id, m.start_ts, m.end_ts, m.day_key, m.app, m.window_title,
            m.ocr_summary, m.event_ids
       FROM moments m
      WHERE m.start_ts >= ?
        AND NOT EXISTS (SELECT 1 FROM theme_moments tm WHERE tm.moment_id = m.id)
      ORDER BY m.start_ts ASC, m.id ASC
      LIMIT ? OFFSET ?`
  )

  const moments: OnlineMoment[] = []
  let skippedCovered = 0
  let skippedPending = 0
  let offset = 0
  while (moments.length < limit && offset < maxScan) {
    const rows = statement.all(options.since, pageSize, offset) as MomentRow[]
    if (rows.length === 0) break
    offset += rows.length
    for (const row of rows) {
      if (moments.length >= limit) break
      const moment = toOnlineMoment(row)
      if (options.excludeMomentIds?.has(moment.id)) {
        skippedPending += 1
        continue
      }
      if (
        options.coveredEventIds &&
        moment.eventIds.some((id) => options.coveredEventIds!.has(id))
      ) {
        skippedCovered += 1
        continue
      }
      moments.push(moment)
    }
  }
  return { moments, skippedCovered, skippedPending }
}

/** 读一个时刻（写结果前复核用；不存在 / 已归属由调用方判断） */
export function readOnlineMoment(db: Db, momentId: number): OnlineMoment | null {
  const row = db
    .prepare(
      `SELECT id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids
         FROM moments WHERE id = ?`
    )
    .get(momentId) as MomentRow | undefined
  return row ? toOnlineMoment(row) : null
}

/** 这个时刻已经有归属了吗（任何 source 都算） */
export function momentHasMembership(db: Db, momentId: number): boolean {
  return (
    db.prepare('SELECT 1 AS ok FROM theme_moments WHERE moment_id = ? LIMIT 1').get(momentId) !==
    undefined
  )
}

/** `/ 在线命名` 的待办标记：只认本模块写的形状，不解析别人的 `meta_json` */
const NAME_PENDING_MARK = '"namePending":true'

/** 主题还没拿到模型命名（本地兜底标题已经落库） */
export function isNamePending(metaJson: string | null | undefined): boolean {
  return typeof metaJson === 'string' && metaJson.includes(NAME_PENDING_MARK)
}

/** 在线节点的 meta：保留一个可读的「还差命名」标记；命名回写后置 false */
export function onlineMetaJson(namePending: boolean): string {
  return JSON.stringify({ online: true, namePending })
}

/**
 * 还有哪些主题在等命名（升序）。进程重启后靠它把内存队列里丢掉的命名任务补回来——
 * 兜底标题一旦留在库上就再也不会被重命名，这条查询是唯一的找回入口。
 */
export function selectPendingNameThemes(db: Db, limit = 50): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM nodes
        WHERE level = 1 AND merged_into IS NULL
          AND meta_json LIKE ?
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(`%${NAME_PENDING_MARK}%`, Math.max(1, Math.floor(limit))) as Array<{ id: number }>
  return rows.map((row) => row.id)
}

/** 代表时刻（命名用）：该主题主归属时刻里最早的几个；坏数据跳过 */
export function readRepresentativeMoments(
  db: Db,
  themeId: number,
  limit = ONLINE_NAMING_MOMENTS
): OnlineMoment[] {
  const root = resolveThemeRoot(db, themeId)
  if (root === null) return []
  const rows = db
    .prepare(
      `SELECT m.id, m.start_ts, m.end_ts, m.day_key, m.app, m.window_title,
              m.ocr_summary, m.event_ids
         FROM theme_moments tm JOIN moments m ON m.id = tm.moment_id
        WHERE tm.theme_id = ? AND tm.source IN ('owner', 'manual')
        ORDER BY m.start_ts ASC, m.id ASC
        LIMIT ?`
    )
    .all(root, Math.max(1, Math.floor(limit))) as MomentRow[]
  return rows.map(toOnlineMoment)
}

/** 确认载荷里的候选主题（标题 / 摘要；已合并 / 受保护的不再作为候选） */
export function readConfirmThemes(db: Db, themeIds: readonly number[]): ConfirmTheme[] {
  const roots = [
    ...new Set(
      themeIds
        .map((id) => resolveThemeRoot(db, id))
        .filter((id): id is number => id !== null)
    )
  ]
  if (roots.length === 0) return []
  const rows = db
    .prepare(
      `SELECT id, title, summary FROM nodes
        WHERE id IN (${roots.map(() => '?').join(',')})
          AND level = 1 AND merged_into IS NULL AND IFNULL(type, '') <> 'protected'
        ORDER BY id ASC`
    )
    .all(...roots) as Array<{ id: number; title: string | null; summary: string | null }>
  return rows.map((row) => ({
    themeId: row.id,
    title: row.title ?? '',
    summary: row.summary ?? ''
  }))
}

/* ------------------------------------------------------------------ *
 * 本地归属写库
 * ------------------------------------------------------------------ */

/**
 * 主归属写库的公共部分：`theme_moments` 行 + 节点时间范围 + `source_events` 并集。
 * 只对主归属主题做并集（次归属只记关系，不把事件并进对方的兼容字段）。
 */
function attachMomentToTheme(db: Db, themeId: number, moment: OnlineMoment): void {
  const row = db
    .prepare('SELECT ts_start, ts_end, source_events FROM nodes WHERE id = ?')
    .get(themeId) as
    | { ts_start: number | null; ts_end: number | null; source_events: string | null }
    | undefined
  if (!row) return
  const ids = new Set(parseSourceEventIds(row.source_events))
  for (const id of moment.eventIds) ids.add(id)
  const tsStart =
    typeof row.ts_start === 'number' ? Math.min(row.ts_start, moment.startTs) : moment.startTs
  const tsEnd = typeof row.ts_end === 'number' ? Math.max(row.ts_end, moment.endTs) : moment.endTs
  db.prepare(
    `UPDATE nodes SET ts_start = ?, ts_end = ?, source_events = ? WHERE id = ?`
  ).run(tsStart, tsEnd, JSON.stringify([...ids].sort((a, b) => a - b)), themeId)
}

export interface PersistAssignmentResult {
  status: 'assigned' | 'no-moment' | 'no-theme'
  /** 真正写进去的主题根 id（owner 第一个，随后是次归属） */
  themeIds: number[]
}

/**
 * 落一条本地归属（owner + secondaries）。
 * 已合并的候选会解析到存活根；根不存在（脏引用）时返回 `no-theme`，不写半条。
 * 幂等：`INSERT OR IGNORE`，重复调用不会重复计数。
 */
export function persistAssignment(
  db: Db,
  momentId: number,
  assignment: Pick<MomentAssignment, 'owner' | 'secondaries'>,
  options: { now?: number } = {}
): PersistAssignmentResult {
  if (!assignment.owner) return { status: 'no-theme', themeIds: [] }
  const moment = readOnlineMoment(db, momentId)
  if (!moment) return { status: 'no-moment', themeIds: [] }
  const owner = resolveThemeRoot(db, assignment.owner.id)
  if (owner === null) return { status: 'no-theme', themeIds: [] }
  const roots: number[] = [owner]
  for (const secondary of assignment.secondaries) {
    const root = resolveThemeRoot(db, secondary.id)
    if (root !== null && !roots.includes(root)) roots.push(root)
  }
  const now = options.now ?? Date.now()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (?, ?, 1.0, ?, ?)`
  )
  const run = db.transaction(() => {
    insert.run(owner, momentId, 'owner', now)
    attachMomentToTheme(db, owner, moment)
    for (const root of roots.slice(1)) insert.run(root, momentId, 'secondary', now)
  })
  run()
  return { status: 'assigned', themeIds: roots }
}

export interface CreateOnlineThemeInput {
  moment: OnlineMoment
  /** 不传 = 本地兜底标题（并打上待命名标记） */
  name?: ThemeName
  /** 显式指定类型；缺省 activity */
  type?: string
  /** true = 还没命名，等队列回写（`fallbackThemeName` 生成的标题同样要等） */
  namePending?: boolean
  now?: number
}

export interface CreatedOnlineTheme {
  themeId: number
  name: ThemeName
  namePending: boolean
}

/**
 * 新建一个主题节点 + 它的主归属。
 * - 默认用 `fallbackThemeName()` 落一个本地标题（可读、可检索），同时打待命名标记：
 *   模型命名一旦回来就覆盖它；进程重启后 `selectPendingNameThemes()` 还能重排；
 * - 由模糊确认给出 `new_title` 时传 `name` + `namePending: false`，不再多花一次命名调用。
 */
export function createOnlineTheme(db: Db, input: CreateOnlineThemeInput): CreatedOnlineTheme {
  const moment = input.moment
  const name = input.name ?? fallbackThemeName([toRedactableMoment(moment)])
  const namePending = input.namePending ?? true
  const now = input.now ?? Date.now()
  const type = input.type ?? name.type
  let themeId = 0
  const run = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO nodes (level, type, title, summary, ts_start, ts_end, source_events, meta_json)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        type,
        truncateWithEllipsis(name.title, NODE_TITLE_HARD_MAX),
        truncateWithEllipsis(name.summary, NODE_SUMMARY_HARD_MAX),
        moment.startTs,
        moment.endTs,
        JSON.stringify([...moment.eventIds].sort((a, b) => a - b)),
        onlineMetaJson(namePending)
      )
    themeId = Number(result.lastInsertRowid)
    db.prepare(
      `INSERT OR IGNORE INTO theme_moments (theme_id, moment_id, weight, source, created_at)
       VALUES (?, ?, 1.0, 'owner', ?)`
    ).run(themeId, moment.id, now)
  })
  run()
  return { themeId, name, namePending }
}

/** 命名回写（命名队列回调）：标题 / 摘要 / 类型 + 清掉待命名标记 */
export type NamingApplyStatus = 'updated' | 'unchanged' | 'missing' | 'merged'

export function applyNamingToNode(
  db: Db,
  themeId: number,
  outcome: ThemeNamingOutcome
): NamingApplyStatus {
  const row = db
    .prepare('SELECT title, summary, type, merged_into, meta_json FROM nodes WHERE id = ?')
    .get(themeId) as
    | {
        title: string | null
        summary: string | null
        type: string | null
        merged_into: number | null
        meta_json: string | null
      }
    | undefined
  if (!row) return 'missing'
  if (row.merged_into !== null) {
    // 主题已经被合并：不能把名字写到旧行（存活行有自己的标题）；只清标记，别再来回排
    db.prepare('UPDATE nodes SET meta_json = ? WHERE id = ?').run(onlineMetaJson(false), themeId)
    return 'merged'
  }
  const title = truncateWithEllipsis(outcome.name.title, NODE_TITLE_HARD_MAX)
  const summary = truncateWithEllipsis(outcome.name.summary, NODE_SUMMARY_HARD_MAX)
  const changed =
    row.title !== title ||
    row.summary !== summary ||
    row.type !== outcome.name.type ||
    isNamePending(row.meta_json)
  db.prepare('UPDATE nodes SET title = ?, summary = ?, type = ?, meta_json = ? WHERE id = ?').run(
    title,
    summary,
    outcome.name.type,
    onlineMetaJson(false),
    themeId
  )
  return changed ? 'updated' : 'unchanged'
}

/** 确认结果里「模型建议新建」的标题：直接当名字用，不再排命名 */
function decisionThemeName(moment: OnlineMoment, title: string): ThemeName {
  return {
    title: truncateWithEllipsis(title.trim(), NODE_TITLE_HARD_MAX),
    summary: truncateWithEllipsis(
      `${moment.app || '未知应用'} · 模糊确认新建`,
      NODE_SUMMARY_HARD_MAX
    ),
    type: 'activity'
  }
}

export interface ApplyDecisionResult {
  status: 'assigned' | 'created' | 'skipped'
  themeIds: number[]
  /** 新建主题 id（status='created'） */
  createdThemeId?: number
}

/**
 * 落一条模糊确认结果。
 * - 模型选了候选主题 → 第一个当 owner，其余（≤2）当次归属；
 * - 只给了 `new_title` → 新建主题（不再花一次命名调用）；
 * - 两者都给 → 以候选主题为准，`new_title` 忽略（避免为同一时刻多建一个主题）；
 * - 时刻已经归属过（重试 / 并发）→ `skipped`，不覆盖。
 */
export function applyAssignmentDecision(
  db: Db,
  decision: AssignmentDecision,
  options: { now?: number } = {}
): ApplyDecisionResult {
  const moment = readOnlineMoment(db, decision.momentId)
  if (!moment) return { status: 'skipped', themeIds: [] }
  if (momentHasMembership(db, moment.id)) return { status: 'skipped', themeIds: [] }

  const roots: number[] = []
  for (const themeId of decision.themeIds) {
    const root = resolveThemeRoot(db, themeId)
    if (root !== null && !roots.includes(root)) roots.push(root)
  }
  if (roots.length > 0) {
    const persisted = persistAssignment(
      db,
      moment.id,
      {
        owner: { id: roots[0], sim: 0 },
        secondaries: roots.slice(1).map((id) => ({ id, sim: 0 }))
      },
      options
    )
    return { status: 'assigned', themeIds: persisted.themeIds }
  }

  const title = decision.newTitle?.trim()
  if (title) {
    const created = createOnlineTheme(db, {
      moment,
      name: decisionThemeName(moment, title),
      namePending: false,
      ...(options.now !== undefined ? { now: options.now } : {})
    })
    return { status: 'created', themeIds: [created.themeId], createdThemeId: created.themeId }
  }
  return { status: 'skipped', themeIds: [] }
}

/* ------------------------------------------------------------------ *
 * 向量增量：新时刻的事件向量 / 时刻质心 / 单个主题质心
 * ------------------------------------------------------------------ */

/** 给这些时刻的成员事件补算向量（在线路径的入口：它们还没被任何归属引用） */
export async function embedMomentEvents(
  db: Db,
  embedder: Embedder,
  moments: readonly OnlineMoment[],
  options: { now?: number } = {}
): Promise<EventEmbeddingResult> {
  const eventIds = [...new Set(moments.flatMap((moment) => moment.eventIds))]
  return embedEventVectors(db, embedder, {
    onlyMissing: true,
    eventIds,
    ...(options.now !== undefined ? { now: options.now } : {})
  })
}

/** 只算这些时刻的质心（成员事件向量均值 + L2） */
export function readMomentVectors(
  db: Db,
  momentIds: readonly number[],
  model: string
): Map<number, Float32Array> {
  const momentEventIds = readMomentEventIdsFor(db, momentIds)
  const eventIds = [...new Set([...momentEventIds.values()].flat())]
  const { vectors } = readEventVectorsByIds(db, eventIds, { model })
  return computeMomentVectors(momentEventIds, vectors)
}

/**
 * 只重算**一个**主题的质心（在线路径「新时刻归到这个主题」之后的最小增量）。
 * 与 `refreshThemeCentroid()` 的区别：只把该主题自己的成员事件向量读进来，
 * 不把整张 `event_embeddings` / `moments` 拉进内存（在线路径每 60s 跑一次）。
 */
export function refreshOnlineThemeCentroid(
  db: Db,
  themeId: number,
  options: { model: string; dim: number; now?: number }
): ThemeCentroid | null {
  const root = resolveThemeRoot(db, themeId)
  if (root === null) return null
  const memberships = readOwnerMemberships(db).filter((row) => row.themeId === root)
  if (memberships.length === 0) return null
  const momentIds = [...new Set(memberships.map((row) => row.momentId))]
  const momentEventIds = readMomentEventIdsFor(db, momentIds)
  const eventIds = [...new Set([...momentEventIds.values()].flat())]
  const { vectors, skipped } = readEventVectorsByIds(db, eventIds, { model: options.model })
  if (skipped > 0) {
    // 坏 BLOB 只影响这一行的统计，不阻塞归属
  }
  const result = refreshThemeCentroid(db, root, {
    model: options.model,
    dim: options.dim,
    memberships,
    momentEventIds,
    eventVectors: vectors,
    ...(options.now !== undefined ? { now: options.now } : {})
  })
  return result.centroid
}

/** 供运行时构造 `ConfirmMoment.candidateThemeIds`：top1 + top2（去重、最多 3 个） */
export function candidateThemeIds(assignment: MomentAssignment): number[] {
  const ids: number[] = []
  for (const scored of [assignment.top1, assignment.top2]) {
    if (!scored) continue
    if (!ids.includes(scored.id)) ids.push(scored.id)
  }
  return ids.slice(0, 3)
}
