/**
 * 覆盖补齐（覆盖缺口不再是整批失败的理由；2026-10-24 拍板）
 *
 * 真机事故（2026-10-24 14:22–14:28）：模型对同一个「时刻」只回显了 `event_ids` 的第一条
 * （时刻 `[8074, 8075]` 只写 8074、`[8083, 8084]` 只写 8083），旧口径「本批输入 id 必须被
 * 全部覆盖」直接整批失败；`temperature=0` 让修复重试输出与上一次完全相同，于是同一批每
 * 10 分钟失败一次、游标不动、白烧 token，最后把自动归纳打到 `halted`。
 *
 * 现行口径（覆盖 = 数据完整性要求，不是模型必须逐字回显的考试题）：
 * 1. 同一时刻里已有兄弟 id 被某个节点覆盖 → 把漏掉的 id 补到该节点：同一时刻 = 同一段
 *    屏幕上下文，事实不变，语义也不变；
 * 2. 整段时刻完全没被提到 → 交回上层落「未归纳时段」本地兜底节点（`UNINDUCED_NODE`），
 *    不出云、不猜内容、不丢事件；
 * 3. 仍然整批失败的是**编造**与**重复归属**（`validateInduction` 里的硬错误），外加结构非法。
 *
 * 纯函数、确定性（并列时取输出下标最小者），不触发任何网络调用。
 */

import type { InductionNode, InductionResult } from './schema'

/** 一个「时刻」的回显 id 集合（按天取批的 CloudEvent 同形） */
export interface CoverageMoment {
  readonly eventIds: readonly number[]
}

export interface CoverageRepair {
  /** 补齐后的结果（节点已复制，不改入参） */
  result: InductionResult
  /** 补到兄弟节点的 id 数 */
  filled: number
  /** 整段时刻被忽略的事件 id（升序去重）；交给本地兜底节点 */
  uncoveredEventIds: number[]
  /** 整段被忽略的时刻数 */
  uncoveredMoments: number
}

/** 把同「时刻」漏掉的 id 补到覆盖该时刻的节点；整段被忽略的时刻单列出来 */
export function repairCoverage(
  result: InductionResult,
  moments: readonly CoverageMoment[]
): CoverageRepair {
  const nodes: InductionNode[] = result.nodes.map((node) => ({ ...node, eventIds: [...node.eventIds] }))
  /** eventId → nodes 下标（validation 已保证同一 id 不会出现在两个节点） */
  const nodeOf = new Map<number, number>()
  nodes.forEach((node, index) => {
    for (const id of node.eventIds) if (!nodeOf.has(id)) nodeOf.set(id, index)
  })

  let filled = 0
  let uncoveredMoments = 0
  const uncovered = new Set<number>()

  for (const moment of moments) {
    const ids = [...new Set(moment.eventIds)]
    if (ids.length === 0) continue
    const covered = ids.filter((id) => nodeOf.has(id))
    if (covered.length === 0) {
      // 整段时刻没被提到：不在这一层猜归属，交给本地兜底节点
      uncoveredMoments += 1
      for (const id of ids) uncovered.add(id)
      continue
    }
    const missing = ids.filter((id) => !nodeOf.has(id))
    if (missing.length === 0) continue

    // 兄弟最多的节点接走（并列取输出下标最小者，保证同输入同结果）
    const tally = new Map<number, number>()
    for (const id of covered) {
      const index = nodeOf.get(id)!
      tally.set(index, (tally.get(index) ?? 0) + 1)
    }
    let target = -1
    let bestCount = -1
    for (const [index, count] of tally) {
      if (count > bestCount || (count === bestCount && index < target)) {
        target = index
        bestCount = count
      }
    }
    if (target < 0) continue
    for (const id of missing) {
      nodes[target].eventIds.push(id)
      nodeOf.set(id, target)
      filled += 1
    }
  }

  return {
    result: { nodes, edges: result.edges },
    filled,
    uncoveredEventIds: [...uncovered].sort((a, b) => a - b),
    uncoveredMoments
  }
}
