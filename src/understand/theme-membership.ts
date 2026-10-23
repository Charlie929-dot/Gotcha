/**
 * 主题成员回填：`nodes.source_events` → `theme_moments` 主归属（docs/m2-graph-redesign.md §4.5 第 2 步 / §5.3）
 *
 * - 存量主题不重新聚类：现有 owner 就是主归属，`source='owner'`、权重 1.0；
 * - 幂等：`INSERT OR IGNORE`（主键 theme_id+moment_id），重复跑只补新增；
 * - 只读 `events` 的 id → 时刻映射，不改写 `nodes` 与原事件；
 * - 事件找不到时刻（多半是漏跑时刻回填）与「没有任何归属的时刻」都如实计数，
 *   由调用方决定是否先补跑 `backfillAllMoments`。
 */

import type { Db } from '../db'
import { parseSourceEventIds } from './source-events'

export interface MembershipBackfillOptions {
  /** 写入 created_at 的时间；用例注入固定值 */
  now?: number
  /** 只处理这些主题 id（缺省全部 level=1 节点） */
  themeIds?: readonly number[]
}

export interface MembershipBackfillResult {
  /** 处理过的主题数 */
  themes: number
  /** 新写入的归属行数 */
  inserted: number
  /** 已存在而跳过的归属行数 */
  existing: number
  /** `source_events` 指向、但库里没有对应时刻的事件 id（去重升序，最多 200 个） */
  missingEventIds: number[]
  /** 缺失事件 id 总数（可能大于 missingEventIds.length） */
  missingEventCount: number
  /** 没有任何主题归属的时刻数 */
  orphanMoments: number
}

interface NodeRow {
  id: number
  source_events: string | null
}

interface MomentRow {
  id: number
  event_ids: string | null
}

/** 时刻表里 event_id → moment_id（一个事件只属于一个时刻；异常数据取先出现者） */
export function readEventMomentMap(db: Db): Map<number, number> {
  const rows = db.prepare('SELECT id, event_ids FROM moments').all() as MomentRow[]
  const map = new Map<number, number>()
  for (const row of rows) {
    for (const eventId of parseSourceEventIds(row.event_ids)) {
      if (!map.has(eventId)) map.set(eventId, row.id)
    }
  }
  return map
}

/** 没有任何归属的时刻（画布上会悬空；由补跑归属或人工合并解决） */
export function countOrphanMoments(db: Db): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM moments
       WHERE id NOT IN (SELECT moment_id FROM theme_moments)`
    )
    .get() as { n: number }
  return row.n
}

/** 缺失事件 id 的报错样本上限（只记 id，不记正文） */
const MISSING_EVENT_SAMPLE = 200

/**
 * 用 `source_events` 回填主归属（owner）。
 * `weights` 恒为 1.0：力布局等权，避免共享时刻把主题拉偏（§5.2 第 5 条）。
 */
export function backfillThemeMemberships(
  db: Db,
  options: MembershipBackfillOptions = {}
): MembershipBackfillResult {
  const now = options.now ?? Date.now()
  const nodes = selectNodes(db, options.themeIds)
  const eventToMoment = readEventMomentMap(db)

  const insert = db.prepare(
    `INSERT OR IGNORE INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (?, ?, 1.0, 'owner', ?)`
  )

  let inserted = 0
  let existing = 0
  const missing = new Set<number>()

  const run = db.transaction(() => {
    for (const node of nodes) {
      const eventIds = parseSourceEventIds(node.source_events)
      const momentIds = new Set<number>()
      for (const eventId of eventIds) {
        const momentId = eventToMoment.get(eventId)
        if (momentId === undefined) {
          missing.add(eventId)
          continue
        }
        momentIds.add(momentId)
      }
      for (const momentId of momentIds) {
        const changes = insert.run(node.id, momentId, now).changes
        if (changes > 0) inserted += 1
        else existing += 1
      }
    }
  })
  run()

  const missingAll = [...missing].sort((a, b) => a - b)
  return {
    themes: nodes.length,
    inserted,
    existing,
    missingEventIds: missingAll.slice(0, MISSING_EVENT_SAMPLE),
    missingEventCount: missingAll.length,
    orphanMoments: countOrphanMoments(db)
  }
}

function selectNodes(db: Db, themeIds?: readonly number[]): NodeRow[] {
  if (themeIds && themeIds.length > 0) {
    const ids = themeIds.filter((id) => Number.isInteger(id) && id > 0)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return db
      .prepare(
        `SELECT id, source_events FROM nodes WHERE level = 1 AND id IN (${placeholders}) ORDER BY id ASC`
      )
      .all(...ids) as NodeRow[]
  }
  return db
    .prepare('SELECT id, source_events FROM nodes WHERE level = 1 ORDER BY id ASC')
    .all() as NodeRow[]
}

/** 归属计数（成员数 / 主归属数 / 次归属数），供图谱统计与用例断言 */
export interface MembershipStats {
  rows: number
  owner: number
  secondary: number
  themes: number
  moments: number
}

export function readMembershipStats(db: Db): MembershipStats {
  const rows = db
    .prepare(
      `SELECT
         COUNT(*) AS rows,
         SUM(CASE WHEN source = 'owner' THEN 1 ELSE 0 END) AS owner,
         SUM(CASE WHEN source = 'secondary' THEN 1 ELSE 0 END) AS secondary,
         COUNT(DISTINCT theme_id) AS themes,
         COUNT(DISTINCT moment_id) AS moments
       FROM theme_moments`
    )
    .get() as {
    rows: number | null
    owner: number | null
    secondary: number | null
    themes: number | null
    moments: number | null
  }
  return {
    rows: rows.rows ?? 0,
    owner: rows.owner ?? 0,
    secondary: rows.secondary ?? 0,
    themes: rows.themes ?? 0,
    moments: rows.moments ?? 0
  }
}
