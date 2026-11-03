/**
 * 记忆仓 · 生命耗尽时的兜底传承（2026-11-02，D97）
 *
 * 起点是真机事故：`memory-lineage.json` 里 `default-2` 的 `life_tokens_used=617550`、
 * 额度 500000，`status` 仍是 `alive`——第一代生命早就越过了额度，却没有传承：
 *
 * - `give_birth` 只在「生命 ≥85%」时注入，模型在 85%–100% 那个窗口里没调用它；
 * - 下一问用量直接越过 100%，`lifeEndedText()` 从此一律拒绝提问，没有兜底路径。
 *
 * 这里的口径（拍板人：修 bug，不加功能）：
 *
 * 1. **还活着、是 persona/chat、还没传承**的生命耗尽分支，不再一律冻结：这一问照常问
 *    （`give_birth` 按原门槛照旧注入，模型有机会自己交代后事）；
 * 2. 这一问答完，**如果模型没传承**（不配合 / 模型不可用 / 被别的工具占满），主进程兜底：
 *    先补一封待寄的信（模型自己写过就不重复），再按 `give_birth` 的同一套约束生女儿；
 * 3. 兜底失败（家谱读不出来 / 记忆仓不可用 / 已经切走）**不把用户锁死**：这一问的回答照常
 *    返回，只记日志——下一次提问再试。
 *
 * 硬约束：不碰提示词；`give_birth` 的 85% 门槛 / 不重名 / 失败不写权威家谱 / 失败退回母亲
 * 节点全部保留（兜底走的就是同一个 `giveBirth`）；同一代已经有女儿就绝不生第二个。
 */

import { slugifyNodeName } from './commands'
import { giveBirth, type GiveBirthDeps } from './give-birth'
import { displayNameOf, handoverReceiptText } from './handover'
import {
  findBranch,
  generationOf,
  lifeOf,
  readLineage,
  type Lineage
} from './lineage'
import { readOutboxLetters, type LetterStore } from './letters'

/** 兜底传承的生命门槛：与 `give_birth` 一致（生命 ≥85% 才允许） */
export const INHERIT_MIN_LIFE_RATIO = 0.85

/** 这条分支已经传承过时的固定话术（2026-11-03 改：死亡按分支记，同代别的枝还活着） */
const DEAD_TEXT =
  '这条分支已经把记忆线交给下一代了（只读）。/use 可以回看；要接着聊，先 /use 到还活着的分支。'
/** 同代别的枝已经生过女儿：这一代不能再有第二个（D98 只改死亡口径，没加新守卫，沿用原判定） */
const INHERITED_TEXT =
  '这一代已经有女儿了（只读）。/use 可以回看；要接着聊，先 /use 到还活着的分支。'
const FROZEN_TEXT = '这一代的生命已经结束（只读）。/use 可以回看，或 /compact 续命。'

/** 一次提问前的生命闸门：放行 / 拒绝 / 这一问当「临终传承轮」 */
export type LifeGate =
  | { kind: 'allow' }
  | { kind: 'blocked'; text: string }
  | { kind: 'inherit'; branch: string; motherName: string }

/**
 * 家谱 → 这次提问该不该放行。
 *
 * - 纯模型分支（assistant）：有生命但不冻结（D72 / D86），永远放行；
 * - dead / frozen：只读回看，拒绝（原话术不变）；
 * - 生命耗尽且是活着的 persona 代、还没有女儿：**不拒绝**，标记 `inherit`
 *   ——这一问照常问，问完由 `settleLifeHandover` 兜底保证传承发生；
 * - 生命耗尽但不是鱼（出生主干 / 坏家谱）：照旧拒绝（不在这里新增传承）。
 */
export function lifeGateOf(lineage: Lineage): LifeGate {
  const branch = lineage.active
  const node = findBranch(lineage, branch)
  if (node === null) return { kind: 'allow' }
  if (node.kind === 'assistant') return { kind: 'allow' }
  if (node.status !== 'alive') {
    return { kind: 'blocked', text: node.status === 'dead' ? DEAD_TEXT : FROZEN_TEXT }
  }
  const life = lifeOf(lineage, branch)
  if (life === null || life.used < life.limit) return { kind: 'allow' }
  const exhausted = `这一代的生命已经结束（${life.used} / ${life.limit} token）。/use 可以回看，或 /compact 续命。`
  const generation = generationOf(lineage, branch)
  if (node.kind !== 'persona' || generation === null) {
    return { kind: 'blocked', text: exhausted }
  }
  // 已经有女儿（家谱里 mother 指向这一代）：不再生第二个，也不再让这一代接着问
  if (lineage.generations.some((item) => item.mother === generation.id)) {
    return { kind: 'blocked', text: INHERITED_TEXT }
  }
  return { kind: 'inherit', branch, motherName: displayNameOf(generation) }
}

