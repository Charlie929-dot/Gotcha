/**
 * 确定性假 LLM（E2E / 假归纳链路；M2 Phase 2）
 *
 * 只在 `GOTCHA_FAKE_LLM=1` + 临时 userData + 非打包态启用；不读取任何环境密钥、不发网络。
 * 输出必须能通过 `validateInduction()`：每个输入事件 id 恰好被一个节点覆盖、标题/摘要长度
 * 在契约内、边只连本批节点。测试与 E2E 通过 `counters` 断言「零真实请求 / 暂停取消」。
 */

import type {
  ChainAskLoopPayload,
  ChainAskPayload,
  ChainExtractPayload,
  ChainMergePayload,
  CloudPayload,
  ThemeAssignmentPayload,
  ThemeNamingPayload
} from '../understand/cloud/redact'
import {
  LlmAbortError,
  type LlmAskLoopResult,
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
    },

    /** 命名：用第一个时刻的代表 id 拼标题，保证 E2E 断言可复现 */
    async completeNaming(
      payload: ThemeNamingPayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmJsonResult> {
      counters.requests += 1
      counters.lastEventIds = payload.moments.flatMap((moment) => [...moment.eventIds])
      try {
        if (delayMs > 0 || callOptions.signal) {
          await abortableDelay(delayMs, callOptions.signal)
        }
      } catch (error) {
        if (error instanceof LlmAbortError) counters.aborted += 1
        throw error
      }
      const first = payload.moments[0]
      const promptTokens = 60 + counters.lastEventIds.length
      return {
        json: {
          title: truncate(`模拟主题 ${first?.eventIds[0] ?? 0}`, 24),
          summary: truncate(`来自 ${first?.app ?? '未知应用'} 的模拟命名`, 80),
          type: 'knowledge'
        },
        usage: { promptTokens, completionTokens: 12 }
      }
    },

    /** 模糊确认：每个时刻归给它的第一个候选主题（候选为空时给空数组） */
    async completeAssignments(
      payload: ThemeAssignmentPayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmJsonResult> {
      counters.requests += 1
      try {
        if (delayMs > 0 || callOptions.signal) {
          await abortableDelay(delayMs, callOptions.signal)
        }
      } catch (error) {
        if (error instanceof LlmAbortError) counters.aborted += 1
        throw error
      }
      const assignments = payload.moments.map((moment) => ({
        moment_id: moment.momentId,
        theme_ids: moment.candidateThemeIds.length > 0 ? [moment.candidateThemeIds[0]] : []
      }))
      return {
        json: { assignments },
        usage: { promptTokens: 120 + payload.moments.length * 10, completionTokens: 8 + assignments.length * 4 }
      }
    },

    /** 信息链派生：每段给一个确定性的标签 / 双链名字（带段 id，避免跨段意外合并） */
    async completeChainExtract(
      payload: ChainExtractPayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmJsonResult> {
      counters.requests += 1
      try {
        if (delayMs > 0 || callOptions.signal) {
          await abortableDelay(delayMs, callOptions.signal)
        }
      } catch (error) {
        if (error instanceof LlmAbortError) counters.aborted += 1
        throw error
      }
      const first = payload.segments[0]
      const segmentId = first?.segmentId ?? 0
      return {
        json: {
          tags: [truncate(`模拟主题 ${segmentId}`, 24)],
          links: [truncate(`模拟概念 ${segmentId}`, 40)]
        },
        usage: { promptTokens: 80 + payload.segments.length * 20, completionTokens: 10 }
      }
    },

    /** 问记忆（S1）：确定性回答，只引用第一段证据（白名单路径可断言） */
    async completeAsk(
      payload: ChainAskPayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmJsonResult> {
      counters.requests += 1
      try {
        if (delayMs > 0 || callOptions.signal) {
          await abortableDelay(delayMs, callOptions.signal)
        }
      } catch (error) {
        if (error instanceof LlmAbortError) counters.aborted += 1
        throw error
      }
      const first = payload.evidence[0]
      const citations = first
        ? [{ segmentId: first.segmentId, why: truncate(`模拟依据 ${first.segmentId}`, 40) }]
        : []
      return {
        json: {
          answer: first
            ? truncate(`模拟回答：在「${first.title}」里做过相关的事（依据 ${first.segmentId}）`, 200)
            : '信息链里没找到',
          citations
        },
        usage: { promptTokens: 120 + payload.evidence.length * 30, completionTokens: 20 }
      }
    },

    /**
     * 问记忆 · 工具循环（toolloop）：三步脚本——先检索最近的段，再打开第一段，
     * 最后直接说话（引用由驱动层按「已读」自动带出，不再靠模型写 citations）。
     * E2E 断言「answer / no-evidence / citations」路径全部可复现。
     */
    async completeAskLoop(
      payload: ChainAskLoopPayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmAskLoopResult> {
      counters.requests += 1
      try {
        if (delayMs > 0 || callOptions.signal) {
          await abortableDelay(delayMs, callOptions.signal)
        }
      } catch (error) {
        if (error instanceof LlmAbortError) counters.aborted += 1
        throw error
      }
      const searched = payload.turns.some((turn) => turn.toolCall.name === 'search_info')
      if (!searched) {
        return {
          toolCalls: [{ id: 'fake_call_search', name: 'search_info', arguments: { from: 0, limit: 5 } }],
          usage: { promptTokens: 100, completionTokens: 5 }
        }
      }
      const hits = payload.turns.flatMap((turn) => {
        const result = turn.toolResult as { kind?: string; hits?: Array<{ segmentId: number; at: string; title: string }> }
        return result.kind === 'search_info' ? (result.hits ?? []) : []
      })
      const first = hits[0]
      const opened = payload.turns.some((turn) => turn.toolCall.name === 'read_segment')
      if (first !== undefined && !opened) {
        return {
          toolCalls: [{ id: 'fake_call_read', name: 'read_segment', arguments: { segmentId: first.segmentId } }],
          usage: { promptTokens: 120, completionTokens: 6 }
        }
      }
      return {
        json: first
          ? { answer: truncate(`模拟回答：在「${first.title}」里做过相关的事（${first.at}）`, 200) }
          : { answer: '信息链里没找到' },
        usage: { promptTokens: 150, completionTokens: 20 }
      }
    },

    /** 信息链派生：模糊带一律判「同一个」（确定性，E2E 断言合并路径） */
    async completeChainMerge(
      payload: ChainMergePayload,
      callOptions: LlmCompleteOptions = {}
    ): Promise<LlmJsonResult> {
      counters.requests += 1
      try {
        if (delayMs > 0 || callOptions.signal) {
          await abortableDelay(delayMs, callOptions.signal)
        }
      } catch (error) {
        if (error instanceof LlmAbortError) counters.aborted += 1
        throw error
      }
      return {
        json: { same: payload.pairs.map(() => true) },
        usage: { promptTokens: 40 + payload.pairs.length * 10, completionTokens: 4 }
      }
    }
  }

  return { client, counters }
}
