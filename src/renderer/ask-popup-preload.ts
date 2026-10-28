/**
 * 浮动输入框 preload（段二 A）
 *
 * 只暴露：拿缩略图、发送、取消、收起。不暴露 ipcRenderer 本体 / 文件路径。
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface AskPopupApi {
  onImage(handler: (dataUrl: string) => void): () => void
  /** 发送（空串由主进程换成默认问句）；返回是否被接受 */
  send(question: string): Promise<boolean>
  cancel(): void
  /** 收起 / 展开，返回收起后的状态 */
  setCollapsed(collapsed: boolean): Promise<boolean>
}

const api: AskPopupApi = {
  onImage: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, dataUrl: unknown): void => {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) handler(dataUrl)
    }
    ipcRenderer.on('popup:image', listener)
    return () => ipcRenderer.removeListener('popup:image', listener)
  },
  send: (question) => ipcRenderer.invoke('popup:send', question) as Promise<boolean>,
  cancel: () => ipcRenderer.send('popup:cancel'),
  setCollapsed: (collapsed) => ipcRenderer.invoke('popup:collapse', collapsed) as Promise<boolean>
}

contextBridge.exposeInMainWorld('gotchaPopup', api)
