/**
 * 归纳运行时（M2 Phase 2 主进程接线）
 *
 * 在 Phase 1 `createInductionService()` 之上补三件事：
 * 1. **采集生命周期联动**（D18）：采集 running 才自动归纳；暂停 / 停止即停定时器并 abort
 *    在途请求；暂停期间「立即归纳」也直接跳过（零出网）；
 * 2. **一次性出网确认门**（2026-10-23 拍板，见 decisions D24）：`graph.outbound_consent`
 *    未置 1 时自动归纳不启动、`runOnce` 返回 `consent`，用户在图谱窗口显式确认后才出网；
 * 3. **状态快照**：把 service 状态 + 确认门 + 供应商配置状态合成给图谱窗口，未配置 / 缺 key
 *    只显示原因，不抛到采集链路。
 * 4. **可观测性**：每次跑完（自动 / 手动 / 跳过）打一行结构化日志——状态、失败分类（HTTP 状态码 /
 *    超时 / 网络 / 解析 / 配置）、连续失败次数、是否停自动、token 与耗时；不记提示词、
 *    响应正文、密钥。没有这行日志，「为什么在退避」只能靠猜。
 *
 * 本文件保持 Electron-free（Db / LlmClient 注入），调度与落库仍在 service / induction。
 */

import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'
import type { LlmClient } from '../understand/cloud/llm-client'
import {
  createInductionService,
  type InductionRunMeta,
  type InductionService,
  type InductionState,
  type InductionStatus,
  type RunOutcome
} from '../understand/service'
import { GRAPH_SETTING_KEYS } from './graph-settings'
import type { CaptureStatus } from './capture-controller'

export type ClientFailureReason =
  | 'missing-key'
  | 'invalid-providers'
  | 'unknown-provider'
  | 'invalid-config'

export type ClientResolution =
  | { ok: true; client: LlmClient }
  | { ok: false; reason: ClientFailureReason; apiKeyEnv?: string }

/** 运行时比 service 多一个「未确认出网」跳过原因 */
export type InductionRunOutcome = RunOutcome | { status: 'skipped'; reason: 'consent' }

export interface ClientStatusView {
  ok: boolean
  reason?: ClientFailureReason
  /** 缺失的是哪个环境变量名（不含值） */
  apiKeyEnv?: string
}

export interface InductionSnapshot extends InductionState {
  consent: boolean
  captureRunning: boolean
  client: ClientStatusView
  /**
   * 本地向量模型是否就绪（`model.onnx` + `vocab.txt` 都在）。
   * false 时新主题 / embedding 连线算不出来，但已有向量与边照常画（顶部黄条提示，不清图）。
   */
  embeddingsReady: boolean
}

