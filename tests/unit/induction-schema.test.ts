import { describe, expect, it } from 'vitest'
import { validateInduction } from '../../src/understand/structure/schema'

const ALLOWED = new Set([1, 2, 3])

function errorsOf(json: unknown): string[] {
  const result = validateInduction(json, ALLOWED)
  if (result.ok) throw new Error('expected invalid output')
  return result.errors
}

function okJson(): unknown {
  return {
    nodes: [
      { title: '读技术方案', summary: '看了 M2 方案相关章节', type: 'knowledge', event_ids: [1, 2] },
      { title: '写代码', summary: '实现归纳管线', type: 'activity', event_ids: [3] }
    ],
    edges: [{ from: 0, to: 1, weight: 0.8, evidence: '方案指导实现' }]
  }
}

describe('validateInduction · 手写校验器', () => {
  it('合法输出通过，并归一成 eventIds / edges', () => {
    const result = validateInduction(okJson(), ALLOWED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.nodes.map((node) => node.eventIds)).toEqual([[1, 2], [3]])
    expect(result.result.edges).toEqual([{ from: 0, to: 1, weight: 0.8, evidence: '方案指导实现' }])
  })

  it('拒绝非对象 / 零节点 / 未知字段', () => {
    expect(validateInduction('nope', ALLOWED)).toMatchObject({ ok: false })
    expect(validateInduction({ nodes: [], edges: [] }, ALLOWED)).toMatchObject({ ok: false })
    expect(errorsOf({ nodes: [{ ...okNode(), extra: 1 }] })).toContain('nodes[0] 含契约外字段')
    expect(errorsOf({ ...(okJson() as object), total: 2 })).toContain('根节点含契约外字段')
  })

  it('拒绝未知 id / 跨节点重复归属 / 未覆盖全部输入 id', () => {
    const unknown = { nodes: [{ title: 'T', summary: 'S', type: 'knowledge', event_ids: [1, 99] }] }
    expect(errorsOf(unknown)).toContain('nodes[0].event_ids[1] 不是本批事件 id')

    const duplicate = {
      nodes: [
        { title: 'T1', summary: 'S1', type: 'knowledge', event_ids: [1] },
        { title: 'T2', summary: 'S2', type: 'activity', event_ids: [1] }
      ]
    }
    expect(errorsOf(duplicate)).toContain('nodes[1].event_ids[0] 重复归属（id 1）')

    const missing = { nodes: [{ title: 'T', summary: 'S', type: 'knowledge', event_ids: [1] }] }
    const errors = errorsOf(missing)
    expect(errors).toContain('事件 2 未被任何节点覆盖')
    expect(errors).toContain('事件 3 未被任何节点覆盖')
  })

  it('拒绝超长标题 / 摘要、非法 type、空 event_ids', () => {
    const errors = errorsOf(
      {
        nodes: [
          {
            title: '标'.repeat(25),
            summary: '摘'.repeat(81),
            type: 'idea',
            event_ids: []
          }
        ]
      }
    )
    expect(errors).toContain('nodes[0].title 超过 24 字')
    expect(errors).toContain('nodes[0].summary 超过 80 字')
    expect(errors).toContain('nodes[0].type 只能是 knowledge / activity')
    expect(errors).toContain('nodes[0].event_ids 必须是非空数组')
  })

  it('拒绝非法边：下标越界 / 自环 / 权重越界 / 空 evidence / 未知字段', () => {
    const errors = errorsOf(
      {
        nodes: [{ title: 'T', summary: 'S', type: 'knowledge', event_ids: [1, 2, 3] }],
        edges: [
          { from: 0, to: 5, weight: 0.5, evidence: 'x' },
          { from: 0, to: 0, weight: 0.5, evidence: 'x' },
          { from: 0, to: 0, weight: 2, evidence: 'x' },
          { from: 0, to: 0, weight: 0.5, evidence: '   ' },
          { from: 0, to: 0, weight: 0.5, evidence: 'x', extra: true }
        ]
      }
    )
    expect(errors).toContain('edges[0].to 必须是本次 nodes 下标')
    expect(errors).toContain('edges[1] 不允许自环')
    expect(errors).toContain('edges[2].weight 必须在 0–1 之间')
    expect(errors).toContain('edges[3].evidence 必须是非空字符串')
    expect(errors).toContain('edges[4] 含契约外字段')
  })

  it('错误条目最多 10 条（修复提示不膨胀）', () => {
    const nodes = Array.from({ length: 15 }, (_, index) => ({
      title: '',
      summary: '',
      type: 'idea',
      event_ids: [index + 100]
    }))
    const errors = errorsOf({ nodes })
    expect(errors.length).toBeLessThanOrEqual(10)
  })
})

function okNode(): Record<string, unknown> {
  return { title: 'T', summary: 'S', type: 'knowledge', event_ids: [1, 2, 3] }
}
