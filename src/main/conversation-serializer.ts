/**
 * 问答会话的按键值串行器。
 *
 * 桌面与 QQ 可以写同一段会话：同一会话必须按进入顺序完整跑完（含落盘与回复），
 * 不同会话不互相阻塞。前一轮失败只影响自己，不能堵死后续队列。
 */
export interface ConversationSerializer {
  run<T>(conversationId: string, task: () => Promise<T>): Promise<T>
}

export function createConversationSerializer(): ConversationSerializer {
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(conversationId) ?? Promise.resolve()
      const next = previous.then(task)
      const tail = next.then(
        () => undefined,
        () => undefined
      )
      tails.set(conversationId, tail)
      void tail.then(() => {
        if (tails.get(conversationId) === tail) tails.delete(conversationId)
      })
      return next
    }
  }
}
