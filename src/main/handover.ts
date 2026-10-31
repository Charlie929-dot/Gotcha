/**
 * 记忆仓 · 交接回执（D82，2026-10-31）
 *
 * 母亲生命耗尽、下一代接手时，界面上要有一行字：
 *
 * ```
 * === <贴心大肥鱼> 生命耗尽  ta的女儿 <鱼苗> 将接续ta的使命===
 * ```
 *
 * 出处只有家谱（仓外权威）：谁生谁、谁已经死了、各自叫什么。名字优先用家谱里的
 * **真名**（D82 起 `give_birth` 存模型给的原话）；老数据没起过名（nickname 等于分支名）
 * 就退回分支名，不编造。
 */

import { findBranch, generationOf, type Lineage, type LineageGeneration } from './lineage'

/** 一代人显示用的名字（D82）：真名优先，没起过名就用分支名 */
export function displayNameOf(generation: LineageGeneration): string {
  const name = generation.nickname.trim()
  return name !== '' ? name : generation.branch
}

/** 交接回执那一行（母亲的死讯 + 女儿接班）；名字由调用方给，格式照拍的样板 */
export function handoverReceiptText(names: { mother: string; daughter: string }): string {
  return `=== <${names.mother}> 生命耗尽  ta的女儿 <${names.daughter}> 将接续ta的使命===`
}

/**
 * 某条分支的交接回执：只有「这一代已经不在了（dead / 有 died_at）」且「下一代有人」才有。
 * 谁生谁是**代**之间的关系（同代的分支都算这一代），女儿有多条时取最新的那条。
 * 活着 / 没有女儿 / 家谱里查不到 → null（调用方不显示）。
 */
export function handoverReceiptOf(lineage: Lineage, branch: string): string | null {
  const generation = generationOf(lineage, branch)
  const node = findBranch(lineage, branch)
  if (generation === null || node === null) return null
  const gone = node.status === 'dead' || generation.died_at !== null
  if (!gone) return null
  const daughters = lineage.generations.filter((item) => item.mother === generation.id)
  if (daughters.length === 0) return null
  const daughter = daughters.reduce((latest, item) => (item.born_at > latest.born_at ? item : latest))
  return handoverReceiptText({
    mother: displayNameOf(generation),
    daughter: displayNameOf(daughter)
  })
}
