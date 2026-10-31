/**
 * 记忆仓 · 交接回执与回执抬头（D82 / D83，2026-10-31）
 *
 * 母亲生命耗尽、下一代接手时，界面上要有一行字：
 *
 * ```
 * 🎗️提示
 * ✨<贴心大肥鱼> 生命耗尽  ta的女儿 ✨<小满> 将接续ta的使命
 * ```
 *
 * 样式（D83，拍板人定）：回执和提示**不用 `===…===` 标记**，统一以 `🎗️提示` 起头；
 * 名字 / 分支 / 提交这类「占位符」前面加 `✨`，一眼能看出哪里是可变的。
 *
 * 出处只有家谱（仓外权威）：谁生谁、谁已经死了、各自叫什么。名字优先用家谱里的
 * **真名**（D82 起 `give_birth` 存模型给的原话）；老数据没起过名（nickname 等于分支名）
 * 就退回分支名，不编造。
 */

import { findBranch, generationOf, type Lineage, type LineageGeneration } from './lineage'

/** 回执 / 提示的抬头（D83：取代 `===xxx===`） */
export const RECEIPT_HEAD = '🎗️提示'

/** 一条回执：抬头 + 正文（正文里的占位符自己带 ✨） */
export function receiptText(body: string): string {
  return `${RECEIPT_HEAD}\n${body}`
}

/** 一代人显示用的名字（D82）：真名优先，没起过名就用分支名 */
export function displayNameOf(generation: LineageGeneration): string {
  const name = generation.nickname.trim()
  return name !== '' ? name : generation.branch
}

/** 交接回执的正文（不带抬头）：母亲的死讯 + 女儿接班 */
export function handoverReceiptBody(names: { mother: string; daughter: string }): string {
  return `✨<${names.mother}> 生命耗尽  ta的女儿 ✨<${names.daughter}> 将接续ta的使命`
}

/** 完整交接回执（抬头 + 正文），出生那一刻直接用它 */
export function handoverReceiptText(names: { mother: string; daughter: string }): string {
  return receiptText(handoverReceiptBody(names))
}

/**
 * 某条分支的交接回执**正文**（不带抬头，方便和别的回执拼在同一个抬头下）：
 * 只有「这一代已经不在了（dead / 有 died_at）」且「下一代有人」才有。
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
  return handoverReceiptBody({
    mother: displayNameOf(generation),
    daughter: displayNameOf(daughter)
  })
}
