// 时间线数据通道（m1a-plan §3 Phase 3）：renderer 只读查询，无写接口；
// C4 追加一个只读「定位到某天」订阅（主进程从图谱下钻时发）
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EventRow } from '../db'

export interface TimelineApi {
  query(from: number, to: number): Promise<EventRow[]>
  onSetDay(callback: (ts: number) => void): () => void
}

const timeline: TimelineApi = {
  query: (from: number, to: number): Promise<EventRow[]> =>
    ipcRenderer.invoke('timeline:query', from, to),
  onSetDay(callback) {
    const listener = (_event: IpcRendererEvent, ts: number): void => {
      if (typeof ts === 'number' && Number.isFinite(ts)) callback(ts)
    }
    ipcRenderer.on('timeline:set-day', listener)
    return () => {
      ipcRenderer.removeListener('timeline:set-day', listener)
    }
  }
}

contextBridge.exposeInMainWorld('gotcha', { timeline })
