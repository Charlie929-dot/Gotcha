/**
 * 图谱窗口 preload（M2 Phase 2；§4.9 权限面分离）
 *
 * 只暴露图谱窗口需要的最小 API：只读查询 / 状态订阅 / 立即归纳 / 出网确认 / 设置读写 /
 * 打开时间线。不暴露 ipcRenderer 本体、任意 SQL、路径或密钥。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GraphDayData, NodeEventsResult } from '../understand/graph-query'
import type { GraphSettingsSaveResult, GraphSettingsView } from '../main/graph-settings'
import type { GraphInduceResult } from '../main/graph-ipc'
import type { InductionSnapshot } from '../main/induction-runtime'
import type { HotkeyRegisterResult } from '../main/hotkeys'

export interface GraphApi {
  query(from: number, to: number): Promise<GraphDayData>
  nodeEvents(nodeId: number): Promise<NodeEventsResult>
  status(): Promise<InductionSnapshot>
  onStatus(callback: (snapshot: InductionSnapshot) => void): () => void
  induceNow(): Promise<GraphInduceResult>
  setConsent(consented: boolean): Promise<InductionSnapshot>
  settings(): Promise<GraphSettingsView>
  saveSettings(patch: unknown): Promise<GraphSettingsSaveResult>
  hotkeys(): Promise<HotkeyRegisterResult[]>
  openTimeline(day?: number): Promise<boolean>
}

const api: GraphApi = {
  query: (from, to) => ipcRenderer.invoke('graph:query', from, to) as Promise<GraphDayData>,
  nodeEvents: (nodeId) =>
    ipcRenderer.invoke('graph:node-events', nodeId) as Promise<NodeEventsResult>,
  status: () => ipcRenderer.invoke('graph:status') as Promise<InductionSnapshot>,
  onStatus(callback) {
    const listener = (_event: IpcRendererEvent, snapshot: InductionSnapshot): void => {
      callback(snapshot)
    }
    ipcRenderer.on('graph:status', listener)
    return () => {
      ipcRenderer.removeListener('graph:status', listener)
    }
  },
  induceNow: () => ipcRenderer.invoke('graph:induce-now') as Promise<GraphInduceResult>,
  setConsent: (consented) =>
    ipcRenderer.invoke('graph:set-consent', consented) as Promise<InductionSnapshot>,
  settings: () => ipcRenderer.invoke('graph:settings:get') as Promise<GraphSettingsView>,
  saveSettings: (patch) =>
    ipcRenderer.invoke('graph:settings:save', patch) as Promise<GraphSettingsSaveResult>,
  hotkeys: () => ipcRenderer.invoke('graph:hotkeys') as Promise<HotkeyRegisterResult[]>,
  openTimeline: (day) => ipcRenderer.invoke('graph:open-timeline', day) as Promise<boolean>
}

contextBridge.exposeInMainWorld('gotchaGraph', api)
