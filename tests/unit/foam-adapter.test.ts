import { describe, expect, it } from 'vitest'
import {
  countMembership,
  focusedIdsForDays,
  momentNodeId,
  nodeIdOf,
  otherThemesOfMoment,
  searchDimmedIds,
  searchFocusedIds,
  themeNodeId,
  themeSize,
  timeDimmedIds,
  toFoamGraph,
  toGlobalGraphInput,
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

describe('toGlobalGraphInput（graph:global DTO → Foam 输入）', () => {
  it('主题/时刻/边映射，主归属排第一、次归属随后', () => {
    const input = toGlobalGraphInput({
      themes: [
        {
          id: 1,
          type: 'knowledge',
          title: 'GUI 修复',
          summary: '修按钮',
          tsStart: day(2026, 10, 21),
          tsEnd: day(2026, 10, 21, 18),
          sourceCount: 12,
          memberCount: 3,
          degree: 1
        },
        {
          id: 2,
          type: 'activity',
          title: '时间线',
          summary: '',
          tsStart: day(2026, 10, 22),
          tsEnd: day(2026, 10, 22, 20),
          sourceCount: 4,
          memberCount: 1,
          degree: 1
        }
      ],
      moments: [
        {
          id: 10,
          startTs: day(2026, 10, 21),
          endTs: day(2026, 10, 21),
          dayKey: '2026-10-21',
          app: 'Code',
          windowTitle: '改 CSS',
          ocrSummary: null,
          ocrTrimmed: false,
          eventIds: [1, 2],
          assigned: true
        },
        {
          id: 11,
          startTs: day(2026, 10, 22),
          endTs: day(2026, 10, 22),
          dayKey: '2026-10-22',
          app: null,
          windowTitle: null,
          ocrSummary: '查文档',
          ocrTrimmed: false,
          eventIds: [3],
          assigned: true
        }
      ],
      // 故意把次归属排在主归属前面，验证映射会重排
      memberships: [
        { themeId: 2, momentId: 11, weight: 0.93, source: 'secondary' },
        { themeId: 1, momentId: 11, weight: 0.97, source: 'owner' },
        { themeId: 1, momentId: 10, weight: 1, source: 'owner' }
      ],
      edges: [{ id: 100, source: 1, target: 2, weight: 0.82, kind: 'embedding', evidence: '' }],
      positions: [],
      dayActivity: [],
      stats: { themes: 2, moments: 2, memberships: 3, edges: 1, positions: 0 }
    })

    expect(input.themes.map((theme) => theme.id)).toEqual([1, 2])
    expect(input.themes[0].sourceCount).toBe(12)
    expect(input.moments.map((moment) => moment.id)).toEqual([10, 11])
    expect(input.moments[1]).toEqual({
      id: 11,
      ts: day(2026, 10, 22),
      dayKey: '2026-10-22',
      app: '',
      title: '查文档',
      themeIds: [1, 2]
    })
    expect(input.edges).toEqual([{ source: 1, target: 2, weight: 0.82 }])

    // 映射后的数据能直接进 Foam：成员边按主归属优先，共享时刻有两条成员边
    const view = toFoamGraph(input)
    expect(view.data.nodeInfo['t:1'].title).toBe('GUI 修复')
    expect(view.data.nodeInfo['m:11'].type).toBe('moment')
    expect(countMembership(input)).toBe(3)
  })

  it('没有归属的时刻 themeIds 为空，不抛错', () => {
    const input = toGlobalGraphInput({
      themes: [],
      moments: [
        {
          id: 1,
          startTs: 1,
          endTs: 2,
          dayKey: '2026-10-21',
          app: 'Code',
          windowTitle: null,
          ocrSummary: null,
          ocrTrimmed: false,
          eventIds: [],
          assigned: false
        }
      ],
      memberships: [],
      edges: [],
      positions: [],
      dayActivity: [],
      stats: { themes: 0, moments: 1, memberships: 0, edges: 0, positions: 0 }
    })
    expect(input.moments[0].themeIds).toEqual([])
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

describe('时段筛选（日期 × 起止时分）', () => {
  it('同一天内按时段调暗：时刻 11 在 11:00–13:00 内，主题 2 跨到次日仍保留', () => {
    const clock = { fromMinute: 11 * 60, toMinute: 13 * 60 }
    const dimmed = timeDimmedIds(fixture(), new Set(['2026-10-22']), clock)
    expect(dimmed.has(themeNodeId(2))).toBe(false)
    expect(dimmed.has(themeNodeId(1))).toBe(true)
    expect(dimmed.has(themeNodeId(3))).toBe(true)
    expect(dimmed.has(momentNodeId(11))).toBe(false)
    expect(dimmed.has(momentNodeId(10))).toBe(true)
    expect(dimmed.has(momentNodeId(12))).toBe(true)
  })

  it('时段把当天时刻挡在外面时，只剩跨时段主题', () => {
    const clock = { fromMinute: 13 * 60, toMinute: 18 * 60 }
    const dimmed = timeDimmedIds(fixture(), new Set(['2026-10-22']), clock)
    expect(dimmed.has(themeNodeId(2))).toBe(false)
    expect(dimmed.has(momentNodeId(11))).toBe(true)
  })

  it('默认全天等价于只看日期', () => {
    const days = new Set(['2026-10-22'])
    expect([...timeDimmedIds(fixture(), days)].sort()).toEqual(
      [...timeDimmedIds(fixture(), days, { fromMinute: 0, toMinute: 1439 })].sort()
    )
  })

  it('focused 与 dimmed 在时段下仍互补', () => {
    const clock = { fromMinute: 11 * 60, toMinute: 13 * 60 }
    const days = new Set(['2026-10-22'])
    const focused = focusedIdsForDays(fixture(), days, clock)
    const dimmed = timeDimmedIds(fixture(), days, clock)
    expect(focused.themeIds).toEqual([themeNodeId(2)])
    expect(focused.momentIds).toEqual([momentNodeId(11)])
    expect(focused.momentIds.some((id) => dimmed.has(id))).toBe(false)
  })
})

describe('文字筛选（命中时刻 → 图谱调暗）', () => {
  it('命中时刻与它归属的主题点亮，其余调暗', () => {
    // 时刻 11 同时属于主题 2（owner）与 1（secondary）
    const dimmed = searchDimmedIds(fixture(), new Set([11]))
    expect(dimmed.has(themeNodeId(1))).toBe(false)
    expect(dimmed.has(themeNodeId(2))).toBe(false)
    expect(dimmed.has(themeNodeId(3))).toBe(true)
    expect(dimmed.has(momentNodeId(10))).toBe(true)
    expect(dimmed.has(momentNodeId(11))).toBe(false)
    expect(dimmed.has(momentNodeId(12))).toBe(true)
  })

  it('没有命中时刻时全部调暗（空结果也是一种筛选结果）', () => {
    expect(searchDimmedIds(fixture(), new Set()).size).toBe(6)
  })

  it('主题按输入顺序返回，不随命中时刻顺序漂移', () => {
    expect(searchFocusedIds(fixture(), new Set([12, 11]))).toEqual({
      themeIds: [themeNodeId(1), themeNodeId(2), themeNodeId(3)],
      momentIds: [momentNodeId(11), momentNodeId(12)]
    })
  })
})
