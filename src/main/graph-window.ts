/**
 * 独立图谱窗口（M2 Phase 2 / D20）
 *
 * 单例由主进程维护（`main/index.ts`）：lazy 创建、关闭即销毁、再次打开重建。
 * 这里只负责窗口属性与加载，不注册 IPC（sender 校验在 `graph-ipc.ts`）。
 */

import { BrowserWindow } from 'electron'

export interface GraphWindowOptions {
  devServerUrl?: string
  htmlPath: string
  preloadPath: string
  onClosed?: () => void
}

export function createGraphWindow(options: GraphWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Gotcha · 图谱',
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
    void window.loadURL(`${devServerUrl}/graph/global.html`)
  } else {
    void window.loadFile(options.htmlPath)
  }
  return window
}
