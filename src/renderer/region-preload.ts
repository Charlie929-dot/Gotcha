/**
 * 选区遮罩 preload（段二 A）
 *
 * 只暴露三件事：拿冻结帧、确认选区、取消。不暴露 ipcRenderer 本体、文件路径或任意 invoke。
 * 冻结帧由渲染层主动来取（`image()`），不靠主进程 push——避免监听还没挂上就发出去。
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionApi {
  /** 冻结的整屏截图（data URL）；主进程没给就返回 null（界面只画暗层） */
  image(): Promise<string | null>
  /** 确认选区（显示器内局部坐标，DIP） */
  confirm(rect: RegionRect): Promise<boolean>
  cancel(): void
}

const api: RegionApi = {
  image: () => ipcRenderer.invoke('region:image') as Promise<string | null>,
  confirm: (rect) => ipcRenderer.invoke('region:confirm', rect) as Promise<boolean>,
  cancel: () => ipcRenderer.send('region:cancel')
}

contextBridge.exposeInMainWorld('gotchaRegion', api)