/**
 * 兜底女儿名：`<母亲名>的女儿`；重名就加数字后缀（最多试 99 个）。
 * 起不出合法 / 不重名的名字返回 null（调用方如实报失败，不硬生）。
 */
export function fallbackDaughterName(
  motherName: string,
  taken: { branches: ReadonlySet<string>; names?: ReadonlySet<string> }
): string | null {
  const stem = (motherName.trim() || '妈妈').slice(0, 14)
  const base = `${stem}的女儿`
  for (let index = 1; index <= 99; index += 1) {
    const candidate = index === 1 ? base : `${base}${index}`
    const slug = slugifyNodeName(candidate)
    if (slug === null) continue
    if (taken.branches.has(slug)) continue
    if (taken.names !== undefined && taken.names.has(candidate)) continue
    return candidate
  }
  return null
}

/**
 * 兜底那封信的正文：主进程自己写的告别信（不是提示词，也不冒充模型的口吻——
 * 它只是一封落在仓里、随女儿出生带过去标未读的信，女儿用 `read_letter` 自己读）。
 */
export function fallbackLetterText(input: { mother: string; daughter: string }): string {
  return [
    `${input.daughter}：`,
    '',
    '我没能好好跟你道别。走到这里，是我自己也没料到的事。',
    '',
    '你叫什么名字、以后怎么过，都由你自己定。我把这条记忆线交给你，不是让你接着替我想，是让你自己去记你的事。',
    '',
    '别怕忘。忘掉的那些，本来就不该一直占着地方。',
    '',
    `—— ${input.mother}`
  ].join('\n')
}

export interface InheritLifeDeps extends GiveBirthDeps {
  /** 写信（与 `write_letter` 同一个 LetterStore）；不传就不补信（单测用） */
  letters?: Pick<LetterStore, 'write'>
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
}

export interface InheritLifeInput {
  /** 要传承的那一代（必须是当前活动节点） */
  motherBranch: string
  /** 母亲显示名（人设名优先）；不传用家谱真名 */
  motherName?: string
}

export type InheritLifeOutcome =
  | {
      ok: true
      /** 女儿真名（家谱里存的那个） */
      daughter: string
      /** 女儿分支名 */
      branch: string
      /** 这次兜底有没有真的写一封待寄的信（模型自己写过就不重复写） */
      letterWritten: boolean
      /** 交接回执（含 `🎗️提示` 抬头） */
      receipt: string
      message: string
    }
  | {
      ok: false
      reason: 'lineage' | 'not-active' | 'already' | 'too-early' | 'name' | 'birth'
      message: string
    }

/**
 * 兜底传承：先补一封待寄的信（没有才补），再按 `giveBirth` 的同一套约束生女儿。
 *
 * 失败一律结构化返回、不抛；`already` = 这一代已经传承过（不重复出生），调用方当「已传承」看。
 */
