import { describe, expect, it } from 'vitest'
import { computeGraphStates, createGraphModel } from '../../src/renderer/foam/lib/graph-utils'
import type { GraphData } from '../../src/renderer/foam/protocol'

function model(links: Array<{ source: string; target: string; kind?: string }>) {
  const nodeInfo: GraphData['nodeInfo'] = {}
  for (const id of ['a', 'b', 'c', 'd']) {
    nodeInfo[id] = { id, type: 'knowledge', title: id, properties: {}, tags: [] }
  }
  return createGraphModel({ nodeInfo, links })
}

describe('computeGraphStates（F4/F13）', () => {
  it('无选中、无调暗时全部常规', () => {
    const states = computeGraphStates(model([{ source: 'a', target: 'b' }]), new Set(), null, 1)
    expect([...states.nodeStates.values()].every(state => state === 'regular')).toBe(true)
    expect([...states.linkStates.values()].every(state => state === 'regular')).toBe(true)
  })

  it('时间筛选外只调暗节点，不从图上删除', () => {
    const graphModel = model([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'd' }])
    const states = computeGraphStates(graphModel, new Set(), null, 1, new Set(['c', 'd']))
    expect(states.nodeStates.get('a')).toBe('regular')
    expect(states.nodeStates.get('b')).toBe('regular')
    expect(states.nodeStates.get('c')).toBe('dimmed')
    expect(states.nodeStates.get('d')).toBe('dimmed')
    // 两端都被调暗的边一起压暗；一端在范围内保持常规。
    expect(states.linkStates.get('a->b')).toBe('regular')
    expect(states.linkStates.get('b->c')).toBe('regular')
    expect(states.linkStates.get('c->d')).toBe('dimmed')
  })

  it('选中 = 高亮自身 + 邻域，其余调暗（F13 不删节点）', () => {
    const graphModel = model([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'd' }])
    const states = computeGraphStates(graphModel, new Set(['a']), null, 1)
    expect(states.nodeStates.get('a')).toBe('highlighted')
    expect(states.nodeStates.get('b')).toBe('regular')
    expect(states.nodeStates.get('c')).toBe('dimmed')
    expect(states.nodeStates.get('d')).toBe('dimmed')
    expect(states.linkStates.get('a->b')).toBe('highlighted')
    expect(states.linkStates.get('b->c')).toBe('dimmed')
    expect(states.linkStates.get('c->d')).toBe('dimmed')
  })

  it('悬停节点视为高亮，其它按邻域判定', () => {
    const graphModel = model([{ source: 'a', target: 'b' }])
    const states = computeGraphStates(graphModel, new Set(), 'b', 1)
    expect(states.nodeStates.get('b')).toBe('highlighted')
    expect(states.nodeStates.get('a')).toBe('regular')
    expect(states.linkStates.get('a->b')).toBe('highlighted')
  })

  it('选中的节点即使在时间筛选外也保持高亮（用户明确点开它）', () => {
    const graphModel = model([{ source: 'a', target: 'b' }])
    const states = computeGraphStates(graphModel, new Set(['a']), null, 1, new Set(['a']))
    expect(states.nodeStates.get('a')).toBe('highlighted')
  })

  it('邻域深度 2 时两跳邻居保持常规', () => {
    const graphModel = model([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'd' }])
    const states = computeGraphStates(graphModel, new Set(['a']), null, 2)
    expect(states.nodeStates.get('c')).toBe('regular')
    expect(states.nodeStates.get('d')).toBe('dimmed')
  })
})
