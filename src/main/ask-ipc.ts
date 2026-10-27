/**
 * 问记忆窗口（S3-lite）的 IPC
 *
 * 与 `graph-ipc.ts` 同一套纪律：**只收主框架的调用**（`mainFrame`），参数在边界上校验，
 * 出错变成可读结果（不把异常抛回渲染进程 —— 渲染层白屏比报错更坏）。
 *
 * 通道：
 * - `ask:query`        问题 → `ChainAskResult`（S1 的 `askChain`），成功后落一条对话记录
 * - `ask:segment`      段 id → 段证据（截图转 data URL 由 deps 注入）
 * - `ask:consent:get`  出云确认门状态
 * - `ask:consent:set`  就地确认 / 撤销
 * - `ask:history`      全部对话记录（最新在前）
 * - `ask:history:clear` 清空对话记录
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ChainAskResult } from '../chain/agent/types'
import type { SegmentEvidence } from '../chain/agent/evidence'
import type { AskHistoryEntry } from './ask-history'

export interface AskConsentView {
  /** D24 一次性出网授权 */
  consented: boolean
  /** 有没有可用的模型客户端（缺 key / 配置不合法时为 false） */
  clientReady: boolean
  /** 没有客户端时的原因（missing-key 等），给界面显示 */
  clientReason?: string
}

export interface AskIpcDeps {
  getWindow: () => BrowserWindow | null
  ask: (question: string) => Promise<ChainAskResult>
  segment: (segmentId: number) => SegmentEvidence | null
  consent: () => AskConsentView
  setConsent: (consented: boolean) => AskConsentView
  /** 成功走完一次提问就落一条历史（失败只记日志，不能影响回答） */
  record: (question: string, result: ChainAskResult) => void
  /** 全部历史（最新在前） */
  history: () => AskHistoryEntry[]
  /** 清空历史 */
  clearHistory: () => void
  log: (level: 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

/** 问题长度上限：和 `buildChainAskPayload` 的 500 字对齐 */
export const ASK_QUESTION_MAX_CHARS = 500

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只认问记忆窗口自己的主框架（子框架 / 其它 webContents 一律拒） */
function createSenderCheck(deps: AskIpcDeps): (event: IpcMainInvokeEvent) => boolean {
  return (event) => {
    const window = deps.getWindow()
    if (!window || window.isDestroyed()) return false
    return (
      event.sender.id === window.webContents.id &&
      event.senderFrame === window.webContents.mainFrame
    )
  }
}

function failure(message: string): ChainAskResult {
  return {
    kind: 'error',
    reason: 'failed',
    message,
    stats: { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
  }
}

export function createAskIpcHandlers(deps: AskIpcDeps): Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown> {
  const ensureSender = createSenderCheck(deps)
  return new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>([
    [
      'ask:query',
      async (event, question) => {
        if (!ensureSender(event)) return failure('forbidden')
        if (typeof question !== 'string') return failure('问题不合法')
        const asked = question.trim()
        if (asked === '') return failure('问题是空的')
        if (asked.length > ASK_QUESTION_MAX_CHARS) {
          return failure(`问题太长（上限 ${ASK_QUESTION_MAX_CHARS} 字）`)
        }
        try {
          const result = await deps.ask(asked)
          // 历史写失败不能让提问失败：记一条 warn 就返回答案
          try {
            deps.record(asked, result)
          } catch (error) {
            deps.log('warn', 'ask history record failed', { error: String(error) })
          }
          return result
        } catch (error) {
          deps.log('error', 'ask:query failed', { error: String(error) })
          return failure('问记忆出错，看日志')
        }
      }
    ],
    [
      'ask:segment',
      (event, segmentId) => {
        if (!ensureSender(event)) return null
        if (typeof segmentId !== 'number' || !Number.isInteger(segmentId) || segmentId <= 0) return null
        try {
          return deps.segment(segmentId)
        } catch (error) {
          deps.log('error', 'ask:segment failed', { segmentId, error: String(error) })
          return null
        }
      }
    ],
    ['ask:consent:get', (event) => (ensureSender(event) ? deps.consent() : null)],
    [
      'ask:consent:set',
      (event, input) => {
        if (!ensureSender(event)) return null
        if (!isPlainObject(input) || typeof input.consented !== 'boolean') return null
        try {
          return deps.setConsent(input.consented)
        } catch (error) {
          deps.log('error', 'ask:consent:set failed', { error: String(error) })
          return null
        }
      }
    ],
    [
      'ask:history',
      (event) => {
        if (!ensureSender(event)) return []
        try {
          return deps.history()
        } catch (error) {
          deps.log('error', 'ask:history read failed', { error: String(error) })
          return []
        }
      }
    ],
    [
      'ask:history:clear',
      (event) => {
        if (!ensureSender(event)) return false
        try {
          deps.clearHistory()
          return true
        } catch (error) {
          deps.log('error', 'ask:history:clear failed', { error: String(error) })
          return false
        }
      }
    ]
  ])
}

/** 注册到 ipcMain；卸载函数用于窗口关闭 / 测试清理 */
export function registerAskIpc(deps: AskIpcDeps): () => void {
  const handlers = createAskIpcHandlers(deps)
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
  }
}
