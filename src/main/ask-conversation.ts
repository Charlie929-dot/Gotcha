/**
 * 问记忆 · 会话存储（主进程，D64）
 *
 * 只做一件事：按 `conversationId` 记住「上一问实际发出去的消息形态」，
 * 下一问由 `runAskLoop` 原样重放 + 追加。存内存，不落盘：
 * - 桌面重启后从 `ask-history`（问答历史）重新播种第一问，之后继续累积；
 * - QQ 会话本来就是内存态（D63），重启即弃。
 *
 * 上限按「会话数」而不是「总字符」：单个会话内部由
 * `chain/agent/conversation.ts` 的字符预算裁剪，这里只防止 Map 按用户数无限涨。
 */

import {
  emptyAskConversation,
  type AskConversationPort,
  type CloudAskConversation
} from '../chain/agent/conversation'

/** 同时保留多少个会话（桌面最近窗口 + QQ 白名单用户，32 足够） */
export const ASK_CONVERSATION_MAX_SESSIONS = 32

export function createAskConversationStore(): AskConversationPort {
  let state: CloudAskConversation = emptyAskConversation()
  return {
    load: () => state,
    save: (next) => {
      state = { digest: next.digest, turns: [...next.turns] }
    }
  }
}

export interface AskConversationRegistry {
  /** 取（或新建）某个会话的存储；最近用过的排到最后，超上限淘汰最久未用的 */
  for(conversationId: string): AskConversationPort
  /** 清空全部会话（清空问答历史时一起清） */
  clear(): void
  size(): number
}

export function createAskConversationRegistry(
  options: { maxSessions?: number } = {}
): AskConversationRegistry {
  const maxSessions = Math.max(1, options.maxSessions ?? ASK_CONVERSATION_MAX_SESSIONS)
  const stores = new Map<string, AskConversationPort>()
  return {
    for(conversationId) {
      const existing = stores.get(conversationId)
      if (existing !== undefined) {
        // LRU：重新插入到最后
        stores.delete(conversationId)
        stores.set(conversationId, existing)
        return existing
      }
      const store = createAskConversationStore()
      stores.set(conversationId, store)
      while (stores.size > maxSessions) {
        const oldest = stores.keys().next().value
        if (oldest === undefined) break
        stores.delete(oldest)
      }
      return store
    },
    clear() {
      stores.clear()
    },
    size() {
      return stores.size
    }
  }
}
