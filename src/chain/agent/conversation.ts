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
 * 2026-10-30 M3（D69）改口径：**不再自动裁剪**。生命 = 当前上下文 / 额度，
 * 自动丢旧轮会让生命永远涨不到额度、冻结与传承都不会发生；旧轮只在用户主动
 * `/compact` 时压成一份摘要（`compactAskConversation`），平时原样重放。
 * 图片不单独删：只有整轮被压掉时，图才随轮一起走。
 */

import type { CloudAskAttachments, CloudAskLoopTurn } from './payload'

/** 会话里的一轮：问题 + 当时的 <now> + 工具轮 + 最终答复 + 随问题发出去的附件 */
export interface CloudAskConversationTurn {
  /** 用户问题（已过策略） */
  readonly question: string
  /** 当时的 <now> 正文（已过策略；没有就空串） */
  readonly now: string
  /** 这一问里发生过的工具往返（含 reasoning / 截图） */
  readonly turns: readonly CloudAskLoopTurn[]
  /** 最终答复正文（模型原话） */
  readonly answer: string
  /**
   * 随问题一起发出去的附件（用户上传 / QQ 图片 / 选区截图）。**回放时必须原样带上**：
   * 少一张图，这条 user 消息的字节就变了，后面的前缀缓存全断。
   */
  readonly attachments?: CloudAskAttachments
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

/** 一轮的**文字**字符量：图片不计入预算（图片只在整轮被压缩掉时随轮删除） */
export function askConversationTurnChars(turn: CloudAskConversationTurn): number {
  const turns = turn.turns.map((item) => {
    if (item.images === undefined) return item
    const { images: _images, ...rest } = item
    return rest
  })
  const attachments = turn.attachments
    ? { images: [] as string[], files: turn.attachments.files }
    : undefined
  return JSON.stringify({
    ...turn,
    turns,
    ...(attachments !== undefined ? { attachments } : {})
  }).length
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
  /** 已不再生效（M3 起不自动裁剪）；保留字段只为兼容老调用方 */
  maxChars?: number
  /** 已不再生效；`/compact` 的保留轮数见 `compactAskConversation` */
  keepTurns?: number
}

/**
 * 追加一轮。**只追加，不裁剪**。
 *
 * 2026-10-30 M3（D69）改口径：以前到 80k 文字就自动丢最旧的轮次（D64），
 * 但生命 = 当前上下文 / 额度——自动裁剪会让生命永远停在 80k 字符附近，
 * 冻结与 M4 传承都不会发生。所以旧轮只在用户主动 `/compact` 时压成摘要
 * （`compactAskConversation`），平时原样重放；删图 / 删轮的时机仍然只有压缩。
 */
export function appendAskConversationTurn(
  previous: CloudAskConversation,
  turn: CloudAskConversationTurn,
  _options: AppendAskConversationOptions = {}
): CloudAskConversation {
  return { digest: previous.digest, turns: [...previous.turns, turn] }
}

/**
 * `/compact`：把「最近 keepTurns 轮」以外的旧轮压成一份摘要（LLM 产出，用户主动），
 * 拼进 digest；保留的轮次原文不动（含图片）。
 *
 * 旧摘要 + 新摘要都留在 digest 里，超 `ASK_CONVERSATION_DIGEST_MAX_CHARS` 时
 * 从**开头**截断（保留最近一次摘要的尾部）；旧轮原文仍在 git 历史里，可 `/use` 回看。
 */
export interface CompactAskConversationResult {
  conversation: CloudAskConversation
  /** 这次压掉几轮（0 = 没什么可压） */
  dropped: number
}

export function compactAskConversation(
  conversation: CloudAskConversation,
  summary: string,
  keepTurns = ASK_CONVERSATION_KEEP_TURNS
): CompactAskConversationResult {
  const keep = Math.max(1, Math.floor(keepTurns))
  if (conversation.turns.length <= keep) {
    return { conversation, dropped: 0 }
  }
  const dropped = conversation.turns.length - keep
  const parts = [conversation.digest.trim(), summary.trim()].filter((part) => part !== '')
  let digest = parts.join('\n')
  if (digest.length > ASK_CONVERSATION_DIGEST_MAX_CHARS) {
    digest = digest.slice(digest.length - ASK_CONVERSATION_DIGEST_MAX_CHARS)
  }
  return {
    conversation: { digest, turns: conversation.turns.slice(-keep) },
    dropped
  }
}
