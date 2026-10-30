/**
 * 问记忆 · 会话消息（2026-10-30，D64）
 *
 * 目标：同一会话的每次提问只**追加**消息，前面的字节不变——这样前缀缓存
 * （DeepSeek 的 context caching 按前缀命中）才有意义。这个模块只定义
 * 「会话里存什么」和「超限时怎么裁」，不碰网络、不碰提示词拼装。
 *
 * 存的是**已经过出云策略的云端视图**（`CloudAskConversationTurn`）：
 * - 这些消息当时就是按这个形态发出去的，回放时逐字节一致；
 * - 不能再过一次脱敏墙（否则 `[已脱敏]` 会被二次处理，前缀就变了）；
 * - 它们只能由 `buildAskLoopPayload()` 产出，主进程只负责按会话存取。
 *
 * 裁剪是确定性的（不调模型）：超过字符预算时，从最旧的一轮开始丢，
 * 把「问 / 答」压成一行摘要放进 `digest`；最近 `KEEP_TURNS` 轮永远保留全文。
 * 不做 LLM 摘要（多一次出云、多一份账单，先让结构跑通）。
 */

import type { CloudAskLoopTurn } from './payload'

/** 会话里的一轮：问题 + 当时的 <now> + 工具轮 + 最终答复 */
export interface CloudAskConversationTurn {
  /** 用户问题（已过策略） */
  readonly question: string
  /** 当时的 <now> 正文（已过策略；没有就空串） */
  readonly now: string
  /** 这一问里发生过的工具往返（含 reasoning / 截图） */
  readonly turns: readonly CloudAskLoopTurn[]
  /** 最终答复正文（模型原话） */
  readonly answer: string
}

/** 一次会话的完整可见历史：更早的部分压成 digest，最近的在 turns 里 */
export interface CloudAskConversation {
  readonly digest: string
  readonly turns: readonly CloudAskConversationTurn[]
}

/** 主进程按 conversationId 存取；只做内存 KV，不做持久化（重启后从问答历史重新播种） */
export interface AskConversationPort {
  load(): CloudAskConversation
  save(next: CloudAskConversation): void
}

/** 会话字符预算：超过就裁最旧的轮次（约 40k 汉字 / 80k 字符，给工具结果留余量） */
export const ASK_CONVERSATION_MAX_CHARS = 80_000
/** 最近几轮永远保留全文（裁剪只动更早的） */
export const ASK_CONVERSATION_KEEP_TURNS = 8
/** digest 自身也有上限：它是每轮都要重发的固定前缀，不能无限长 */
export const ASK_CONVERSATION_DIGEST_MAX_CHARS = 4_000
/** digest 一行里问题 / 答复的截断长度 */
const DIGEST_QUESTION_MAX_CHARS = 80
const DIGEST_ANSWER_MAX_CHARS = 120

export function emptyAskConversation(): CloudAskConversation {
  return { digest: '', turns: [] }
}

/** 一轮的字符量（JSON 形态，和真正发出去的消息量级一致） */
export function askConversationTurnChars(turn: CloudAskConversationTurn): number {
  return JSON.stringify(turn).length
}

export function askConversationChars(conversation: CloudAskConversation): number {
  let total = conversation.digest.length
  for (const turn of conversation.turns) total += askConversationTurnChars(turn)
  return total
}

/** 被裁掉的一轮 → 一行摘要（问题 / 答复各截一段，空白压平） */
export function digestLineOf(turn: CloudAskConversationTurn): string {
  const question = turn.question.replace(/\s+/gu, ' ').trim().slice(0, DIGEST_QUESTION_MAX_CHARS)
  const answer = turn.answer.replace(/\s+/gu, ' ').trim().slice(0, DIGEST_ANSWER_MAX_CHARS)
  if (question === '' && answer === '') return ''
  if (answer === '') return `- 问：${question}`
  return `- 问：${question || '（无）'} → 答：${answer}`
}

function appendDigest(digest: string, line: string): string {
  if (line === '') return digest
  const next = digest === '' ? line : `${digest}\n${line}`
  return next.length <= ASK_CONVERSATION_DIGEST_MAX_CHARS
    ? next
    : next.slice(next.length - ASK_CONVERSATION_DIGEST_MAX_CHARS)
}

export interface AppendAskConversationOptions {
  maxChars?: number
  keepTurns?: number
}

/**
 * 追加一轮并按预算裁剪：只丢最旧的，最近 `keepTurns` 轮即使超预算也保留。
 * 纯函数——主进程 / 测试同一套口径，不依赖时间与模型。
 */
export function appendAskConversationTurn(
  previous: CloudAskConversation,
  turn: CloudAskConversationTurn,
  options: AppendAskConversationOptions = {}
): CloudAskConversation {
  const maxChars = Math.max(1, options.maxChars ?? ASK_CONVERSATION_MAX_CHARS)
  const keepTurns = Math.max(1, options.keepTurns ?? ASK_CONVERSATION_KEEP_TURNS)
  const turns = [...previous.turns, turn]
  let digest = previous.digest
  let total = askConversationChars(previous) + askConversationTurnChars(turn)

  while (total > maxChars && turns.length > keepTurns) {
    const dropped = turns.shift()
    if (dropped === undefined) break
    total -= askConversationTurnChars(dropped)
    digest = appendDigest(digest, digestLineOf(dropped))
  }

  return { digest, turns }
}
