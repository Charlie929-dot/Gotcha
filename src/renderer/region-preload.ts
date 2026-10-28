/**
 * 选区遮罩 preload（段二 A）
 *
 * 只暴露两件事：确认选区、取消。遮罩底下就是活的屏幕，不需要往渲染层传图。
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionApi {
  /** 确认选区（显示器内局部坐标，DIP） */
  confirm(rect: RegionRect): Promise<boolean>
  cancel(): void
}

const api: RegionApi = {
  confirm: (rect) => ipcRenderer.invoke('region:confirm', rect) as Promise<boolean>,
  cancel: () => ipcRenderer.send('region:cancel')
}

contextBridge.exposeInMainWorld('gotchaRegion', api)
