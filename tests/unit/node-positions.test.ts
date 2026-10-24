import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db'
import {
  MAX_POSITIONS_PER_SAVE,
  normalizeNodePositions,
  saveNodePositions
} from '../../src/understand/node-positions'

function positionsOf(db: ReturnType<typeof openDatabase>): Array<{ node_id: number; x: number; y: number }> {
  return db.prepare('SELECT node_id, x, y FROM node_positions ORDER BY node_id').all() as Array<{
    node_id: number
    x: number
    y: number
  }>
}

describe('normalizeNodePositions', () => {
  it('只保留合法项，同一节点后写覆盖前写', () => {
    const result = normalizeNodePositions([
      { nodeId: 1, x: 10, y: 20 },
      { nodeId: 1, x: 11, y: 21 },
      { nodeId: 0, x: 1, y: 2 },
      { nodeId: 2.5, x: 1, y: 2 },
      { nodeId: 3, x: Number.NaN, y: 2 },
      { nodeId: 4, x: 1, y: Number.POSITIVE_INFINITY },
      { nodeId: 5, x: '1', y: 2 },
      null,
      'oops'
    ])
    expect(result.positions).toEqual([{ nodeId: 1, x: 11, y: 21 }])
    expect(result.rejected).toBe(7)
  })

  it('非数组输入返回空列表而不是抛错', () => {
    expect(normalizeNodePositions(undefined)).toEqual({ positions: [], rejected: 0 })
    expect(normalizeNodePositions({ nodeId: 1 })).toEqual({ positions: [], rejected: 0 })
  })

  it('超长列表只处理上限内的项', () => {
    const list = Array.from({ length: MAX_POSITIONS_PER_SAVE + 10 }, (_, index) => ({
      nodeId: index + 1,
      x: index,
      y: index
    }))
    expect(normalizeNodePositions(list).positions).toHaveLength(MAX_POSITIONS_PER_SAVE)
  })
})

describe('saveNodePositions', () => {
  it('首次写入 + 重跑 upsert（不重复插行）', () => {
    const db = openDatabase(':memory:')
    try {
      const first = saveNodePositions(db, [
        { nodeId: 1, x: 10, y: 20 },
        { nodeId: 2, x: 30, y: 40 }
      ], 1_000)
      expect(first).toEqual({ ok: true, saved: 2, rejected: 0 })
      expect(positionsOf(db)).toEqual([
        { node_id: 1, x: 10, y: 20 },
        { node_id: 2, x: 30, y: 40 }
      ])

      const second = saveNodePositions(db, [{ nodeId: 1, x: 11, y: 21 }], 2_000)
      expect(second).toEqual({ ok: true, saved: 1, rejected: 0 })
      expect(positionsOf(db)).toEqual([
        { node_id: 1, x: 11, y: 21 },
        { node_id: 2, x: 30, y: 40 }
      ])
      const updated = db
        .prepare('SELECT updated_at FROM node_positions WHERE node_id = 1')
        .get() as { updated_at: number }
      expect(updated.updated_at).toBe(2_000)
    } finally {
      db.close()
    }
  })

  it('全部非法 / 空列表：不写库，非法项返回错误', () => {
    const db = openDatabase(':memory:')
    try {
      expect(saveNodePositions(db, [])).toEqual({ ok: true, saved: 0, rejected: 0 })
      expect(saveNodePositions(db, [{ nodeId: 0, x: 1, y: 2 }])).toEqual({
        ok: false,
        error: '没有合法的坐标'
      })
      expect(positionsOf(db)).toEqual([])
    } finally {
      db.close()
    }
  })
})
