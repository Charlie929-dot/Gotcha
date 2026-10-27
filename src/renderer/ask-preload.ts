/**
 * 问记忆窗口 preload（S3-lite）
 *
 * 只暴露问记忆需要的最小 API：提问 / 看段证据 / 出云确认门 / 对话记录。
 * 不暴露 `ipcRenderer` 本体、任意 SQL、文件路径或密钥。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { ChainAskResult } from '../chain/agent/types'
import type { SegmentEvidence } from '../chain/agent/evidence'
import type { AskConsentView } from '../main/ask-ipc'
import type { AskHistoryEntry } from '../main/ask-history'

export interface AskApi {
  /** 问一次记忆：返回「一段回答 + 引用段」或没找到 / 错误 */
  query(question: string): Promise<ChainAskResult>
  /** 引用段点开：段证据（内容片段 + 截图 data URL） */
  segment(segmentId: number): Promise<SegmentEvidence | null>
  consent(): Promise<AskConsentView | null>
  setConsent(consented: boolean): Promise<AskConsentView | null>
  /** 全部对话记录（最新在前） */
  history(): Promise<AskHistoryEntry[]>
  /** 清空对话记录 */
  clearHistory(): Promise<boolean>
}

const api: AskApi = {
  query: (question) => ipcRenderer.invoke('ask:query', question) as Promise<ChainAskResult>,
  segment: (segmentId) => ipcRenderer.invoke('ask:segment', segmentId) as Promise<SegmentEvidence | null>,
  consent: () => ipcRenderer.invoke('ask:consent:get') as Promise<AskConsentView | null>,
  setConsent: (consented) =>
    ipcRenderer.invoke('ask:consent:set', { consented }) as Promise<AskConsentView | null>,
  history: () => ipcRenderer.invoke('ask:history') as Promise<AskHistoryEntry[]>,
  clearHistory: () => ipcRenderer.invoke('ask:history:clear') as Promise<boolean>
}

contextBridge.exposeInMainWorld('gotchaAsk', api)
