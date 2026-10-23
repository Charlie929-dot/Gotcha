import { describe, expect, it } from 'vitest'
import {
  countNodeTypes,
  defaultVisibleTypes,
  edgeInFocus,
  focusNodeSet,
  isTypeVisible,
  toggleVisibleType,
  typeKeyOf
} from '../../src/renderer/graph/graph-interactions'

describe('图谱类型显隐', () => {
  it('已知 type 原样映射，未知归 unknown', () => {
    expect(typeKeyOf('knowledge')).toBe('knowledge')
    expect(typeKeyOf('activity')).toBe('activity')
    expect(typeKeyOf('protected')).toBe('protected')
    expect(typeKeyOf('event')).toBe('event')
    expect(typeKeyOf('weird')).toBe('unknown')
  })

  it('默认四类 + unknown 全部可见', () => {
    const visible = defaultVisibleTypes()
    expect(visible.knowledge).toBe(true)
    expect(visible.event).toBe(true)
    expect(visible.unknown).toBe(true)
    expect(isTypeVisible('knowledge', visible)).toBe(true)
  })

  it('toggle 不改原对象，只改目标类型', () => {
    const before = defaultVisibleTypes()
    const after = toggleVisibleType(before, 'event', false)
    expect(before.event).toBe(true)
    expect(after.event).toBe(false)
    expect(after.knowledge).toBe(true)
    expect(isTypeVisible('event', after)).toBe(false)
  })
})

describe('局部图', () => {
  const edges = [
    { source: 'c1', target: 'c2' },
    { source: 'c1', target: 'ev1' },
    { source: 'c2', target: 'c3' },
    { source: 'ev2', target: 'c1' }
  ]

  it('focusNodeSet 含自身与一跳邻居', () => {
    expect([...focusNodeSet(edges, 'c1')].sort()).toEqual(['c1', 'c2', 'ev1', 'ev2'])
    expect([...focusNodeSet(edges, 'c3')].sort()).toEqual(['c2', 'c3'])
    expect([...focusNodeSet(edges, 'missing')]).toEqual(['missing'])
  })

  it('edgeInFocus 只保留两端都在邻域内的边', () => {
    const focus = focusNodeSet(edges, 'c1')
    expect(edgeInFocus({ source: 'c1', target: 'c2' }, focus)).toBe(true)
    expect(edgeInFocus({ source: 'c2', target: 'c3' }, focus)).toBe(false)
  })
})

describe('类型计数', () => {
  it('概念类型与事件数分开统计', () => {
    const counts = countNodeTypes(
      [{ type: 'knowledge' }, { type: 'knowledge' }, { type: 'activity' }, { type: 'weird' }],
      7
    )
    expect(counts).toEqual({
      knowledge: 2,
      activity: 1,
      protected: 0,
      event: 7,
      unknown: 1
    })
  })
})
