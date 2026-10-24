import { describe, expect, it } from 'vitest'
import { truncateWithEllipsis, validateInduction } from '../../src/understand/structure/schema'

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

  it('拒绝未知 id / 跨节点重复归属；覆盖缺口不判失败（交给 coverage 补齐）', () => {
    const unknown = { nodes: [{ title: 'T', summary: 'S', type: 'knowledge', event_ids: [1, 99] }] }
    expect(errorsOf(unknown)).toContain('nodes[0].event_ids[1] 不是本批事件 id')

    const duplicate = {
      nodes: [
        { title: 'T1', summary: 'S1', type: 'knowledge', event_ids: [1] },
        { title: 'T2', summary: 'S2', type: 'activity', event_ids: [1] }
      ]
    }
    expect(errorsOf(duplicate)).toContain('nodes[1].event_ids[0] 重复归属（id 1）')

    // 只写 id 1、漏了 2 / 3：2026-10-24 起不再整批失败（temperature=0 时修复重试会输出同一份，
    // 这批事件会永远卡住）；缺口由 structure/coverage.ts 补到兄弟节点或落本地兜底节点
    const missing = { nodes: [{ title: 'T', summary: 'S', type: 'knowledge', event_ids: [1] }] }
    const result = validateInduction(missing, ALLOWED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.nodes[0].eventIds).toEqual([1])
  })

  it('超长文本确定性截断并计数（长度不再是整批失败的理由）', () => {
    const result = validateInduction(
      {
        nodes: [
          {
            title: '标'.repeat(41),
            summary: '摘'.repeat(81),
            type: 'knowledge',
            event_ids: [1, 2, 3]
          }
        ]
      },
      ALLOWED
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const node = result.result.nodes[0]
    // 标题硬上限 40（prompt 建议 24，宽出 16 字给真实语义标题）
    expect(node.title).toHaveLength(40)
    expect(node.title.endsWith('…')).toBe(true)
    expect(node.summary).toHaveLength(80)
    expect(result.truncated).toEqual({ titles: 1, summaries: 1, evidence: 0 })
  })

  it('标题 25–40 字原样保留（硬上限内不截断）', () => {
    const result = validateInduction(
      { nodes: [{ title: '标'.repeat(25), summary: 'S', type: 'knowledge', event_ids: [1, 2, 3] }] },
      ALLOWED
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.nodes[0].title).toHaveLength(25)
    expect(result.truncated.titles).toBe(0)
  })

  it('evidence 超 120 字截断并计数', () => {
    const result = validateInduction(
      {
        nodes: [
          { title: 'A', summary: 'S', type: 'knowledge', event_ids: [1, 2] },
          { title: 'B', summary: 'S', type: 'activity', event_ids: [3] }
        ],
        edges: [{ from: 0, to: 1, weight: 0.5, evidence: '证'.repeat(121) }]
      },
      ALLOWED
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.edges[0].evidence).toHaveLength(120)
    expect(result.truncated).toEqual({ titles: 0, summaries: 0, evidence: 1 })
  })

  it('非法 type / 空 event_ids 仍然整批失败', () => {
    const errors = errorsOf({
      nodes: [{ title: 'T', summary: 'S', type: 'idea', event_ids: [] }]
    })
    expect(errors).toContain('nodes[0].type 只能是 knowledge / activity')
    expect(errors).toContain('nodes[0].event_ids 必须是非空数组')
  })

  it('truncateWithEllipsis：优先标点切，兜底硬切，结果不超过上限', () => {
    expect(truncateWithEllipsis('短标题', 10)).toBe('短标题')
    // 切点够靠后（≥60%）用标点
    expect(truncateWithEllipsis('前面的话，后面还有很长很长的一段', 8)).toBe('前面的话…')
    // 没有标点时硬切
    expect(truncateWithEllipsis('abcdefghij', 5)).toBe('abcd…')
    // 标点太靠前（<60%）时退回硬切，避免只剩一两个字
    expect(truncateWithEllipsis('一，后面就很长了', 8)).toHaveLength(8)
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
