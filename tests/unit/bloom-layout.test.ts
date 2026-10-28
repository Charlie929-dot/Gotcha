import { describe, expect, it } from 'vitest'
import {
  computeBloomLayout,
  hashUnit,
  momentOrbitPoint,
  type BloomLinkLike
} from '../../src/renderer/foam/lib/bloom-layout'

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

function membership(themeId: string, momentId: string): BloomLinkLike {
  return { source: themeId, target: momentId, kind: 'membership' }
}

describe('hashUnit', () => {
  it('稳定落在 [0,1)，且不同 id 不同', () => {
    const a = hashUnit('t:1')
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
    expect(hashUnit('t:1')).toBe(a)
    expect(hashUnit('t:2')).not.toBe(a)
  })
})

describe('computeBloomLayout', () => {
  const nodes = [{ id: 't:1' }, { id: 't:2' }, { id: 'm:10' }, { id: 'm:11' }, { id: 'm:12' }]
  const links: BloomLinkLike[] = [
    { source: 't:1', target: 't:2', kind: 'embedding', weight: 1 },
    membership('t:1', 'm:10'),
    membership('t:1', 'm:11'),
    membership('t:2', 'm:12')
  ]

  it('空图返回空表', () => {
    expect(computeBloomLayout({ nodes: [], links: [] }).size).toBe(0)
  })

  it('确定性：同样的输入两次得到同样的坐标', () => {
    const first = computeBloomLayout({ nodes, links })
    const second = computeBloomLayout({ nodes, links })
    expect([...second.entries()]).toEqual([...first.entries()])
  })

  it('有 seed 的主题原地不动，没 seed 的挂到已定位邻居旁边', () => {
    const layout = computeBloomLayout({
      nodes: [{ id: 't:1' }, { id: 't:2' }],
      links: [{ source: 't:1', target: 't:2', kind: 'embedding' }],
      seeds: new Map([['t:1', { x: 500, y: -300 }]])
    })
    expect(layout.get('t:1')).toEqual({ x: 500, y: -300 })
    const placed = layout.get('t:2')
    expect(placed).toBeDefined()
    // 挂在 t:1 附近（90 px 抖动内），不是撒到外圈
    expect(distance(placed!, { x: 500, y: -300 })).toBeLessThan(95)
  })

  it('时刻绕自己的主题排螺旋：距离落在环半径区间，且彼此不重合', () => {
    const layout = computeBloomLayout({ nodes, links })
    const theme = layout.get('t:1')!
    const m10 = layout.get('m:10')!
    const m11 = layout.get('m:11')!
    const rest = distance(m10, theme)
    expect(rest).toBeGreaterThanOrEqual(11.9)
    expect(rest).toBeLessThan(20)
    expect(distance(m10, m11)).toBeGreaterThan(1)
  })

  it('多归属时刻落在几个主题的重心附近', () => {
    const multi = computeBloomLayout({
      nodes: [{ id: 't:1' }, { id: 't:2' }, { id: 'm:10' }],
      links: [membership('t:1', 'm:10'), membership('t:2', 'm:10')],
      seeds: new Map([
        ['t:1', { x: -400, y: 0 }],
        ['t:2', { x: 400, y: 0 }]
      ])
    })
    const point = multi.get('m:10')!
    expect(near(point.x, 0, 20)).toBe(true)
    expect(Math.abs(point.y)).toBeLessThan(20)
  })

  it('没有归属的时刻撒在外圈，不会堆在原点', () => {
    const layout = computeBloomLayout({ nodes: [{ id: 't:1' }, { id: 'm:99' }], links: [] })
    const orphan = layout.get('m:99')!
    expect(Math.hypot(orphan.x, orphan.y)).toBeGreaterThan(100)
  })

  it('换 rotation 会换角度（「重排」能看出变化）', () => {
    const first = computeBloomLayout({ nodes: [{ id: 't:1' }, { id: 'm:10' }], links: [membership('t:1', 'm:10')] })
    const second = computeBloomLayout({
      nodes: [{ id: 't:1' }, { id: 'm:10' }],
      links: [membership('t:1', 'm:10')],
      rotation: 0.9
    })
    expect(second.get('m:10')).not.toEqual(first.get('m:10'))
    // 主题本身不随 rotation 动（只有它的成员换角度）
    expect(second.get('t:1')).toEqual(first.get('t:1'))
  })

  it('没有 typeOf 时按 id 前缀判断主题 / 时刻', () => {
    const layout = computeBloomLayout({
      nodes: [{ id: 't:1' }, { id: 'm:1' }],
      links: [membership('t:1', 'm:1')]
    })
    expect(layout.has('t:1')).toBe(true)
    expect(layout.has('m:1')).toBe(true)
  })
})

describe('momentOrbitPoint', () => {
  it('index 越大离主题越远（螺旋往外）', () => {
    const center = { x: 0, y: 0 }
    const first = momentOrbitPoint('t:1', 0, center)
    const tenth = momentOrbitPoint('t:1', 9, center)
    expect(distance(tenth, center)).toBeGreaterThan(distance(first, center))
  })

  it('同一 (主题, 序号) 永远同一点', () => {
    expect(momentOrbitPoint('t:1', 3, { x: 10, y: 20 })).toEqual(
      momentOrbitPoint('t:1', 3, { x: 10, y: 20 })
    )
  })
})
