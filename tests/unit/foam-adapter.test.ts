import { describe, expect, it } from 'vitest'
import {
  countMembership,
  focusedIdsForDays,
  momentNodeId,
  nodeIdOf,
  otherThemesOfMoment,
  themeNodeId,
  themeSize,
  timeDimmedIds,
  toFoamGraph,
  type GlobalGraphInput
} from '../../src/renderer/graph/foam-adapter'

const DAY_MS = 24 * 60 * 60 * 1000

function day(y: number, m: number, d: number, h = 12): number {
  return new Date(y, m - 1, d, h).getTime()
}

function fixture(): GlobalGraphInput {
  return {
    themes: [
      { id: 1, type: 'knowledge', title: 'GUI 修复', tsStart: day(2026, 10, 21), tsEnd: day(2026, 10, 21, 18), sourceCount: 1 },
      { id: 2, type: 'activity', title: '时间线', tsStart: day(2026, 10, 22), tsEnd: day(2026, 10, 23, 2), sourceCount: 40 },
      { id: 3, type: 'protected', title: '受保护', tsStart: day(2026, 10, 23), tsEnd: day(2026, 10, 23, 20), sourceCount: 8 }
    ],
    moments: [
      { id: 10, ts: day(2026, 10, 21), dayKey: '2026-10-21', app: 'Code', title: '改 CSS', themeIds: [1] },
      { id: 11, ts: day(2026, 10, 22), dayKey: '2026-10-22', app: 'Chrome', title: '对需求', themeIds: [2, 1] },
      { id: 12, ts: day(2026, 10, 23), dayKey: '2026-10-23', app: 'Explorer', title: '整理 PR', themeIds: [3] }
    ],
    edges: [
      { source: 1, target: 2, weight: 0.82 },
      { source: 2, target: 1, weight: 0.82 },
      { source: 2, target: 3, weight: 0.7 },
      { source: 1, target: 99, weight: 0.9 }
    ]
  }
}

describe('themeSize', () => {
  it('压缩到 6–22，成员越多越大', () => {
    expect(themeSize(0)).toBe(6)
    expect(themeSize(1)).toBeGreaterThan(6)
    expect(themeSize(40)).toBe(22)
    expect(themeSize(100)).toBe(22)
    expect(themeSize(Number.NaN)).toBe(6)
  })
})

describe('toFoamGraph', () => {
  it('主题/时刻节点 id、类型、尺寸与时间属性', () => {
    const view = toFoamGraph(fixture())
    expect(Object.keys(view.data.nodeInfo)).toHaveLength(6)
    expect(view.themeIds).toEqual(['t:1', 't:2', 't:3'])
    expect(view.momentIds).toEqual(['m:10', 'm:11', 'm:12'])

    const theme = view.data.nodeInfo['t:2']
    expect(theme.type).toBe('activity')
    expect(theme.properties.size).toBe(22)
    expect(theme.properties.tsStart).toBe(day(2026, 10, 22))
    expect(theme.properties.tsEnd).toBe(day(2026, 10, 23, 2))

    const moment = view.data.nodeInfo['m:11']
    expect(moment.type).toBe('moment')
    expect(moment.properties.dayKey).toBe('2026-10-22')
    // 多归属时刻略大
    expect(moment.properties.size).toBeGreaterThan(view.data.nodeInfo['m:10'].properties.size as number)
  })

  it('边：主题边去重、跳过悬空端点；成员边按归属生成且不重复', () => {
    const view = toFoamGraph(fixture())
    const embedding = view.data.links.filter(link => link.kind === 'embedding')
    const membership = view.data.links.filter(link => link.kind === 'membership')
    // 1↔2 反向重复只留一条；1→99 悬空被跳过。
    expect(embedding).toEqual([
      { source: 't:1', target: 't:2', weight: 0.82, kind: 'embedding' },
      { source: 't:2', target: 't:3', weight: 0.7, kind: 'embedding' }
    ])
    expect(membership).toHaveLength(4)
    expect(membership.every(link => link.source.startsWith('t:') && link.target.startsWith('m:'))).toBe(true)
    expect(countMembership(fixture())).toBe(4)
  })

  it('节点 id 与数值 id 可互相还原', () => {
    expect(themeNodeId(42)).toBe('t:42')
    expect(momentNodeId(7)).toBe('m:7')
    expect(nodeIdOf('t:42')).toBe(42)
    expect(Number.isNaN(nodeIdOf('good morning'))).toBe(true)
  })
})

describe('时间筛选', () => {
  it('全部时不调暗任何节点', () => {
    expect(timeDimmedIds(fixture(), null).size).toBe(0)
  })

  it('按日期调暗区间不相交的主题与非当天时刻', () => {
    const dimmed = timeDimmedIds(fixture(), new Set(['2026-10-22']))
    // 主题 1（10-21）不覆盖 10-22；主题 3（10-23）不覆盖；主题 2 跨 10-22 保留。
    expect(dimmed.has(themeNodeId(1))).toBe(true)
    expect(dimmed.has(themeNodeId(2))).toBe(false)
    expect(dimmed.has(themeNodeId(3))).toBe(true)
    expect(dimmed.has(momentNodeId(10))).toBe(true)
    expect(dimmed.has(momentNodeId(11))).toBe(false)
    expect(dimmed.has(momentNodeId(12))).toBe(true)
  })

  it('focused 集合与 dimmed 互补（用于相机适配）', () => {
    const days = new Set(['2026-10-22'])
    const focused = focusedIdsForDays(fixture(), days)
    const dimmed = timeDimmedIds(fixture(), days)
    expect(focused.themeIds).toEqual([themeNodeId(2)])
    expect(focused.momentIds).toEqual([momentNodeId(11)])
    expect(focused.themeIds.some(id => dimmed.has(id))).toBe(false)
  })

  it('跨天主题在两天都算 focused', () => {
    const days = new Set(['2026-10-23'])
    expect(timeDimmedIds(fixture(), days).has(themeNodeId(2))).toBe(false)
  })

  it('多归属时刻的其它主题可枚举（侧栏「也属于」）', () => {
    expect(otherThemesOfMoment(fixture().moments[1])).toEqual([1])
    expect(otherThemesOfMoment(fixture().moments[0])).toEqual([])
  })

  it('DAY_MS 常量与测试夹具一致', () => {
    expect(day(2026, 10, 23) - day(2026, 10, 22)).toBe(DAY_MS)
  })
})
