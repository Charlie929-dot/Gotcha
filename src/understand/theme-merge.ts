/**
 * 主题合并落库与撤销（docs/m2-graph-redesign.md §5.1）
 *
 * - 合并 = 并集 `theme_moments`、扩 ts 区间、并集 `source_events`（兼容字段）、摘要取长；
 * - 存活节点（`into`）保留 id / 位置 / 标题；源节点不物理删除，只置 `merged_into`；
 * - 一次计划里的多个源节点共享一个 `group_id`：撤销按组进行，避免只撤销一半导致 into 的
 *   字段/归属与剩余源节点不一致；
 * - `node_merges.before_json` 存合并前的节点字段与归属快照，`revertThemeMerge` 精确回滚；
 * - 合并会让 into 的摘要/成员变化：删除相关节点的 `node_embeddings` / `theme_centroids`，
 *   由下一次回填重算（标题向量用于连线、质心用于合并判定，口径不同）；
 * - 旧 `kind='ai'` 边不动；只删受影响的 `kind='embedding'` 边，统一由回填重建。
 */

import type { Db } from '../db'
import { parseSourceEventIds } from './source-events'
import type { ThemeMergePlan } from './theme-centroids'

interface NodeRow {
  id: number
  type: string | null
  title: string | null
  summary: string | null
  ts_start: number | null
  ts_end: number | null
  source_events: string | null
  merged_into: number | null
}

interface MembershipRow {
  moment_id: number
  weight: number | null
  source: string | null
  created_at: number | null
}

interface NodeSnapshot {
  id: number
  type: string | null
  title: string | null
  summary: string | null
  tsStart: number | null
  tsEnd: number | null
  sourceEvents: string | null
}

interface MembershipSnapshot {
  momentId: number
  weight: number
  source: string
  createdAt: number
}

/** `node_merges.before_json` 的结构（版本化，便于以后兼容） */
interface MergeBefore {
  version: 1
  into: NodeSnapshot
  /** 本行对应的那个源节点（一次计划里每个源节点一行，共享 group_id） */
  from: NodeSnapshot & {
    /** 迁移到 into 的归属（撤销时删 into 的副本并写回源节点） */
    memberships: MembershipSnapshot[]
    /** into 原本已有该时刻：记下原 source，撤销时改回（并写回源节点的归属） */
    conflicts: Array<{ intoSource: string; membership: MembershipSnapshot }>
  }
}

export interface ThemeMergeReport {
  plans: number
  applied: number
  skipped: number
  mergedNodes: number
  movedMemberships: number
  /** 与 into 已有归属冲突的行数（保留 into 的那条，不重复写） */
  droppedMemberships: number
  /** 需要重算向量/质心的节点（into + from） */
  touched: number[]
  merges: Array<{ groupId: number; into: number; from: number[] }>
}

/** 设置抽屉「合并记录」里的一行：一次合并（同 group_id）的存活主题与源主题 */
export interface ThemeMergeGroupView {
  groupId: number
  into: { id: number; title: string }
  from: Array<{ id: number; title: string }>
  mergedAt: number
}

const TITLE_FALLBACK = '（无标题）'

const NODE_COLUMNS =
  'id, type, title, summary, ts_start, ts_end, source_events, merged_into'

