/**
 * 图谱窗口 preload（M2 Phase 2；§4.9 权限面分离）
 *
 * 只暴露图谱窗口需要的最小 API：只读查询 / 状态订阅 / 立即归纳 / 出网确认 / 设置读写 /
 * 打开时间线。不暴露 ipcRenderer 本体、任意 SQL、路径或密钥。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GraphDayData, GraphGlobalData, NodeEventsResult } from '../understand/graph-query'
import type { SearchHitEventsInput, SearchInput, SearchResult } from '../understand/search'
import type { SaveNodePositionsResult } from '../understand/node-positions'
import type { ApiKeySource } from '../understand/cloud/providers'
import type { FetchModelsResult } from '../understand/cloud/models'
import type { GraphSettingsSaveResult, GraphSettingsView } from '../main/graph-settings'
import type { GraphInduceResult, ProviderKeySaveResult, ProviderModelsInput } from '../main/graph-ipc'
import type { InductionSnapshot } from '../main/induction-runtime'
import type { HotkeyRegisterResult } from '../main/hotkeys'

export interface GraphApi {
  query(from: number, to: number): Promise<GraphDayData>
  global(): Promise<GraphGlobalData>
  nodeEvents(nodeId: number): Promise<NodeEventsResult>
  momentEvents(momentId: number): Promise<NodeEventsResult>
  /** 门一检索 v1：L0 全文检索（OCR 归一化索引 + app / 标题 / 时间窗过滤） */
  search(input: SearchInput): Promise<SearchResult>
  /** 检索卡片下钻：命中时刻的原始事件 */
  searchHitEvents(input: SearchHitEventsInput): Promise<NodeEventsResult>
  /** app 过滤器候选项（按事件量倒序） */
  searchApps(): Promise<string[]>
  savePositions(
    positions: Array<{ nodeId: number; x: number; y: number }>
  ): Promise<SaveNodePositionsResult>
  status(): Promise<InductionSnapshot>
  onStatus(callback: (snapshot: InductionSnapshot) => void): () => void
  induceNow(dayStart?: number): Promise<GraphInduceResult>
  setConsent(consented: boolean): Promise<InductionSnapshot>
  settings(): Promise<GraphSettingsView>
  saveSettings(patch: unknown): Promise<GraphSettingsSaveResult>
  providerModels(input: ProviderModelsInput): Promise<FetchModelsResult>
  saveProviderKey(providerId: string, apiKey: string): Promise<ProviderKeySaveResult>
  providerKeys(): Promise<Record<string, ApiKeySource>>
  hotkeys(): Promise<HotkeyRegisterResult[]>
  openTimeline(day?: number): Promise<boolean>
}

const api: GraphApi = {
  query: (from, to) => ipcRenderer.invoke('graph:query', from, to) as Promise<GraphDayData>,
  global: () => ipcRenderer.invoke('graph:global') as Promise<GraphGlobalData>,
  nodeEvents: (nodeId) =>
    ipcRenderer.invoke('graph:node-events', nodeId) as Promise<NodeEventsResult>,
  momentEvents: (momentId) =>
    ipcRenderer.invoke('graph:moment-events', momentId) as Promise<NodeEventsResult>,
  search: (input) => ipcRenderer.invoke('graph:search', input) as Promise<SearchResult>,
  searchHitEvents: (input) =>
    ipcRenderer.invoke('graph:search-hit-events', input) as Promise<NodeEventsResult>,
  searchApps: () => ipcRenderer.invoke('graph:search-apps') as Promise<string[]>,
  savePositions: (positions) =>
    ipcRenderer.invoke('graph:positions:save', positions) as Promise<SaveNodePositionsResult>,
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
  induceNow: (dayStart?: number) =>
    ipcRenderer.invoke('graph:induce-now', dayStart) as Promise<GraphInduceResult>,
  setConsent: (consented) =>
    ipcRenderer.invoke('graph:set-consent', consented) as Promise<InductionSnapshot>,
  settings: () => ipcRenderer.invoke('graph:settings:get') as Promise<GraphSettingsView>,
  saveSettings: (patch) =>
    ipcRenderer.invoke('graph:settings:save', patch) as Promise<GraphSettingsSaveResult>,
  providerModels: (input) =>
    ipcRenderer.invoke('graph:provider:models', input) as Promise<FetchModelsResult>,
  saveProviderKey: (providerId, apiKey) =>
    ipcRenderer.invoke('graph:provider:key', { providerId, apiKey }) as Promise<ProviderKeySaveResult>,
  providerKeys: () =>
    ipcRenderer.invoke('graph:provider:keys') as Promise<Record<string, ApiKeySource>>,
  hotkeys: () => ipcRenderer.invoke('graph:hotkeys') as Promise<HotkeyRegisterResult[]>,
  openTimeline: (day) => ipcRenderer.invoke('graph:open-timeline', day) as Promise<boolean>
}

contextBridge.exposeInMainWorld('gotchaGraph', api)
