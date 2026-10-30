/**
 * 记忆仓 · 传承（M4，2026-10-30）
 *
 * 从运行中的 `main/index.ts` 抽出来的原因（D73）：真机传承验收要能在**不弹窗口**的情况下跑
 * 真实 git 仓 + 真实家谱（假模型触发工具），而不是只测 fakeRepo。这里只做主进程动作，
 * 不碰 Electron：会话重读、QQ 改名由调用方在结果上做。
 *
 * 纪律（M4/D72）：
 * - 先提交母亲；任何一步失败都不写权威家谱（宁可报错，不可丢记忆）；
 * - 出生提交写在**主干**上（D73：分支名 `ask`；旧仓里的 `life` 仍认作主干，不迁移数据）；
 * - 女儿是 orphan 空树（只有对话 / 信 / 家谱快照），母亲那一代置 dead、active 切女儿。
 */

import type { ConceiveDaughterResult } from '../chain/agent/tools'
import {
  findBranch,
  isTrunkName,
  lifeOf,
  lineageSnapshot,
  readLineage,
  TRUNK_BRANCH,
  withBranchAdded,
  withGenerationAdded,
  writeLineage,
  type Lineage
} from './lineage'
import { defaultMemoryName, slugifyNodeName } from './commands'
import type { MemoryRepo } from './memory-repo'

export interface ConceiveDeps {
  repo: MemoryRepo
  /** 家谱权威文件（仓外） */
  lineageFile: string
  now?: () => number
}

export interface ConceiveInput {
  nickname: string
  /** 母亲留下的信（可选，ta 想写就写） */
  letter?: string
  /** 当前活动节点（必须 alive，且生命 ≥85%） */
  motherBranch: string
}

/** 家谱里没有主干节点就补一条（旧 M4 家谱只记了女儿，没记主干） */
function withTrunkNode(lineage: Lineage, trunk: string, at: number): Lineage {
  if (findBranch(lineage, trunk) !== null) return lineage
  const added = withBranchAdded(lineage, {
    branch: trunk,
    generation: lineage.generations[0]?.id ?? 'gen-1',
    parent: lineage.generations[0]?.branch ?? 'default',
    at,
    kind: 'life'
  })
  return added ?? lineage
}

/** 女儿分支里的出生记录（`birth.json`）：让首个提交一定有内容，也方便她知道自己从哪来 */
function birthRecord(slug: string, mother: string, at: number): string {
  return `${JSON.stringify({ nickname: slug, mother, born_at: at }, null, 2)}\n`
}

/**
 * 传承：母亲写信（可选）→ 主干出生提交 → 女儿从出生提交分叉 → 家谱新代。
 * 返回 `ok:false` 时仓与家谱都没变（失败前会退回母亲节点）。
 */
