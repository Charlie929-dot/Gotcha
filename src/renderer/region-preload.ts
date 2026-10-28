/**
 * 选区遮罩 preload（段二 A）
 *
 * 只暴露三件事：拿冻结帧、确认选区、取消。不暴露 ipcRenderer 本体、文件路径或任意 invoke。
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionApi {
  /** 冻结的整屏截图（data URL）；只来一次，重复调用不会重发 */
  onImage(handler: (dataUrl: string) => void): () => void
  /** 确认选区（显示器内局部坐标，DIP） */
  confirm(rect: RegionRect): Promise<boolean>
  cancel(): void
}

const api: RegionApi = {
  onImage: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, dataUrl: unknown): void => {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) handler(dataUrl)
    }
    ipcRenderer.on('region:image', listener)
    return () => ipcRenderer.removeListener('region:image', listener)
  },
  confirm: (rect) => ipcRenderer.invoke('region:confirm', rect) as Promise<boolean>,
  cancel: () => ipcRenderer.send('region:cancel')
}

contextBridge.exposeInMainWorld('gotchaRegion', api)
