/**
 * 主题节点坐标回写（docs/m2-graph-redesign.md §6.4 / §7.3 F5）
 *
 * - Foam 沉降后由渲染层回传坐标，下次打开时作为 seed（活布局继续移动，不冻结）；
 * - 只接受有限数值与正整数节点 id，坏数据整条丢弃并计数，不抛到 UI；
 * - 同一节点重复出现时后写覆盖前写；写入在一个事务里，失败整体回滚；
 * - 不校验节点是否仍存在：`queryGlobalGraph` 只返回当前主题集内的位置，
 *   被合并/删除节点留下的旧行不会出现在画布上。
 */

import type { Db } from '../db'

export interface NodePositionInput {
  nodeId: number
  x: number
  y: number
}

export type SaveNodePositionsResult =
  | { ok: true; saved: number; rejected: number }
  | { ok: false; error: string }

/** 单次回写上限：当前规模 158–210 个主题，留足余量但防止异常大数组写库 */
export const MAX_POSITIONS_PER_SAVE = 20_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把任意输入规整成可落库的坐标列表（纯函数，可单测）。
 * 非法项计入 `rejected`；同一节点保留最后一次出现的坐标。
 */
export function normalizeNodePositions(input: unknown): {
  positions: NodePositionInput[]
  rejected: number
} {
  if (!Array.isArray(input)) return { positions: [], rejected: 0 }
  const byNode = new Map<number, NodePositionInput>()
  let rejected = 0
  for (const item of input.slice(0, MAX_POSITIONS_PER_SAVE)) {
    if (!isPlainObject(item)) {
      rejected += 1
      continue
    }
    const nodeId = item.nodeId
    const x = item.x
    const y = item.y
    if (
      !Number.isInteger(nodeId) ||
      (nodeId as number) <= 0 ||
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      typeof y !== 'number' ||
      !Number.isFinite(y)
    ) {
      rejected += 1
      continue
    }
    byNode.set(nodeId as number, { nodeId: nodeId as number, x, y })
  }
  return { positions: [...byNode.values()], rejected }
}

/** 批量 upsert 坐标；`now` 由调用方注入便于测试。 */
export function saveNodePositions(
  db: Db,
  input: unknown,
  now: number = Date.now()
): SaveNodePositionsResult {
  const { positions, rejected } = normalizeNodePositions(input)
  if (positions.length === 0) {
    return rejected > 0 ? { ok: false, error: '没有合法的坐标' } : { ok: true, saved: 0, rejected }
  }
  const statement = db.prepare(
    `INSERT INTO node_positions (node_id, x, y, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`
  )
  const write = db.transaction((list: NodePositionInput[]) => {
    for (const item of list) statement.run(item.nodeId, item.x, item.y, now)
  })
  write(positions)
  return { ok: true, saved: positions.length, rejected }
}