export async function conceiveDaughter(
  deps: ConceiveDeps,
  input: ConceiveInput
): Promise<ConceiveDaughterResult> {
  const now = deps.now ?? (() => Date.now())
  const status = await deps.repo.status()
  if (!status.ok) {
    return { ok: false, message: '记忆仓不可用，现在生不了（记忆不会丢）。' }
  }
  const read = await readLineage(deps.lineageFile)
  if (read.status !== 'ok') {
    return { ok: false, message: '家谱读不出来，先不传承（细节看日志）。' }
  }
  const lineage = read.lineage
  if (input.motherBranch !== lineage.active) {
    return { ok: false, message: '当前节点已经切走了，先 /use 回来再传承。' }
  }
  const mother = findBranch(lineage, input.motherBranch)
  if (mother === null || mother.status !== 'alive') {
    return { ok: false, message: '当前这一代不是活着的节点，不能传承。' }
  }
  if (mother.kind === 'assistant') {
    return { ok: false, message: '纯模型分支不是一条鱼，不能传承。' }
  }
  const motherLife = lifeOf(lineage, input.motherBranch)
  if (motherLife === null || motherLife.used < motherLife.limit * 0.85) {
    return { ok: false, message: '还没到传承的时候（生命剩得还多）。' }
  }
  const slug = slugifyNodeName(input.nickname)
  if (slug === null) {
    return { ok: false, message: '这个名字转不出可用的分支名（用英文 / 数字 / 短一些的中文）。' }
  }
  if (isTrunkName(slug)) {
    return { ok: false, message: `${slug} 是出生主干，不能当女儿的名字。` }
  }
  if (findBranch(lineage, slug) !== null) {
    return { ok: false, message: `节点 ${slug} 已经存在，换一个名字。` }
  }
  const branches = await deps.repo.listBranches()
  if (branches.some((entry) => entry.branch === slug)) {
    return { ok: false, message: `分支 ${slug} 已经存在，换一个名字。` }
  }

  const at = now()
  const letter = input.letter?.trim() ?? ''
  const letterPath = letter === '' ? null : `letters/${slug}.md`
  const saved = await deps.repo.commit(`memory: ${defaultMemoryName(at)}`)
  if (!saved.committed && saved.reason !== 'clean') {
    return { ok: false, message: '先保存当前节点失败，没有传承（记忆不会丢）。' }
  }

  const trunk = TRUNK_BRANCH
  const base = withTrunkNode(lineage, trunk, at)
  const next = withGenerationAdded(base, {
    branch: slug,
    nickname: slug,
    mother: input.motherBranch,
    at,
    letter: letterPath
  })
  if (next === null) return { ok: false, message: '家谱加不进新的一代。' }
  const snapshot = lineageSnapshot(next)

  // 1) 主干：先补「第一代出生」标记（新建主干时），再落这一代的出生提交
  const hasTrunk = branches.some((entry) => entry.branch === trunk)
  const trunkBranch = hasTrunk
    ? await deps.repo.switchBranch(trunk)
    : await deps.repo.switchCreateOrphan(trunk)
  if (!trunkBranch.ok) {
    return { ok: false, message: `切到 ${trunk} 主干失败，没有传承（记忆不会丢）。` }
  }
  if (!hasTrunk) {
    await deps.repo.writeFile('lineage.snapshot.json', lineageSnapshot(base))
    await deps.repo.commit(`memory: birth ${base.generations[0]?.branch ?? 'default'}`)
  }
  await deps.repo.writeFile('lineage.snapshot.json', snapshot)
  await deps.repo.commit(`memory: birth ${slug}`)

  // 2) 女儿：从**出生提交**分叉（图上是真分支），首个提交写母亲的信 + 出生记录 + 家谱快照。
  //    出生提交在主干的树上只有脚手架与快照、没有对话，所以她天然读不到母亲的记忆。
  const daughter = await deps.repo.switchCreate(slug)
  if (!daughter.ok) {
    await deps.repo.switchBranch(input.motherBranch)
    return { ok: false, message: '开女儿分支失败，没有传承（记忆不会丢）。' }
  }
  if (letterPath !== null) await deps.repo.writeFile(letterPath, `${letter}\n`)
  await deps.repo.writeFile('birth.json', birthRecord(slug, input.motherBranch, at))
  await deps.repo.writeFile('lineage.snapshot.json', snapshot)
  const born = await deps.repo.commit(`memory: born ${slug}`)
  if (!born.committed) {
    await deps.repo.switchBranch(input.motherBranch)
    return { ok: false, message: '女儿分支的首个提交失败，没有传承（记忆不会丢）。' }
  }

  // 3) 权威家谱最后写：git 已经一致，写失败就退回母亲节点，别让 active 与 HEAD 打架
  if (!(await writeLineage(deps.lineageFile, next))) {
    await deps.repo.switchBranch(input.motherBranch)
    return { ok: false, message: '家谱写不进去，传承没有生效（细节看日志）。' }
  }

  return {
    ok: true,
    nickname: slug,
    message: `女儿 ${slug} 已出生；这一代到这里，之后从空白开始。`
  }
}
