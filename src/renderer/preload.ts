// 时间线数据通道（m1a-plan §3 Phase 3）：renderer 只读查询，无写接口
import { contextBridge, ipcRenderer } from 'electron'
import type { EventRow } from '../db'

export interface TimelineApi {
  query(from: number, to: number): Promise<EventRow[]>
}

const timeline: TimelineApi = {
  query: (from: number, to: number): Promise<EventRow[]> =>
    ipcRenderer.invoke('timeline:query', from, to)
}

contextBridge.exposeInMainWorld('gotcha', { timeline })
