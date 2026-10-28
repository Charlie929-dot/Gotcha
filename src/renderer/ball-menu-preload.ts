/**
 * 球右键菜单 preload（自绘菜单）
 *
 * 只暴露菜单需要的最小面：读条目、点条目、关菜单。动作本身在主进程执行，
 * 渲染层递上去的只有一个 id（主进程按本次菜单条目校验 id 与 enabled）。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export type BallMenuItem =
  | { type: 'separator' }
  | { id: string; label: string; enabled: boolean }

export interface BallMenuApi {
  /** 当前条目（页面加载 / 热键重开时都靠它兜底） */
  state(): Promise<BallMenuItem[]>
  /** 主进程每次打开菜单推一份新条目（开关项文案随采集状态变） */
  onEntries(handler: (entries: BallMenuItem[]) => void): () => void
  select(id: string): void
  close(): void
}

function isMenuItem(value: unknown): value is BallMenuItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (item.type === 'separator') return true
  return typeof item.id === 'string' && typeof item.label === 'string' && typeof item.enabled === 'boolean'
}

const api: BallMenuApi = {
  state: () => ipcRenderer.invoke('ball-menu:state') as Promise<BallMenuItem[]>,
  onEntries: (handler) => {
    const listener = (_event: IpcRendererEvent, entries: unknown): void => {
      if (!Array.isArray(entries)) return
      handler(entries.filter(isMenuItem))
    }
    ipcRenderer.on('ball-menu:entries', listener)
    return () => ipcRenderer.removeListener('ball-menu:entries', listener)
  },
  select: (id) => ipcRenderer.send('ball-menu:select', id),
  close: () => ipcRenderer.send('ball-menu:close')
}

contextBridge.exposeInMainWorld('gotchaBallMenu', api)
