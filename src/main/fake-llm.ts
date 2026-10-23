/**
 * 确定性假 LLM（E2E / 假归纳链路；M2 Phase 2）
 *
 * 只在 `GOTCHA_FAKE_LLM=1` + 临时 userData + 非打包态启用；不读取任何环境密钥、不发网络。
 * 输出必须能通过 `validateInduction()`：每个输入事件 id 恰好被一个节点覆盖、标题/摘要长度
 * 在契约内、边只连本批节点。测试与 E2E 通过 `counters` 断言「零真实请求 / 暂停取消」。
 */

import type { CloudPayload } from '../understand/cloud/redact'
import {
  LlmAbortError,
  type LlmClient,
  type LlmCompleteOptions,
  type LlmJsonResult
} from '../understand/cloud/llm-client'

export interface FakeLlmCounters {
  requests: number
  aborted: number
  /** 最近一次请求覆盖的事件 id（断言暂停后不再收到新批） */
  lastEventIds: number[]
}

export interface DeterministicFakeLlm {
  client: LlmClient
  counters: FakeLlmCounters
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmAbortError())
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new LlmAbortError())
      },
      { once: true }
    )
  })
}

/**
 * 每个「时刻」产出一个节点（标题带代表事件 id，避免跨批同名合并干扰断言），
 * 相邻节点连边；usage 按载荷规模确定性生成。
 */
export function createDeterministicFakeLlm(options: { delayMs?: number } = {}): DeterministicFakeLlm {
  const delayMs = Math.max(0, options.delayMs ?? 0)
  const counters: FakeLlmCounters = { requests: 0, aborted: 0, lastEventIds: [] }

  const client: LlmClient = {
    async completeJson(
      payload: CloudPayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmJsonResult> {
      counters.requests += 1
      counters.lastEventIds = payload.events.flatMap((event) => [...event.eventIds])
      try {
        if (delayMs > 0 || callOptions.signal) {
          await abortableDelay(delayMs, callOptions.signal)
        }
      } catch (error) {
        if (error instanceof LlmAbortError) counters.aborted += 1
        throw error
      }

      const nodes = payload.events.map((event, index) => ({
        title: truncate(`模拟主题 ${event.id}`, 24),
        summary: truncate(`来自 ${event.app} 的模拟归纳`, 80),
        type: index % 2 === 1 ? 'activity' : 'knowledge',
        event_ids: [...event.eventIds]
      }))
      const edges = nodes.slice(1).map((_node, index) => ({
        from: index,
        to: index + 1,
        weight: 0.5,
        evidence: '模拟关联'
      }))
      const promptTokens = 100 + counters.lastEventIds.length
      const completionTokens = 20 + nodes.length * 10
      return {
        json: { nodes, edges },
        usage: { promptTokens, completionTokens }
      }
    }
  }

  return { client, counters }
}
