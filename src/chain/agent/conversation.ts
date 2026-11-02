/** Conversation replay is append-only except explicit local placeholder compact.
 * All turns remain present; archived originals are session-scoped and recallable.
 * Previously persisted digests remain readable, but compact never creates a digest.
 */

import type { CloudAskAttachments, CloudAskLoopTurn } from './payload'
import { archiveIdOfText, filePlaceholder, type RecalledAttachment } from './archive'
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

/** 完整轮次；digest 只兼容旧版本已有摘要，新压缩不再生成摘要。 */
export interface CloudAskConversation {
  readonly digest: string
  readonly turns: readonly CloudAskConversationTurn[]
}

/** 主进程按 conversationId 存取；文件实现随记忆仓分支持久化。 */
export interface AskConversationPort {
  load(): CloudAskConversation
  save(next: CloudAskConversation): void
  /**
   * 清空这个会话（M4 传承：女儿从空白开始）。
   * 可选：老调用方 / 测试的假实现不必实现；主进程的两种实现都会清内存。
   */
  clear?(): void
  /** 本会话的本地原文归档；写成功后才能替换占位。 */
  archive?(entry: RecalledAttachment): boolean
  archives?(): readonly RecalledAttachment[]
}

/** 兼容旧调用方的字符预算；不再自动裁轮。 */
export const ASK_CONVERSATION_MAX_CHARS = 80_000
/** Legacy export; all turns now participate in explicit compact. */
export const ASK_CONVERSATION_KEEP_TURNS = 0
export const ASK_CONVERSATION_DIGEST_MAX_CHARS = 4_000

export function emptyAskConversation(): CloudAskConversation {
  return { digest: '', turns: [] }
}

/** 一轮的文字字符量；图片已有 D88 占位，不计 base64。 */
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

export interface AppendAskConversationOptions {
  /** 已不再生效（M3 起不自动裁剪）；保留字段只为兼容老调用方 */
  maxChars?: number
  /** 已不再生效；所有轮次均可参与显式压缩。 */
  keepTurns?: number
}

/** Append without automatic trimming. */
export function appendAskConversationTurn(
  previous: CloudAskConversation,
  turn: CloudAskConversationTurn,
  _options: AppendAskConversationOptions = {}
): CloudAskConversation {
  return { digest: previous.digest, turns: [...previous.turns, turn] }
}

/** Compact every turn without deleting history. Archive writes must succeed first. */
export interface CompactAskConversationResult {
  conversation: CloudAskConversation
  /** Number of turns changed (legacy field name, no turns are dropped). */
  dropped: number
}

export function compactAskConversation(
  conversation: CloudAskConversation,
  archive: (entry: RecalledAttachment) => boolean
): CompactAskConversationResult {
  let changed = 0
  const turns = conversation.turns.map((turn) => {
    let replaced = false
    const compact = (text: string, name: string): string => {
      if (text.length <= 256) return text
      const id = archiveIdOfText(text)
      if (!archive({ id, media: 'file', text, name })) throw new Error('compact archive write failed')
      replaced = true
      return filePlaceholder(name, id)
    }
    const record = (value: Record<string, unknown>, name: string): Record<string, unknown> => {
      if (value['kind'] === 'compact-archive') return value
      const text = JSON.stringify(value)
      const next = compact(text, name)
      return next === text ? value : { kind: 'compact-archive', id: archiveIdOfText(text), text: next }
    }
    const next: CloudAskConversationTurn = {
      ...turn,
      question: compact(turn.question, 'question'),
      answer: compact(turn.answer, 'answer'),
      now: compact(turn.now, 'now'),
      turns: turn.turns.map((item) => ({
        ...item,
        toolCall: { ...item.toolCall, arguments: record(item.toolCall.arguments, 'arguments') },
        toolResult: record(item.toolResult, 'tool-result'),
        ...(item.reasoning !== undefined ? { reasoning: compact(item.reasoning, 'reasoning') } : {})
      })),
      ...(turn.attachments !== undefined ? {
        attachments: { ...turn.attachments,
          files: turn.attachments.files.map((file) => ({ ...file, text: compact(file.text, file.name) })) }
      } : {}),
      ...(turn.quoted !== undefined ? {
        quoted: { ...turn.quoted, text: compact(turn.quoted.text, 'quoted') }
      } : {}),
      ...(turn.chatRecent !== undefined ? {
        chatRecent: turn.chatRecent.map((item) => ({ ...item, text: compact(item.text, 'recent') }))
      } : {})
    }
    if (replaced) changed += 1
    return replaced ? next : turn
  })
  return { conversation: changed > 0 ? { digest: conversation.digest, turns } : conversation, dropped: changed }
}
