/**
 * 问记忆窗口 preload（S3-lite）
 *
 * 只暴露问记忆需要的最小 API：提问 / 看段证据 / 出云确认门 / 对话记录 /
 * 设置抽屉（D53：供应商 + 密钥 + 出网确认，与图谱窗口同一套主进程实现）。
 * 不暴露 `ipcRenderer` 本体、任意 SQL、文件路径或密钥。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { ChainAskResult, ChainAskResumeDecision } from '../chain/agent/types'
import type { SegmentEvidence } from '../chain/agent/evidence'
import type { AskConsentView } from '../main/ask-ipc'
import type { AskHistoryEntry } from '../main/ask-history'
import type { GraphSettingsSaveResult, GraphSettingsView } from '../main/graph-settings'
import type { MemorySettingsSaveResult, MemorySettingsView } from '../main/memory-settings'
import type { MemoryDeleteView, MemoryListView, MemoryRestoreView } from '../main/memory-admin'
import type { ProviderKeySaveResult, ProviderModelsInput } from '../main/graph-ipc'
import type { ApiKeySource } from '../understand/cloud/providers'
import type { FetchModelsResult } from '../understand/cloud/models'

export interface AskApi {
  /**
   * 问一次记忆。`conversationId` 相同的提问会被当成同一会话的续问——
   * 主进程按它取之前几轮当上下文（不传则主进程现造一个）。
   * `imagePath` 是选区问答留存的截图（主进程只认 ask-shots 下的文件）。
   */
  query(question: string, conversationId?: string, imagePath?: string): Promise<ChainAskResult>
  /**
   * 「还要继续查吗」的选择：continue = 再给一轮检索预算，stop = 按现有结果收尾。
   * `resumeId` 来自 `continue-ask` 结果；过期 / 重开窗口后失效。
   */
  resume(resumeId: string, decision: ChainAskResumeDecision): Promise<ChainAskResult>
  /** 停止在途提问（用户点「停止」） */
  cancel(): Promise<boolean>
  /** 引用段点开：段证据（内容片段 + 截图 data URL） */
  segment(segmentId: number): Promise<SegmentEvidence | null>
  consent(): Promise<AskConsentView | null>
  setConsent(consented: boolean): Promise<AskConsentView | null>
  /** 全部对话记录（最新在前） */
  history(): Promise<AskHistoryEntry[]>
  /** 清空对话记录 */
  clearHistory(): Promise<boolean>
  /** 截图路径 → data URL（渲染层读不了文件；读不到返回 null） */
  image(path: string): Promise<string | null>
  /** 选区问答的交接单：一条问题 + 一张截图，窗口收到就自动开问 */
  onPrefill(handler: (payload: { question: string; imagePath: string }) => void): () => void
  /* ---- D53：设置抽屉（供应商 / 密钥 / 出网确认 / 用量） ---- */
  settings(): Promise<GraphSettingsView | { error: string }>
  saveSettings(patch: unknown): Promise<GraphSettingsSaveResult>
  providerModels(input: ProviderModelsInput): Promise<FetchModelsResult>
  saveProviderKey(providerId: string, apiKey: string): Promise<ProviderKeySaveResult>
  providerKeys(): Promise<Record<string, ApiKeySource>>
  /* ---- 个人记忆（日记目录 + 人设；保存即同步） ---- */
  memorySettings(): Promise<MemorySettingsView | { error: string }>
  saveMemorySettings(patch: unknown): Promise<MemorySettingsSaveResult>
  /* ---- 个人记忆 · 条目浏览 / 删除 / 撤销（设置抽屉「记忆条目」） ---- */
  memoryList(query: {
    search?: string
    kind?: string
    offset?: number
    limit?: number
  }): Promise<MemoryListView>
  memoryDelete(id: number): Promise<MemoryDeleteView>
  memoryRestore(uid: string): Promise<MemoryRestoreView>
  /** 托盘 / 球右键的「设置」：打开窗口就展开抽屉 */
  onOpenSettings(handler: () => void): () => void
}

const api: AskApi = {
  query: (question, conversationId, imagePath) =>
    ipcRenderer.invoke('ask:query', {
      question,
      ...(conversationId ? { conversationId } : {}),
      ...(imagePath ? { imagePath } : {})
    }) as Promise<ChainAskResult>,
  resume: (resumeId, decision) =>
    ipcRenderer.invoke('ask:resume', { resumeId, decision }) as Promise<ChainAskResult>,
  cancel: () => ipcRenderer.invoke('ask:cancel') as Promise<boolean>,
  segment: (segmentId) => ipcRenderer.invoke('ask:segment', segmentId) as Promise<SegmentEvidence | null>,
  consent: () => ipcRenderer.invoke('ask:consent:get') as Promise<AskConsentView | null>,
  setConsent: (consented) =>
    ipcRenderer.invoke('ask:consent:set', { consented }) as Promise<AskConsentView | null>,
  history: () => ipcRenderer.invoke('ask:history') as Promise<AskHistoryEntry[]>,
  clearHistory: () => ipcRenderer.invoke('ask:history:clear') as Promise<boolean>,
  image: (path) => ipcRenderer.invoke('ask:image', path) as Promise<string | null>,
  settings: () =>
    ipcRenderer.invoke('ask:settings:get') as Promise<GraphSettingsView | { error: string }>,
  saveSettings: (patch) =>
    ipcRenderer.invoke('ask:settings:save', patch) as Promise<GraphSettingsSaveResult>,
  providerModels: (input) =>
    ipcRenderer.invoke('ask:provider:models', input) as Promise<FetchModelsResult>,
  saveProviderKey: (providerId, apiKey) =>
    ipcRenderer.invoke('ask:provider:key', { providerId, apiKey }) as Promise<ProviderKeySaveResult>,
  providerKeys: () =>
    ipcRenderer.invoke('ask:provider:keys') as Promise<Record<string, ApiKeySource>>,
  memorySettings: () =>
    ipcRenderer.invoke('ask:memory:get') as Promise<MemorySettingsView | { error: string }>,
  saveMemorySettings: (patch) =>
    ipcRenderer.invoke('ask:memory:save', patch) as Promise<MemorySettingsSaveResult>,
  memoryList: (query) => ipcRenderer.invoke('ask:memory:list', query) as Promise<MemoryListView>,
  memoryDelete: (id) => ipcRenderer.invoke('ask:memory:delete', { id }) as Promise<MemoryDeleteView>,
  memoryRestore: (uid) =>
    ipcRenderer.invoke('ask:memory:restore', { uid }) as Promise<MemoryRestoreView>,
  onOpenSettings: (handler) => {
    const listener = (): void => handler()
    ipcRenderer.on('ask:open-settings', listener)
    return () => ipcRenderer.removeListener('ask:open-settings', listener)
  },
  onPrefill: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      if (typeof payload !== 'object' || payload === null) return
      const value = payload as Record<string, unknown>
      if (typeof value.question !== 'string' || typeof value.imagePath !== 'string') return
      handler({ question: value.question, imagePath: value.imagePath })
    }
    ipcRenderer.on('ask:prefill', listener)
    return () => ipcRenderer.removeListener('ask:prefill', listener)
  }
}

contextBridge.exposeInMainWorld('gotchaAsk', api)
