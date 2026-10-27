/**
 * 问记忆窗口（S3-lite）
 *
 * 与 `graph-window.ts` 同一套：单例由主进程维护（lazy 创建、关闭即销毁、再次打开重建），
 * 这里只管窗口属性与加载，不注册 IPC（sender 校验在 `ask-ipc.ts`）。
 */

import { BrowserWindow } from 'electron'

export interface AskWindowOptions {
  devServerUrl?: string
  htmlPath: string
  preloadPath: string
  onClosed?: () => void
}

export function createAskWindow(options: AskWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    title: 'Gotcha · 问记忆',
    backgroundColor: '#121218',
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.setMenuBarVisibility(false)
  window.on('closed', () => {
    options.onClosed?.()
  })

  const devServerUrl = options.devServerUrl?.replace(/\/+$/, '')
  if (devServerUrl) {
    void window.loadURL(`${devServerUrl}/ask/ask.html`)
  } else {
    void window.loadFile(options.htmlPath)
  }
  return window
}
