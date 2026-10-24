import { describe, expect, it } from 'vitest'
import { repairCoverage, type CoverageMoment } from '../../src/understand/structure/coverage'
import type { InductionResult } from '../../src/understand/structure/schema'

function result(nodes: InductionResult['nodes']): InductionResult {
  return { nodes, edges: [] }
}

function node(title: string, eventIds: number[]): InductionResult['nodes'][number] {
  return { title, summary: 'S', type: 'activity', eventIds }
}

function moment(...eventIds: number[]): CoverageMoment {
  return { eventIds }
}

describe('repairCoverage · 覆盖缺口确定性补齐', () => {
  it('同一时刻漏掉的兄弟 id 补到覆盖该时刻的节点（真机 8074/8075 场景）', () => {
    const repaired = repairCoverage(
      result([node('浏览 DSH 桌面页', [8074]), node('安装 Agents Anywhere', [8076])]),
      [moment(8074, 8075), moment(8076)]
    )

    expect(repaired.filled).toBe(1)
    expect(repaired.uncoveredEventIds).toEqual([])
    expect(repaired.uncoveredMoments).toBe(0)
    expect(repaired.result.nodes.map((n) => n.eventIds)).toEqual([[8074, 8075], [8076]])
  })

  it('不改动入参（节点数组与 eventIds 都是副本）', () => {
    const input = result([node('A', [1])])
    const repaired = repairCoverage(input, [moment(1, 2)])
    expect(input.nodes[0].eventIds).toEqual([1])
    expect(repaired.result.nodes[0].eventIds).toEqual([1, 2])
  })

  it('时刻被拆到多个节点时补到兄弟最多的那个（并列取输出下标最小）', () => {
    const repaired = repairCoverage(
      result([node('A', [1]), node('B', [2, 3]), node('C', [4])]),
      [moment(1, 2, 3, 4, 5)]
    )

    expect(repaired.filled).toBe(1)
    expect(repaired.result.nodes[1].eventIds).toEqual([2, 3, 5])

    const tie = repairCoverage(result([node('A', [1]), node('B', [2])]), [moment(1, 2, 3)])
    expect(tie.filled).toBe(1)
    expect(tie.result.nodes[0].eventIds).toEqual([1, 3])
  })

  it('整段时刻被忽略：事件 id 升序返回、交给本地兜底节点，不猜归属', () => {
    const repaired = repairCoverage(
      result([node('读代码', [3])]),
      [moment(1, 2), moment(3), moment(10)]
    )

    expect(repaired.filled).toBe(0)
    expect(repaired.uncoveredEventIds).toEqual([1, 2, 10])
    expect(repaired.uncoveredMoments).toBe(2)
    expect(repaired.result.nodes[0].eventIds).toEqual([3])
  })

  it('已经全覆盖时是空操作', () => {
    const repaired = repairCoverage(result([node('A', [1, 2])]), [moment(1, 2)])
    expect(repaired).toMatchObject({ filled: 0, uncoveredEventIds: [], uncoveredMoments: 0 })
    expect(repaired.result.nodes[0].eventIds).toEqual([1, 2])
  })

  it('空输入 / 无节点不抛错（模型只输出空边、异常批都不能崩）', () => {
    expect(repairCoverage(result([]), [])).toMatchObject({ filled: 0, uncoveredEventIds: [] })
    expect(repairCoverage(result([]), [moment(1)])).toMatchObject({
      filled: 0,
      uncoveredEventIds: [1],
      uncoveredMoments: 1
    })
  })
})
