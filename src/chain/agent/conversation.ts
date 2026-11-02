/**
 * 问记忆 · 会话消息（2026-10-30，D64；2026-11-02 改压缩口径，D97）
 *
 * 目标：同一会话的每次提问只**追加**消息，前面的字节不变——这样前缀缓存
 * （DeepSeek 的 context caching 按前缀命中）才有意义。这个模块只定义
 * 「会话里存什么」和「超限时怎么压」，不碰网络、不碰提示词拼装。
 *
 * 存的是**已经过出云策略的云端视图**（`CloudAskConversationTurn`）：
 * - 这些消息当时就是按这个形态发出去的，回放时逐字节一致；
 * - 不能再过一次脱敏墙（否则 `[已脱敏]` 会被二次处理，前缀就变了）；
 * - 它们只能由 `buildAskLoopPayload()` 产出，主进程只负责按会话存取。
 *
 * 2026-10-30 M3（D69）：**不再自动裁剪**。生命 = 当前上下文 / 额度，
 * 自动丢旧轮会让生命永远涨不到额度、冻结与传承都不会发生。
 *
 * 2026-11-02（D97，拍板人口径「压缩要覆盖所有轮次；从出生以来的所有聊天都要保留；
 * 只有占位可以替换」）：`/compact` **不再保留最近 N 轮**、不再把旧轮摘要掉、不再删轮。
 * 所有轮次都留在存储里，只把每轮里超长的问题 / 答复 / 附件正文记成「已压缩」——
 * 送云时（`placeholdAskTurn`）换成一行占位符，原文用 `recall` 按 id 取回。
 * `compactedTurns` = 已经覆盖到第几轮（前 N 轮），旧文件缺省 0。
 */

import {
  archiveIdOfText,
  askPartPlaceholder,
  filePlaceholder,
  shouldPlaceholdAskPart
} from './archive'
import type { CloudAskAttachments, CloudAskLoopTurn } from './payload'
import type { ChainAskChatRecent, ChainAskQuotedMessage } from './types'

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
  /**
   * QQ 引用与最近聊天（D96）。回放时必须原样带上：少一段，这条 user 消息的字节
   * 就变了，后面的前缀缓存全断。
   */
  readonly quoted?: ChainAskQuotedMessage
  readonly chatRecent?: readonly ChainAskChatRecent[]
}

/**
 * 一次会话的完整可见历史。
 *
 * `digest` 只给**老会话**（2026-11-02 之前的 `/compact` 把旧轮摘要掉、并从 turns 里删了）：
 * 那些轮次已经不在存储里，摘要仍挂在第一条 user 消息前。新口径不再往里写东西。
 */
export interface CloudAskConversation {
  readonly digest: string
  readonly turns: readonly CloudAskConversationTurn[]
  /**
   * `/compact` 已经覆盖到第几轮（2026-11-02）：前 N 轮在送云时把超长的问答正文 /
   * 附件正文换成占位符（原文仍在 `turns` 里，`recall` 取回）。0 / 缺省 = 没压过。
   */
  readonly compactedTurns?: number
}

/** 主进程按 conversationId 存取；只做内存 KV，不做持久化（重启后从问答历史重新播种） */
export interface AskConversationPort {
  load(): CloudAskConversation
  save(next: CloudAskConversation): void
  /**
   * 清空这个会话（M4 传承：女儿从空白开始）。
   * 可选：老调用方 / 测试的假实现不必实现；主进程的两种实现都会清内存。
   */
  clear?(): void
}

/** digest 自身也有上限：它是每轮都要重发的固定前缀，不能无限长（只给老会话） */
export const ASK_CONVERSATION_DIGEST_MAX_CHARS = 4_000

export function emptyAskConversation(): CloudAskConversation {
  return { digest: '', turns: [] }
}

/** 一轮的**文字**字符量：图片不计入预算 */
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

/** 会话在**存储里**的字符量（原文都在；不含图片里 base64 那种一次性内容） */
export function askConversationChars(conversation: CloudAskConversation): number {
  let total = conversation.digest.length
  for (const turn of conversation.turns) total += askConversationTurnChars(turn)
  return total
}

/** 已覆盖轮数（负数 / 坏值按 0；超过总轮数按总轮数） */
export function compactedTurnsOf(conversation: CloudAskConversation): number {
  const raw = conversation.compactedTurns
  const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0
  return Math.min(count, conversation.turns.length)
}

/** 这一轮的问题在送云时的样子：被 `/compact` 覆盖且超长就换占位符 */
function sentQuestionOf(turn: CloudAskConversationTurn, compacted: boolean): string {
  return compacted && shouldPlaceholdAskPart(turn.question)
    ? askPartPlaceholder('question', archiveIdOfText(turn.question))
    : turn.question
}

/** 这一轮的答复在送云时的样子 */
function sentAnswerOf(turn: CloudAskConversationTurn, compacted: boolean): string {
  return compacted && shouldPlaceholdAskPart(turn.answer)
    ? askPartPlaceholder('answer', archiveIdOfText(turn.answer))
    : turn.answer
}

