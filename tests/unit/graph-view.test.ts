import { describe, expect, it } from 'vitest'
import type { GraphEdgeDto, GraphNodeDto } from '../../src/understand/graph-query'
import {
  EDGE_COLOR,
  NODE_COLORS,
  edgeSize,
  filterByWindow,
  maxDegree,
  neighborIds,
  nodeColor,
  nodeLabel,
  nodeSize
} from '../../src/renderer/graph/graph-view'

function edge(source: number, target: number, weight = 0.5): GraphEdgeDto {
  return { id: source * 100 + target, source, target, weight, kind: 'ai', evidence: '' }
}

function node(id: number, degree: number): GraphNodeDto {
  return {
    id,
    type: 'knowledge',
    title: `节点 ${id}`,
    summary: '',
    tsStart: 0,
    tsEnd: 0,
    sourceCount: 0,
    degree
  }
}

describe('nodeColor / nodeSize / edgeSize', () => {
  it('六色映射：知识 / 行为 / 保护 / 未知', () => {
    expect(nodeColor('knowledge')).toBe(NODE_COLORS.knowledge)
    expect(nodeColor('activity')).toBe(NODE_COLORS.activity)
    expect(nodeColor('protected')).toBe(NODE_COLORS.protected)
    expect(nodeColor('weird')).toBe(NODE_COLORS.unknown)
    expect(EDGE_COLOR).toMatch(/^#/)
  })

  it('尺寸随度数对数增长且有上下限', () => {
    expect(nodeSize(0, 0)).toBe(6)
    expect(nodeSize(0, 10)).toBe(6)
    expect(nodeSize(10, 10)).toBeCloseTo(22, 5)
    const mid = nodeSize(3, 10)
    expect(mid).toBeGreaterThan(6)
    expect(mid).toBeLessThan(22)
    expect(nodeSize(-1, 10)).toBe(6)
  })

  it('边宽 ∝ weight 且夹在 1–5', () => {
    expect(edgeSize(0)).toBe(1)
    expect(edgeSize(0.5)).toBe(3)
    expect(edgeSize(1)).toBe(5)
    expect(edgeSize(2)).toBe(5)
    expect(edgeSize(Number.NaN)).toBe(1)
  })

  it('maxDegree 取节点度数最大值', () => {
    expect(maxDegree({ nodes: [] })).toBe(0)
    expect(maxDegree({ nodes: [node(1, 1), node(2, 7)] })).toBe(7)
  })
})

describe('邻域与过滤', () => {
  it('neighborIds 含自身与双向一跳邻居', () => {
    const edges = [edge(1, 2), edge(3, 1), edge(4, 5)]
    expect([...neighborIds(edges, 1)].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect([...neighborIds(edges, 5)].sort((a, b) => a - b)).toEqual([4, 5])
    expect([...neighborIds(edges, 9)]).toEqual([9])
  })

  it('filterByWindow 按区间相交过滤', () => {
    const nodes = [
      { id: 1, tsStart: 10, tsEnd: 20 },
      { id: 2, tsStart: 30, tsEnd: 40 },
      { id: 3, tsStart: 5, tsEnd: 15 }
    ]
    expect(filterByWindow(nodes, 14, 25).map((node) => node.id)).toEqual([1, 3])
    expect(filterByWindow(nodes, 41, 50)).toEqual([])
  })

  it('nodeLabel 压缩空白并截断', () => {
    expect(nodeLabel('  项目   计划 ')).toBe('项目 计划')
    expect(nodeLabel('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})
