/**
 * 问记忆窗口 preload（S3-lite）
 *
 * 只暴露问记忆需要的最小 API：提问 / 看段证据 / 出云确认门 / 对话记录。
 * 不暴露 `ipcRenderer` 本体、任意 SQL、文件路径或密钥。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { ChainAskResult, ChainAskResumeDecision } from '../chain/agent/types'
import type { SegmentEvidence } from '../chain/agent/evidence'
import type { AskConsentView } from '../main/ask-ipc'
import type { AskHistoryEntry } from '../main/ask-history'

export interface AskApi {
  /**
   * 问一次记忆。`conversationId` 相同的提问会被当成同一会话的续问——
   * 主进程按它取之前几轮当上下文（不传则主进程现造一个）。
   */
  query(question: string, conversationId?: string): Promise<ChainAskResult>
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
}

const api: AskApi = {
  query: (question, conversationId) =>
    ipcRenderer.invoke('ask:query', {
      question,
      ...(conversationId ? { conversationId } : {})
    }) as Promise<ChainAskResult>,
  resume: (resumeId, decision) =>
    ipcRenderer.invoke('ask:resume', { resumeId, decision }) as Promise<ChainAskResult>,
  cancel: () => ipcRenderer.invoke('ask:cancel') as Promise<boolean>,
  segment: (segmentId) => ipcRenderer.invoke('ask:segment', segmentId) as Promise<SegmentEvidence | null>,
  consent: () => ipcRenderer.invoke('ask:consent:get') as Promise<AskConsentView | null>,
  setConsent: (consented) =>
    ipcRenderer.invoke('ask:consent:set', { consented }) as Promise<AskConsentView | null>,
  history: () => ipcRenderer.invoke('ask:history') as Promise<AskHistoryEntry[]>,
  clearHistory: () => ipcRenderer.invoke('ask:history:clear') as Promise<boolean>
}

contextBridge.exposeInMainWorld('gotchaAsk', api)
