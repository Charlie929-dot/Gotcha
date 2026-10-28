/**
 * 选区遮罩（段二 A）：在**当前显示器**上铺一层全屏窗口，让用户拖出矩形。
 *
 * 为什么垫一张冻结的截图而不是透明看桌面：
 * 采集流是"活的"，如果遮罩真透明，用户选中的区域会带着遮罩的暗色一起被抓进图里；
 * 先截一帧当背景、遮罩只盖这张图，裁出来的就是用户看到的那一帧，且不会把遮罩自己拍进去。
 *
 * 纪律：
 * - 只认自己这个窗口的 IPC（sender 校验），别的渲染进程发 `region:confirm` 一律丢弃；
 * - 一次只允许一个选区流程（球被连点也不会叠出两层遮罩）；
 * - Esc / 右键 = 取消，返回 null，不抛错（取消是正常结果）。
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import type { Display } from 'electron'
import type { ScreenRect } from '../capture/full-frame'

export interface PickRegionOptions {
  devServerUrl?: string
  htmlPath: string
  preloadPath: string
  /** 冻结的整屏截图（data URL），当遮罩背景 */
  imageDataUrl: string
  display: Display
}

export interface PickedRegion {
  /** 显示器内局部坐标（DIP） */
  rect: ScreenRect
  displayId: number
}

/** 同时在跑的选区流程：重复触发直接返回 null，不叠窗口 */
let picking = false

function isRect(value: unknown): value is ScreenRect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key] as number)
  )
}

/** 打开遮罩并等一个结果；取消 / 重复触发都返回 null */
export async function pickRegion(options: PickRegionOptions): Promise<PickedRegion | null> {
  if (picking) return null
  picking = true
  const display = options.display
  const bounds = display.bounds

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)

  const result = await new Promise<PickedRegion | null>((resolve) => {
    let settled = false
    const finish = (value: PickedRegion | null): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!win.isDestroyed()) win.close()
    }

    const onConfirm = (event: Electron.IpcMainInvokeEvent, rect: unknown): boolean => {
      if (event.sender !== win.webContents) return false
      if (!isRect(rect) || rect.width < 1 || rect.height < 1) {
        finish(null)
        return true
      }
      finish({ rect, displayId: display.id })
      return true
    }
    const onCancel = (event: Electron.IpcMainEvent): void => {
      if (event.sender !== win.webContents) return
      finish(null)
    }

    ipcMain.handle('region:confirm', onConfirm)
    ipcMain.on('region:cancel', onCancel)

    win.once('closed', () => {
      ipcMain.removeHandler('region:confirm')
      ipcMain.removeListener('region:cancel', onCancel)
      finish(null)
    })

    win.webContents.once('did-finish-load', () => {
      win.webContents.send('region:image', options.imageDataUrl)
      win.show()
      win.focus()
    })

    const devServerUrl = options.devServerUrl?.replace(/\/+$/, '')
    void (devServerUrl
      ? win.loadURL(`${devServerUrl}/region/index.html`)
      : win.loadFile(options.htmlPath))
  })

  picking = false
  return result
}

/** 取鼠标所在显示器（选区只覆盖这一块，拍板 2026-10-28：不做跨屏） */
export function displayUnderCursor(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}
