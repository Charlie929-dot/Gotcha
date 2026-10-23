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
 *
 * 本文件保持 Electron-free（Db / LlmClient 注入），调度与落库仍在 service / induction。
 */

import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'
import type { LlmClient } from '../understand/cloud/llm-client'
import {
  createInductionService,
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

  const snapshot = (): InductionSnapshot => {
    const state: InductionState = service?.getState() ?? { status: 'stopped' as InductionStatus }
    const resolved = options.resolveClient()
    return {
      ...state,
      consent: readConsent(),
      captureRunning,
      client: resolved.ok
        ? { ok: true }
        : { ok: false, reason: resolved.reason, apiKeyEnv: resolved.apiKeyEnv }
    }
  }

  const emit = (): void => {
    if (!disposed) options.onSnapshot?.(snapshot())
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
      onStateChange: () => emit()
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