function readNode(db: Db, id: number): NodeRow | undefined {
  return db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`).get(id) as NodeRow | undefined
}

/**
 * 这对 (from, into) 是否被人工撤销过——撤销即「以后别再自动合并这两个」。
 * 只看**最近一次**涉及这对的合并记录：若它是撤销过的，就一直否决，直到数据被重新合并
 * （重新合并需要用户手动/以后的重合并入口）；这样「撤销」不会在下次回填里被立刻合回去。
 */
export function isMergeVetoed(db: Db, fromNode: number, intoNode: number): boolean {
  const latest = db
    .prepare(
      `SELECT reverted_at FROM node_merges
       WHERE (from_node = ? AND into_node = ?) OR (from_node = ? AND into_node = ?)
       ORDER BY merged_at DESC, id DESC LIMIT 1`
    )
    .get(fromNode, intoNode, intoNode, fromNode) as { reverted_at: number | null } | undefined
  return latest !== undefined && latest.reverted_at !== null
}

/** 未撤销的合并记录（新到旧），供设置抽屉「合并记录」列出来并逐条撤销 */
export function listThemeMerges(db: Db, limit = 20): ThemeMergeGroupView[] {
  const groupRows = db
    .prepare(
      `SELECT group_id, MAX(merged_at) AS merged_at FROM node_merges
       WHERE reverted_at IS NULL
       GROUP BY group_id
       ORDER BY merged_at DESC, group_id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ group_id: number; merged_at: number }>
  if (groupRows.length === 0) return []

  const groupIds = groupRows.map((row) => row.group_id)
  const rows = db
    .prepare(
      `SELECT id, group_id, from_node, into_node, merged_at FROM node_merges
       WHERE reverted_at IS NULL AND group_id IN (${groupIds.map(() => '?').join(',')})
       ORDER BY id ASC`
    )
    .all(...groupIds) as Array<{
    id: number
    group_id: number
    from_node: number
    into_node: number
    merged_at: number
  }>

  const nodeIds = new Set<number>()
  for (const row of rows) {
    nodeIds.add(row.from_node)
    nodeIds.add(row.into_node)
  }
  const titles = new Map<number, string>()
  const titleRows = db
    .prepare(`SELECT id, title FROM nodes WHERE id IN (${[...nodeIds].map(() => '?').join(',')})`)
    .all(...nodeIds) as Array<{ id: number; title: string | null }>
  for (const row of titleRows) {
    const title = (row.title ?? '').trim()
    titles.set(row.id, title === '' ? TITLE_FALLBACK : title)
  }

  const groups = new Map<number, ThemeMergeGroupView>()
  for (const row of rows) {
    const existing = groups.get(row.group_id)
    const into = { id: row.into_node, title: titles.get(row.into_node) ?? TITLE_FALLBACK }
    const from = { id: row.from_node, title: titles.get(row.from_node) ?? TITLE_FALLBACK }
    if (existing) {
      existing.from.push(from)
      continue
    }
    groups.set(row.group_id, { groupId: row.group_id, into, from: [from], mergedAt: row.merged_at })
  }

  // 输出顺序跟群组顺序（新到旧）
  return groupRows
    .map((row) => groups.get(row.group_id))
    .filter((group): group is ThemeMergeGroupView => group !== undefined)
}

function snapshotOf(row: NodeRow): NodeSnapshot {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    tsStart: row.ts_start,
    tsEnd: row.ts_end,
    sourceEvents: row.source_events
  }
}

function unionEventIds(rows: readonly NodeRow[]): string {
  const ids = new Set<number>()
  for (const row of rows) {
    for (const id of parseSourceEventIds(row.source_events)) ids.add(id)
  }
  return JSON.stringify([...ids].sort((a, b) => a - b))
}

/** 摘要取长（长度相同取 into 的；都为空保留 into 的空串） */
function pickSummary(into: NodeRow, from: readonly NodeRow[]): string {
  let best = into.summary ?? ''
  for (const row of from) {
    const candidate = row.summary ?? ''
    if (candidate.trim().length > best.trim().length) best = candidate
  }
  return best
}

function minTs(rows: readonly NodeRow[]): number | null {
  let min: number | null = null
  for (const row of rows) {
    if (typeof row.ts_start !== 'number') continue
    if (min === null || row.ts_start < min) min = row.ts_start
  }
  return min
}

function maxTs(rows: readonly NodeRow[]): number | null {
  let max: number | null = null
  for (const row of rows) {
    if (typeof row.ts_end !== 'number') continue
    if (max === null || row.ts_end > max) max = row.ts_end
  }
  return max
}

/**
 * 应用合并计划（单事务，全部成功或全部回滚）。
 * 计划引用不存在的节点 / 类型不一致 / 节点重复出现在多个计划时跳过该计划（报告计数，不抛错）。
 */