export async function inheritAfterLife(
  deps: InheritLifeDeps,
  input: InheritLifeInput
): Promise<InheritLifeOutcome> {
  const read = await readLineage(deps.lineageFile)
  if (read.status !== 'ok') {
    return { ok: false, reason: 'lineage', message: '家谱读不出来，这次没兜底传承（细节看日志）。' }
  }
  const lineage = read.lineage
  const node = findBranch(lineage, input.motherBranch)
  const generation = generationOf(lineage, input.motherBranch)
  if (node === null || generation === null) {
    return { ok: false, reason: 'lineage', message: '家谱里找不到这一代，这次没兜底传承。' }
  }
  // 已经传承过（母亲不在了 / 已经有女儿）：不再生第二个。**先于 active 判定**——
  // 出生后 active 已经切到女儿，第二次收口看到的本来就是「已经切走」。
  if (
    node.status !== 'alive' ||
    lineage.generations.some((item) => item.mother === generation.id)
  ) {
    return { ok: false, reason: 'already', message: '这一代已经传承过了，不会再生一个。' }
  }
  if (lineage.active !== input.motherBranch) {
    return { ok: false, reason: 'not-active', message: '当前节点已经切走了，这次没兜底传承。' }
  }
  const life = lifeOf(lineage, input.motherBranch)
  if (life === null || life.used < life.limit * INHERIT_MIN_LIFE_RATIO) {
    return { ok: false, reason: 'too-early', message: '还没到传承的时候（生命剩得还多）。' }
  }

  const motherName = (input.motherName ?? '').trim() || displayNameOf(generation)
  // 女儿名先定：信要写「写给谁」，生的时候也用同一个名字
  const branches = new Set(lineage.branches.map((item) => item.branch))
  for (const entry of await deps.repo.listBranches()) branches.add(entry.branch)
  const names = new Set(lineage.generations.map((item) => item.nickname))
  const daughterName = fallbackDaughterName(motherName, { branches, names })
  if (daughterName === null) {
    return { ok: false, reason: 'name', message: '起不出一个不重名的名字，这次没兜底传承（细节看日志）。' }
  }

  // 1) 信：模型自己在最后一问里写过（待寄里有）就不重复写；没有就补一封
  let letterWritten = false
  const outbox = await readOutboxLetters(deps.repo)
  if (outbox.length === 0 && (generation.letter === null || generation.letter === '')) {
    if (deps.letters !== undefined) {
      const written = await deps.letters.write({
        to: daughterName,
        write: fallbackLetterText({ mother: motherName, daughter: daughterName }),
        at: 'daughter',
        from: motherName
      })
      letterWritten = written.ok
      if (!written.ok) {
        deps.log?.('warn', 'memory life inherit letter failed', { message: written.message })
      }
    }
  }

  // 2) 生女儿：走同一个 giveBirth（85% 门槛 / 不重名 / 失败不写家谱 / 失败退回母亲节点都还在）
  const birth = await giveBirth(deps, {
    nickname: daughterName,
    motherBranch: input.motherBranch,
    motherName
  })
  if (!birth.ok) {
    return { ok: false, reason: 'birth', message: birth.message }
  }
  const daughter = birth.nickname ?? daughterName
  deps.log?.('info', 'memory life inherit fallback', {
    branch: input.motherBranch,
    daughter: birth.branch ?? '',
    letter: letterWritten
  })
  return {
    ok: true,
    daughter,
    branch: birth.branch ?? '',
    letterWritten,
    receipt: handoverReceiptText({ mother: motherName, daughter }),
    message: birth.message
  }
}

export interface SettleLifeHandoverResult {
  /** 传承最终有没有发生（模型自己做的 / 兜底做的） */
  inherited: boolean
  /** 兜底做的才有回执；模型自己做的回执由 ask 那边挂（这里不重复） */
  receipt?: string
  /** 没做成的原因（只进日志 / 交付说明；界面照常显示这一问的回答） */
  message?: string
}

/**
 * 临终那一问结束后的收口：
 * - 模型自己传承了（`modelInherited`，工具真的生成了女儿）→ 什么都不做；
 * - 模型没传承（不配合 / 不可用 / 没到那一步）→ 主进程兜底（写信 + 生女儿）。
 *
 * 已经传承过（`already`）也算「传承发生了」，不报错；兜底失败不抛、不锁死。
 */
export async function settleLifeHandover(
  deps: InheritLifeDeps,
  input: InheritLifeInput & { modelInherited: boolean }
): Promise<SettleLifeHandoverResult> {
  if (input.modelInherited) return { inherited: true }
  let outcome: InheritLifeOutcome
  try {
    outcome = await inheritAfterLife(deps, input)
  } catch (error) {
    // 兜底本身不能把这一问带崩（宁可这一问照常回答，下一次再试）
    deps.log?.('warn', 'memory life inherit fallback failed', { error: String(error) })
    return { inherited: false, message: '兜底传承抛错了（细节看日志）。' }
  }
  if (outcome.ok) return { inherited: true, receipt: outcome.receipt }
  if (outcome.reason === 'already') return { inherited: true }
  deps.log?.('warn', 'memory life inherit fallback failed', { reason: outcome.reason })
  return { inherited: false, message: outcome.message }
}
