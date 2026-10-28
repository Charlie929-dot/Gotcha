/**
 * 选区遮罩（段二 A）：在**鼠标所在的当前显示器**上蒙一层，拖出矩形。
 *
 * 两个 Windows 上的坑（2026-10-28 真机踩到）：
 * 1. 普通无边框窗口会被系统夹到**工作区**（不含任务栏），`width = display.bounds.height` 也盖不住；
 *    改用 `fullscreen: true` 才是「整屏蒙一层」——任务栏也盖住，和系统截图工具一样。
 * 2. 冻结帧不能靠 `did-finish-load` 时 push：渲染层的监听有可能还没挂上（窗口就只显示一层空画布）。
 *    改成渲染层主动 `invoke('region:image')` 拉一次，谁先谁后都不丢。
 *
 * 遮罩垫一张冻结截图而不是看桌面：采集流是活的，真透明的遮罩会被一起抓进图里；
 * 冻结帧 + 暗层 = 用户看到的就是裁出来的那一帧。
 *
 * 纪律：只认自己这个窗口的 IPC；一次只允许一个选区流程；取消（Esc / 右键）返回 null。
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import type { Display } from 'electron'
import type { ScreenRect } from '../capture/full-frame'

export interface PickRegionOptions {
  devServerUrl?: string
  htmlPath: string
  preloadPath: string
  /** 冻结的整屏截图（data URL）：由渲染层主动来取 */
  imageDataUrl: string
  display: Display
  log?: (level: 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
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
    // Windows：只有 fullscreen 才盖得住任务栏（普通无边框会被夹到工作区）
    fullscreen: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0b0c10',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 遮罩要马上响应拖拽，不能被后台节流
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)

  // 诊断：preload 挂了 / 页面没加载出来，都写进 main.log（否则界面上只剩一层空画布，没法查）
  win.webContents.on('preload-error', (_event, path, error) => {
    options.log?.('error', 'region preload failed', { path, error: String(error) })
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    options.log?.('error', 'region page failed to load', { code, description })
  })

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
    // 渲染层主动拉冻结帧：不依赖「主进程 push 时监听已挂好」的时序
    const onImage = (event: Electron.IpcMainInvokeEvent): string | null =>
      event.sender === win.webContents ? options.imageDataUrl : null

    ipcMain.handle('region:image', onImage)
    ipcMain.handle('region:confirm', onConfirm)
    ipcMain.on('region:cancel', onCancel)

    win.once('closed', () => {
      ipcMain.removeHandler('region:image')
      ipcMain.removeHandler('region:confirm')
      ipcMain.removeListener('region:cancel', onCancel)
      finish(null)
    })

    win.webContents.once('did-finish-load', () => {
      // fullscreen 偶尔会在加载过程中被还原成普通窗口：再钉一次边界
      if (!win.isFullScreen()) win.setFullScreen(true)
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