export function applyThemeMerges(
  db: Db,
  plans: readonly ThemeMergePlan[],
  options: { now?: number } = {}
): ThemeMergeReport {
  const now = options.now ?? Date.now()
  const report: ThemeMergeReport = {
    plans: plans.length,
    applied: 0,
    skipped: 0,
    mergedNodes: 0,
    movedMemberships: 0,
    droppedMemberships: 0,
    touched: [],
    merges: []
  }
  const touched = new Set<number>()
  const seen = new Set<number>()

  const insertMerge = db.prepare(
    `INSERT INTO node_merges (group_id, from_node, into_node, merged_at, reason, before_json, reverted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  )
  const readMemberships = db.prepare(
    'SELECT moment_id, weight, source, created_at FROM theme_moments WHERE theme_id = ? ORDER BY moment_id ASC'
  )
  const insertMembership = db.prepare(
    `INSERT OR IGNORE INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const upgradeOwner = db.prepare(
    `UPDATE theme_moments SET source = 'owner', weight = 1.0 WHERE theme_id = ? AND moment_id = ?`
  )
  const readMembershipSource = db.prepare(
    'SELECT source FROM theme_moments WHERE theme_id = ? AND moment_id = ?'
  )
  const deleteThemeMemberships = db.prepare('DELETE FROM theme_moments WHERE theme_id = ?')
  const deleteVectors = db.prepare('DELETE FROM node_embeddings WHERE node_id = ?')
  const deleteCentroids = db.prepare('DELETE FROM theme_centroids WHERE node_id = ?')
  const deletePositions = db.prepare('DELETE FROM node_positions WHERE node_id = ?')
  const deleteEdges = db.prepare(
    "DELETE FROM edges WHERE kind = 'embedding' AND (src = ? OR dst = ?)"
  )

  const run = db.transaction(() => {
    for (const plan of plans) {
      const intoRow = readNode(db, plan.into)
      // 人工撤销过的 (from → into) 对不再自动合并（撤销语义：这两个以后别再合）
      const fromIds = plan.from.filter((id) => !isMergeVetoed(db, id, plan.into))
      if (fromIds.length === 0) {
        report.skipped += 1
        continue
      }
      const fromRows: NodeRow[] = []
      let skip = false
      for (const id of fromIds) {
        const row = readNode(db, id)
        if (!row) {
          skip = true
          break
        }
        fromRows.push(row)
      }
      if (skip || !intoRow || intoRow.merged_into !== null) {
        report.skipped += 1
        continue
      }
      if (
        fromIds.length === 0 ||
        fromIds.some((id) => id === plan.into || seen.has(id)) ||
        seen.has(plan.into)
      ) {
        report.skipped += 1
        continue
      }
      if (fromRows.some((row) => row.type !== intoRow.type || row.merged_into !== null)) {
        report.skipped += 1
        continue
      }

      const intoSnapshot = snapshotOf(intoRow)
      const groupRows: Array<{ id: number; before: MergeBefore }> = []

      for (const row of fromRows) {
        const memberships = readMemberships.all(row.id) as MembershipRow[]
        const before: MergeBefore = {
          version: 1,
          into: intoSnapshot,
          from: {
            ...snapshotOf(row),
            memberships: [],
            conflicts: []
          }
        }
        for (const membership of memberships) {
          const weight = typeof membership.weight === 'number' ? membership.weight : 1
          const source = membership.source ?? 'owner'
          const createdAt = typeof membership.created_at === 'number' ? membership.created_at : now
          const existing = readMembershipSource.get(plan.into, membership.moment_id) as
            | { source: string | null }
            | undefined
          if (existing) {
            before.from.conflicts.push({
              intoSource: existing.source ?? 'owner',
              membership: { momentId: membership.moment_id, weight, source, createdAt }
            })
            if (source === 'owner' && (existing.source ?? '') !== 'owner') {
              upgradeOwner.run(plan.into, membership.moment_id)
            }
            report.droppedMemberships += 1
          } else {
            insertMembership.run(plan.into, membership.moment_id, weight, source, createdAt)
            before.from.memberships.push({
              momentId: membership.moment_id,
              weight,
              source,
              createdAt
            })
            report.movedMemberships += 1
          }
        }
        deleteThemeMemberships.run(row.id)
        groupRows.push({ id: row.id, before })
      }

      const merged = [intoRow, ...fromRows]
      const summary = pickSummary(intoRow, fromRows)
      db.prepare(
        `UPDATE nodes
         SET summary = ?, ts_start = ?, ts_end = ?, source_events = ?
         WHERE id = ?`
      ).run(
        summary,
        minTs(merged) ?? intoRow.ts_start,
        maxTs(merged) ?? intoRow.ts_end,
        unionEventIds(merged),
        plan.into
      )

      // 先写第一行拿到 group_id，再补齐其余源节点
      const first = groupRows[0]
      const leader = insertMerge.run(
        0,
        first.id,
        plan.into,
        now,
        plan.reason,
        JSON.stringify(first.before)
      )
      const groupId = Number(leader.lastInsertRowid)
      db.prepare('UPDATE node_merges SET group_id = ? WHERE id = ?').run(groupId, groupId)
      for (const extra of groupRows.slice(1)) {
        insertMerge.run(
          groupId,
          extra.id,
          plan.into,
          now,
          plan.reason,
          JSON.stringify(extra.before)
        )
      }

      for (const row of fromRows) {
        db.prepare('UPDATE nodes SET merged_into = ? WHERE id = ?').run(plan.into, row.id)
        deleteVectors.run(row.id)
        deleteCentroids.run(row.id)
        deletePositions.run(row.id)
        deleteEdges.run(row.id, row.id)
        touched.add(row.id)
        seen.add(row.id)
      }
      // into 的摘要/成员变了：标题向量与质心都过期
      deleteVectors.run(plan.into)
      deleteCentroids.run(plan.into)
      deleteEdges.run(plan.into, plan.into)
      touched.add(plan.into)
      seen.add(plan.into)

      report.applied += 1
      report.mergedNodes += fromRows.length
      report.merges.push({ groupId, into: plan.into, from: fromRows.map((row) => row.id) })
    }
  })
  run()

  report.touched = [...touched].sort((a, b) => a - b)
  return report
}

export type RevertThemeMergeResult =
  | { ok: true; groupId: number; into: number; from: number[] }
  | {
      ok: false
      reason: 'not-found' | 'already-reverted' | 'bad-snapshot' | 'has-newer-merges'
    }

/**
 * 撤销一次合并（传 `node_merges.id` 或 `group_id`，按组整体回滚）。
 * - 目标/源节点后来又被合并过且未撤销时拒绝（先撤销较新的，避免覆盖新变更）；
 * - 恢复字段与归属；向量/质心/位置不还原，交给下一次回填重算（位置重新沉降）。
 */
export function revertThemeMerge(
  db: Db,
  mergeId: number,
  options: { now?: number } = {}
): RevertThemeMergeResult {
  if (!Number.isInteger(mergeId) || mergeId <= 0) return { ok: false, reason: 'not-found' }
  const now = options.now ?? Date.now()
  const seed = db
    .prepare('SELECT id, group_id FROM node_merges WHERE id = ?')
    .get(mergeId) as { id: number; group_id: number } | undefined
  if (!seed) return { ok: false, reason: 'not-found' }
  const groupId = seed.group_id

  const rows = db
    .prepare(
      `SELECT id, from_node, into_node, before_json, reverted_at, merged_at
       FROM node_merges WHERE group_id = ? ORDER BY id ASC`
    )
    .all(groupId) as Array<{
    id: number
    from_node: number
    into_node: number
    before_json: string | null
    reverted_at: number | null
    merged_at: number
  }>
  if (rows.length === 0) return { ok: false, reason: 'not-found' }
  if (rows.some((row) => row.reverted_at !== null)) return { ok: false, reason: 'already-reverted' }

  let into: NodeSnapshot | null = null
  const fromSnapshots: MergeBefore['from'][] = []
  const intoNode = rows[0].into_node
  for (const row of rows) {
    let before: MergeBefore
    try {
      before = JSON.parse(row.before_json ?? '') as MergeBefore
    } catch {
      return { ok: false, reason: 'bad-snapshot' }
    }
    if (before?.version !== 1 || !before.into || !before.from || row.into_node !== intoNode) {
      return { ok: false, reason: 'bad-snapshot' }
    }
    into = before.into
    fromSnapshots.push(before.from)
  }
  if (!into) return { ok: false, reason: 'bad-snapshot' }

  const involved = [intoNode, ...fromSnapshots.map((item) => item.id)]
  const placeholders = involved.map(() => '?').join(',')
  const newer = db
    .prepare(
      `SELECT COUNT(*) AS n FROM node_merges
       WHERE reverted_at IS NULL
         AND merged_at >= ?
         AND id NOT IN (${rows.map(() => '?').join(',')})
         AND (from_node IN (${placeholders}) OR into_node IN (${placeholders}))`
    )
    .get(
      rows[0].merged_at,
      ...rows.map((row) => row.id),
      ...[...involved, ...involved]
    ) as { n: number }
  if (newer.n > 0) return { ok: false, reason: 'has-newer-merges' }

  const insertMembership = db.prepare(
    `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(theme_id, moment_id) DO UPDATE SET
       weight = excluded.weight,
       source = excluded.source,
       created_at = excluded.created_at`
  )
  const deleteMembership = db.prepare(
    'DELETE FROM theme_moments WHERE theme_id = ? AND moment_id = ?'
  )
  const restoreSource = db.prepare(
    'UPDATE theme_moments SET source = ? WHERE theme_id = ? AND moment_id = ?'
  )
  const deleteVectors = db.prepare('DELETE FROM node_embeddings WHERE node_id = ?')
  const deleteCentroids = db.prepare('DELETE FROM theme_centroids WHERE node_id = ?')
  const deleteEdges = db.prepare(
    "DELETE FROM edges WHERE kind = 'embedding' AND (src = ? OR dst = ?)"
  )
  const restoreNode = db.prepare(
    `UPDATE nodes SET title = ?, summary = ?, ts_start = ?, ts_end = ?, source_events = ?
     WHERE id = ?`
  )

  const run = db.transaction(() => {
    for (const snapshot of fromSnapshots) {
      // 该主题此前作为「已合并节点」不参与次归属；恢复后旧次归属已过期，先删掉再还原快照
      db.prepare("DELETE FROM theme_moments WHERE source = 'secondary' AND theme_id = ?").run(
        snapshot.id
      )
      for (const membership of snapshot.memberships) {
        deleteMembership.run(intoNode, membership.momentId)
        insertMembership.run(
          snapshot.id,
          membership.momentId,
          membership.weight,
          membership.source,
          membership.createdAt
        )
      }
      for (const conflict of snapshot.conflicts) {
        restoreSource.run(conflict.intoSource, intoNode, conflict.membership.momentId)
        insertMembership.run(
          snapshot.id,
          conflict.membership.momentId,
          conflict.membership.weight,
          conflict.membership.source,
          conflict.membership.createdAt
        )
      }
      restoreNode.run(
        snapshot.title,
        snapshot.summary,
        snapshot.tsStart,
        snapshot.tsEnd,
        snapshot.sourceEvents,
        snapshot.id
      )
      db.prepare('UPDATE nodes SET merged_into = NULL WHERE id = ?').run(snapshot.id)
      deleteVectors.run(snapshot.id)
      deleteCentroids.run(snapshot.id)
      deleteEdges.run(snapshot.id, snapshot.id)
    }

    restoreNode.run(
      into.title,
      into.summary,
      into.tsStart,
      into.tsEnd,
      into.sourceEvents,
      intoNode
    )
    deleteVectors.run(intoNode)
    deleteCentroids.run(intoNode)
    deleteEdges.run(intoNode, intoNode)

    const markReverted = db.prepare('UPDATE node_merges SET reverted_at = ? WHERE id = ?')
    for (const row of rows) markReverted.run(now, row.id)
  })
  run()

  return { ok: true, groupId, into: intoNode, from: fromSnapshots.map((item) => item.id) }
}