export interface InductionRuntimeOptions {
  /** 写连接（懒获取，避免默认暂停时建库）；只在真正需要跑批 / 写确认门时调用 */
  getDb: () => Db
  resolveClient: () => ClientResolution
  /** 读确认门；无库时返回 false 且不建库（主进程用只读连接实现） */
  readConsent?: () => boolean
  now?: () => number
  firstDelayMs?: number
  intervalMs?: number
  onSnapshot?: (snapshot: InductionSnapshot) => void
  /**
   * 归纳成功落库后回调（只有节点 / 边 / 占位真的有变化才触发）。
   * 主进程用它推 `graph:changed`：开着的图谱窗口就地刷新，自动归纳跑完不用用户再点刷新。
   * 失败 / 跳过 / 取消不触发（画布没有任何变化）。
   */
  onGraphChanged?: (outcome: Extract<RunOutcome, { status: 'ok' }>) => void
  /**
   * 本地向量模型是否就绪（缺省视为就绪：没接线的地方不该凭空报黄条）。
   * 每次取快照现读，用户装好模型后下一次刷新就能消失。
   */
  readEmbeddingsReady?: () => boolean
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export interface InductionRuntime {
  onCaptureStatus(status: CaptureStatus): void
  /** 手动 / 定时入口；未确认出网或采集暂停时零请求。dayStart = 图谱当前查看日（按天归纳，D28） */
  runOnce(options?: { manual?: boolean; dayStart?: number }): Promise<InductionRunOutcome>
  /** 用户在图谱窗口确认出网（写 settings 后，采集运行中则立即启动调度） */
  grantConsent(): void
  /** 设置抽屉保存确认门（true=授权，false=撤销并停调度） */
  setConsent(consented: boolean): void
  getSnapshot(): InductionSnapshot
  dispose(): void
}

export function createInductionRuntime(options: InductionRuntimeOptions): InductionRuntime {
  let service: InductionService | null = null
  let captureRunning = false
  let disposed = false

  const readConsent =
    options.readConsent ??
    ((): boolean => getSetting(options.getDb(), GRAPH_SETTING_KEYS.outboundConsent) === '1')

  const readEmbeddingsReady = options.readEmbeddingsReady ?? ((): boolean => true)

  const snapshot = (): InductionSnapshot => {
    const state: InductionState =
      service?.getState() ?? { status: 'stopped' as InductionStatus, halted: false }
    const resolved = options.resolveClient()
    return {
      ...state,
      consent: readConsent(),
      captureRunning,
      client: resolved.ok
        ? { ok: true }
        : { ok: false, reason: resolved.reason, apiKeyEnv: resolved.apiKeyEnv },
      embeddingsReady: readEmbeddingsReady()
    }
  }

  const emit = (): void => {
    if (!disposed) options.onSnapshot?.(snapshot())
  }

  /**
   * 一次跑批一行日志（F09/可观测性）：只记类型化字段，不记提示词 / 响应正文 / 密钥。
   * 自动跑批由 service 内部的 tick 触发，也必须经过这里，否则「为什么在退避」永远查不到。
   */
  const logRun = (outcome: RunOutcome, state: InductionState, meta: InductionRunMeta): void => {
    const log = options.log
    if (!log) return
    if (outcome.status === 'ok') {
      log('info', 'induction run ok', {
        manual: meta.manual,
        nodes: outcome.nodes,
        edges: outcome.edges,
        placeholders: outcome.placeholders,
        consumed: outcome.consumed,
        more: outcome.more === true,
        calls: outcome.usage?.calls ?? 0,
        promptTokens: outcome.usage?.promptTokens ?? 0,
        completionTokens: outcome.usage?.completionTokens ?? 0,
        ...(outcome.truncated &&
        outcome.truncated.titles + outcome.truncated.summaries + outcome.truncated.evidence > 0
          ? { truncated: outcome.truncated }
          : {}),
        // 覆盖缺口补齐（>0 才记）：filled=补到兄弟节点，uncovered=落「未归纳时段」兜底节点
        ...(outcome.coverage && outcome.coverage.filled + outcome.coverage.uncovered > 0
          ? { coverage: outcome.coverage }
          : {})
      })
      return
    }
    if (outcome.status === 'error') {
      const failure = state.lastFailure
      log('warn', 'induction run failed', {
        manual: meta.manual,
        code: failure?.code ?? 'unknown',
        ...(failure?.status !== undefined ? { httpStatus: failure.status } : {}),
        ...(failure?.details !== undefined ? { details: failure.details } : {}),
        streak: failure?.streak ?? 1,
        halted: state.halted
      })
      if (state.halted) log('warn', 'induction auto halted', { streak: failure?.streak ?? 1 })
      return
    }
    if (outcome.status === 'skipped') {
      log('info', 'induction run skipped', { manual: meta.manual, reason: outcome.reason })
      return
    }
    log('info', 'induction run aborted', { manual: meta.manual })
  }

  /**
   * service 每次跑完（自动 / 手动 / 跳过）都走这里：先记日志，再按需通知画布刷新。
   * 通知只看「落库结果有没有变化」，与 manual / 自动无关——自动跑批也得让开着的图谱动起来。
   */
  const handleRunFinished = (
    outcome: RunOutcome,
    state: InductionState,
    meta: InductionRunMeta
  ): void => {
    logRun(outcome, state, meta)
    if (outcome.status !== 'ok') return
    if (outcome.nodes + outcome.edges + outcome.placeholders <= 0) return
    options.onGraphChanged?.(outcome)
  }

  const ensureService = (): InductionService => {
    if (service) return service
    service = createInductionService({
      db: options.getDb(),
      getClient: () => {
        const resolved = options.resolveClient()
        return resolved.ok ? resolved.client : null
      },
      now: options.now,
      firstDelayMs: options.firstDelayMs,
      intervalMs: options.intervalMs,
      onStateChange: () => emit(),
      onRunFinished: handleRunFinished
    })
    return service
  }

  return {
    onCaptureStatus(status: CaptureStatus): void {
      if (status === 'running') {
        captureRunning = true
        if (readConsent()) {
          ensureService().start()
        } else {
          emit()
        }
        return
      }
      if (status === 'paused' || status === 'stopping') {
        captureRunning = false
        service?.stop()
        emit()
      }
    },

    async runOnce(runOptions: { manual?: boolean; dayStart?: number } = {}): Promise<InductionRunOutcome> {
      if (!readConsent()) return { status: 'skipped', reason: 'consent' }
      if (!captureRunning) return { status: 'skipped', reason: 'paused' }
      const outcome = await ensureService().runOnce(runOptions)
      emit()
      return outcome
    },

    grantConsent(): void {
      this.setConsent(true)
    },

    setConsent(consented: boolean): void {
      setSetting(options.getDb(), GRAPH_SETTING_KEYS.outboundConsent, consented ? '1' : '0')
      if (consented) {
        if (captureRunning) ensureService().start()
      } else {
        service?.stop()
      }
      emit()
    },

    getSnapshot(): InductionSnapshot {
      return snapshot()
    },

    dispose(): void {
      disposed = true
      service?.stop()
      service = null
    }
  }
}
