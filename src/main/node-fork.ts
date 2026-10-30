/**
 * 记忆仓 · 历史提交分叉（memory-life M2，2026-10-30）
 *
 * `/use <短 sha>` 只是 `checkout` 成 detached：那一刻的记忆只读可看，**不发新提交**。
 * 用户在这个位置发出第一句话时，才自动从该提交开一条新分支（copy-on-write）：
 *
 * ```
 * ... c1 ── c2 ── c3        ← default（停在最后一次提交）
 *              │
 *              └─ c21 ── c22 ← default-2（第一句话之后都记在这里）
 * ```
 *
 * 原分支取家谱的 `active`（`/use <提交>` 不写家谱，所以它仍是进历史前的节点），
 * 序号取该分支下已有分叉的最大值 +1；跨重启也成立，不依赖进程内状态。
 *
 * 分叉失败一律不阻塞提问：记日志、照常回答（宁可这一问不落节点，也不能让人聊不了）。
 */

import {
  findBranch,
  generationOf,
  lineageSnapshot,
  readLineage,
  withActive,
  withBranchAdded,
  writeLineage
} from './lineage'
import type { MemoryRepo } from './memory-repo'

export interface ForkDeps {
  repo: MemoryRepo
  lineageFile: string
  /** 分叉后清会话缓存（新节点从自己的 `conversations/` 重新读） */
  reloadConversations?: () => void
  log?: (level: 'warn', message: string, data?: Record<string, unknown>) => void
  now?: () => number
}

export interface ForkResult {
  forked: boolean
  branch?: string
}

/** `<base>-<n>`：n 取已有分叉的最大值 +1；没有分叉就从 2 开始 */
export function nextForkName(base: string, branches: readonly string[]): string {
  let max = 1
  for (const branch of branches) {
    if (!branch.startsWith(`${base}-`)) continue
    const suffix = branch.slice(base.length + 1)
    if (!/^\d+$/u.test(suffix)) continue
    max = Math.max(max, Number(suffix))
  }
  return `${base}-${max + 1}`
}

export async function forkDetachedIfNeeded(deps: ForkDeps): Promise<ForkResult> {
  try {
    const head = await deps.repo.head()
    if (!head.detached || head.sha === null) return { forked: false }

    const read = await readLineage(deps.lineageFile)
    if (read.status !== 'ok') return { forked: false }
    const lineage = read.lineage
    const base = lineage.active
    const branches = await deps.repo.listBranches()
    const branch = nextForkName(
      base,
      branches.map((item) => item.branch)
    )

    // 正常情况下工作区是干净的（刚 /use 过来）；脏说明上次切换的提交没落成，先保一次
    const saved = await deps.repo.commit(`memory: fork ${branch}`)
    if (!saved.committed && saved.reason !== 'clean' && saved.reason !== 'already') {
      deps.log?.('warn', 'memory fork save failed', { reason: saved.reason ?? 'failed' })
      return { forked: false }
    }

    const created = await deps.repo.switchCreate(branch)
    if (!created.ok) {
      deps.log?.('warn', 'memory fork failed', { reason: created.reason ?? 'failed' })
      return { forked: false }
    }

    const parent = findBranch(lineage, base) !== null ? base : lineage.active
    const generation = generationOf(lineage, parent)?.id ?? lineage.generations[0]?.id ?? 'gen-1'
    const added = withBranchAdded(lineage, {
      branch,
      generation,
      parent,
      at: deps.now?.() ?? Date.now()
    })
    if (added !== null) {
      const activated = withActive(added, branch) ?? added
      await writeLineage(deps.lineageFile, activated)
      await deps.repo.writeFile('lineage.snapshot.json', lineageSnapshot(activated))
    }
    deps.reloadConversations?.()
    return { forked: true, branch }
  } catch (error) {
    deps.log?.('warn', 'memory fork failed', { error: String(error) })
    return { forked: false }
  }
}