/**
 * `/compact` 之后**送云**的字符量（估算；只数压缩真正会改变的部分）。
 *
 * 问题 / 答复 / 附件正文：被覆盖的轮次里超长的换占位符；
 * 工具结果与图片不在其中——它们在历史轮次回放时本来就是占位符（D88 / D89），
 * 压缩前后一样，放进比值只会稀释比例。数字只用来算「压完还剩多少」（`usageAfterCompact`），
 * 不参与出云判定。
 */
export function askConversationSentChars(conversation: CloudAskConversation): number {
  const compacted = compactedTurnsOf(conversation)
  let total = 0
  conversation.turns.forEach((turn, index) => {
    const covered = index < compacted
    total += sentQuestionOf(turn, covered).length
    total += sentAnswerOf(turn, covered).length
    for (const file of turn.attachments?.files ?? []) {
      total += covered && shouldPlaceholdAskPart(file.text)
        ? filePlaceholder(file.name, archiveIdOfText(file.text)).length
        : file.text.length
    }
  })
  return total
}

/**
 * 一轮的「压缩后送云视图」：超长的问题 / 答复 / 附件正文换成占位符。
 * 原文不动（还在存储里），`recall` 按占位符里的 id 取回。
 */
export function placeholdAskTurn(turn: CloudAskConversationTurn): CloudAskConversationTurn {
  const attachments: CloudAskAttachments | undefined =
    turn.attachments === undefined
      ? undefined
      : {
          images: turn.attachments.images,
          files: turn.attachments.files.map((file) =>
            shouldPlaceholdAskPart(file.text)
              ? { name: file.name, text: filePlaceholder(file.name, archiveIdOfText(file.text)) }
              : file
          )
        }
  return {
    ...turn,
    question: sentQuestionOf(turn, true),
    answer: sentAnswerOf(turn, true),
    ...(attachments !== undefined ? { attachments } : {})
  }
}

/** 会话里有多少段正文超过了占位阈值（问题 / 答复 / 附件正文） */
function countPlaceholdableParts(turns: readonly CloudAskConversationTurn[]): number {
  let total = 0
  for (const turn of turns) {
    if (shouldPlaceholdAskPart(turn.question)) total += 1
    if (shouldPlaceholdAskPart(turn.answer)) total += 1
    for (const file of turn.attachments?.files ?? []) {
      if (shouldPlaceholdAskPart(file.text)) total += 1
    }
  }
  return total
}

export interface AppendAskConversationOptions {
  /** 已不再生效（M3 起不自动裁剪）；保留字段只为兼容老调用方 */
  maxChars?: number
  /** 已不再生效（D97 起压缩覆盖所有轮次）；保留字段只为兼容老调用方 */
  keepTurns?: number
}

/**
 * 追加一轮。**只追加，不裁剪**。
 *
 * 2026-10-30 M3（D69）改口径：以前到 80k 文字就自动丢最旧的轮次（D64），
 * 但生命 = 当前上下文 / 额度——自动裁剪会让生命永远停在 80k 字符附近，
 * 冻结与 M4 传承都不会发生。所以旧轮只在用户主动 `/compact` 时压缩
 * （`compactAskConversation`），平时原样重放。
 */
export function appendAskConversationTurn(
  previous: CloudAskConversation,
  turn: CloudAskConversationTurn,
  _options: AppendAskConversationOptions = {}
): CloudAskConversation {
  const compacted = compactedTurnsOf(previous)
  return {
    digest: previous.digest,
    turns: [...previous.turns, turn],
    // 新加的这一轮不算「已压过」：下次 `/compact` 才覆盖它
    ...(compacted > 0 ? { compactedTurns: compacted } : {})
  }
}

export interface CompactAskConversationResult {
  conversation: CloudAskConversation
  /** 这次新覆盖了几轮（0 = 都已经压过 / 还没有轮次） */
  covered: number
  /** 压完之后有多少段正文会在送云时换成占位符（问题 / 答复 / 附件正文） */
  placeheld: number
}

/**
 * `/compact`（2026-11-02 改口径，D97）：**覆盖所有轮次**。
 *
 * 不删轮、不用摘要换掉原文：只把 `compactedTurns` 推到总轮数，送云时前 N 轮里
 * 超长的问答正文 / 附件正文换成占位符（`placeholdAskTurn`）。原文还在会话存储里，
 * `recall` 取回；`/log`、git 历史读到的也还是全文。重复执行幂等。
 */
export function compactAskConversation(
  conversation: CloudAskConversation
): CompactAskConversationResult {
  const total = conversation.turns.length
  const before = compactedTurnsOf(conversation)
  if (total === 0) return { conversation, covered: 0, placeheld: 0 }
  return {
    conversation: {
      digest: conversation.digest,
      turns: conversation.turns,
      compactedTurns: total
    },
    covered: Math.max(0, total - before),
    placeheld: countPlaceholdableParts(conversation.turns)
  }
}
