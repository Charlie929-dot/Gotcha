/**
 * 选区问答的浮动输入框（段二 A）
 *
 * 屏幕中下方的无边框置顶小窗：缩略图 + 一行输入 + 发送/收起。
 * 拖动交给渲染层的 `-webkit-app-region: drag`（不受主进程 movable 影响），
 * 收起也要靠主进程改窗口高度——窗口尺寸不能由渲染层自己改。
 *
 * 纪律：只认自己窗口的 IPC；空问题用默认问句（问题不能是空串，`ask:query` 会拒）。
 */

import { BrowserWindow, ipcMain } from 'electron'
import type { Display } from 'electron'

export interface AskPopupOptions {
  devServerUrl?: string
  htmlPath: string
  preloadPath: string
  /** 缩略图（data URL） */
  imageDataUrl: string
  display: Display
  /** 用户点了发送：问题已经 trim 过，非空 */
  onSend(question: string): void
  onCancel?(): void
}

export const POPUP_WIDTH = 480
export const POPUP_HEIGHT = 208
export const POPUP_COLLAPSED_HEIGHT = 56
/** 默认问句：用户不写字直接发送时用（空问题会被 `ask:query` 拒掉） */
export const DEFAULT_POPUP_QUESTION = '这张截图里是什么？'

export function askPopupBounds(display: Display): { x: number; y: number; width: number; height: number } {
  const bounds = display.bounds
  const x = Math.round(bounds.x + (bounds.width - POPUP_WIDTH) / 2)
  const y = Math.round(bounds.y + bounds.height - POPUP_HEIGHT - 96)
  return { x, y, width: POPUP_WIDTH, height: POPUP_HEIGHT }
}

let openPopup: BrowserWindow | null = null

export function openAskPopup(options: AskPopupOptions): BrowserWindow {
  if (openPopup && !openPopup.isDestroyed()) openPopup.close()

  const place = askPopupBounds(options.display)
  const win = new BrowserWindow({
    x: place.x,
    y: place.y,
    width: place.width,
    height: place.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setMenuBarVisibility(false)

  let collapsed = false
  const anchorBottom = place.y + POPUP_HEIGHT
  const resizeTo = (height: number): void => {
    if (win.isDestroyed()) return
    const [width] = win.getSize()
    win.setBounds({ x: place.x, y: anchorBottom - height, width, height }, false)
  }

  const onSend = (event: Electron.IpcMainInvokeEvent, question: unknown): boolean => {
    if (event.sender !== win.webContents) return false
    const text = typeof question === 'string' ? question.trim().slice(0, 500) : ''
    const asked = text === '' ? DEFAULT_POPUP_QUESTION : text
    if (!win.isDestroyed()) win.close()
    try {
      options.onSend(asked)
    } catch {
      // 发送失败不影响窗口收起；调用方会自己记日志
    }
    return true
  }
  const onCancel = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== win.webContents) return
    if (!win.isDestroyed()) win.close()
  }
  const onCollapse = (event: Electron.IpcMainInvokeEvent, value: unknown): boolean => {
    if (event.sender !== win.webContents) return false
    collapsed = value === true
    resizeTo(collapsed ? POPUP_COLLAPSED_HEIGHT : POPUP_HEIGHT)
    return collapsed
  }

  ipcMain.handle('popup:send', onSend)
  ipcMain.handle('popup:collapse', onCollapse)
  ipcMain.on('popup:cancel', onCancel)

  win.once('ready-to-show', () => win.show())
  win.once('closed', () => {
    ipcMain.removeHandler('popup:send')
    ipcMain.removeHandler('popup:collapse')
    ipcMain.removeListener('popup:cancel', onCancel)
    if (openPopup === win) openPopup = null
    options.onCancel?.()
  })
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('popup:image', options.imageDataUrl)
  })

  const devServerUrl = options.devServerUrl?.replace(/\/+$/, '')
  void (devServerUrl
    ? win.loadURL(`${devServerUrl}/ask-popup/index.html`)
    : win.loadFile(options.htmlPath))

  openPopup = win
  return win
}
