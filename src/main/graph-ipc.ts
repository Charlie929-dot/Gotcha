/**
 * 图谱窗口 IPC（M2 Phase 2）
 *
 * 权限面（§4.9）：`graph:*` 只接受图谱窗口主 frame；其它窗口 / iframe 一律拒绝。
 * 所有 handler 都是只读查询或显式用户动作（立即归纳 / 确认出网 / 保存设置 / 打开时间线），
 * 不暴露任意 SQL、路径或密钥。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BrowserWindow } from 'electron'
import type { GraphDayData, NodeEventsResult } from '../understand/graph-query'
import type { GraphSettingsSaveResult, GraphSettingsView } from './graph-settings'
import type {
  InductionRunOutcome,
  InductionSnapshot
} from './induction-runtime'

/** 跨进程返回时把 Error 摊平成字符串（structured clone 对 Error 的 message 不可靠） */
export type GraphInduceResult =
  | Exclude<InductionRunOutcome, { status: 'error' }>
  | { status: 'error'; message: string }

export interface GraphIpcDeps {
  getGraphWindow(): BrowserWindow | null
  queryGraph(from: number, to: number): GraphDayData
  queryNodeEvents(nodeId: number): NodeEventsResult
  getSnapshot(): InductionSnapshot
  runInductionNow(): Promise<InductionRunOutcome>
  setConsent(consented: boolean): void
  readSettings(): GraphSettingsView
  saveSettings(patch: unknown): GraphSettingsSaveResult
  onSettingsSaved(settings: GraphSettingsView): void
  openTimeline(): void
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}

const EMPTY_NODE_EVENTS: NodeEventsResult = {
  found: false,
  events: [],
  missingIds: [],
  malformed: false
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function serializeOutcome(outcome: InductionRunOutcome): GraphInduceResult {
  if (outcome.status === 'error') return { status: 'error', message: outcome.error.message }
  return outcome
}

export function registerGraphIpc(deps: GraphIpcDeps): () => void {
  const ensureSender = (event: IpcMainInvokeEvent): boolean => {
    const window = deps.getGraphWindow()
    if (!window || window.isDestroyed()) return false
    return (
      event.sender.id === window.webContents.id &&
      event.senderFrame === window.webContents.mainFrame
    )
  }

  const handlers: Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> = [
    [
      'graph:query',
      (event, from, to) => {
        if (!ensureSender(event) || !isFiniteNumber(from) || !isFiniteNumber(to) || to < from) {
          return { nodes: [], edges: [] } satisfies GraphDayData
        }
        try {
          return deps.queryGraph(from, to)
        } catch (error) {
          deps.log('warn', 'graph query failed', { error: String(error) })
          return { nodes: [], edges: [] } satisfies GraphDayData
        }
      }
    ],
    [
      'graph:node-events',
      (event, nodeId) => {
        if (!ensureSender(event) || !Number.isInteger(nodeId) || (nodeId as number) <= 0) {
          return EMPTY_NODE_EVENTS
        }
        try {
          return deps.queryNodeEvents(nodeId as number)
        } catch (error) {
          deps.log('warn', 'graph node events failed', { error: String(error) })
          return EMPTY_NODE_EVENTS
        }
      }
    ],
    [
      'graph:status',
      (event) => (ensureSender(event) ? deps.getSnapshot() : { error: 'forbidden' })
    ],
    [
      'graph:induce-now',
      async (event) => {
        if (!ensureSender(event)) return { status: 'error', message: 'forbidden' } satisfies GraphInduceResult
        try {
          return serializeOutcome(await deps.runInductionNow())
        } catch (error) {
          deps.log('error', 'graph induce failed', { error: String(error) })
          return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          } satisfies GraphInduceResult
        }
      }
    ],
    [
      'graph:set-consent',
      (event, consented) => {
        if (!ensureSender(event) || typeof consented !== 'boolean') {
          return { error: 'forbidden' }
        }
        try {
          deps.setConsent(consented)
          return deps.getSnapshot()
        } catch (error) {
          deps.log('error', 'graph consent write failed', { error: String(error) })
          return { error: 'consent-write-failed' }
        }
      }
    ],
    [
      'graph:settings:get',
      (event) => (ensureSender(event) ? deps.readSettings() : { error: 'forbidden' })
    ],
    [
      'graph:settings:save',
      (event, patch) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies GraphSettingsSaveResult
        try {
          const result = deps.saveSettings(patch)
          if (result.ok) deps.onSettingsSaved(result.settings)
          return result
        } catch (error) {
          deps.log('error', 'graph settings save failed', { error: String(error) })
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          } satisfies GraphSettingsSaveResult
        }
      }
    ],
    [
      'graph:open-timeline',
      (event) => {
        if (!ensureSender(event)) return false
        deps.openTimeline()
        return true
      }
    ]
  ]

  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
  }
}
