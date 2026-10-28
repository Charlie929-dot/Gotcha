/**
 * 选区遮罩（段二 A）：在**鼠标所在的当前显示器**上蒙一层半透明遮罩，拖出矩形。
 *
 * 口径（2026-10-28 拍板）：跟系统截图工具一样——**底下是活的屏幕，上面只盖一层半透明遮罩**，
 * 框选的地方透出真实画面。所以窗口是 transparent，渲染层只画暗层与选区，不铺冻结截图。
 * （裁图用的那一帧在点球时就抓好了，遮罩本身不参与截图。）
 *
 * Windows 上的真机结论：
 * 1. `resizable: false` 的无边框窗口会被系统按工作区钳制——盖不住任务栏；改成可 resize + show 后 setBounds。
 * 2. `setFullScreen(true)` / `setKiosk(true)` 都会被系统打回，真正有效的是 `setAlwaysOnTop('screen-saver')` + `moveTop()`，
 *    且必须在 setBounds 之后（否则被 SetWindowPos 降级）。
 * 3. 任务栏也是置顶层：被点一下就跑到我们上面（Esc 失效）。所以每 300ms 重申一次置顶，blur 时立刻拉回。
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import type { Display } from 'electron'
import type { ScreenRect } from '../capture/full-frame'

export interface PickRegionOptions {
  devServerUrl?: string
  htmlPath: string
  preloadPath: string
  display: Display
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

export interface PickedRegion {
  /** 显示器内局部坐标（DIP） */
  rect: ScreenRect
  displayId: number
}

/** 置顶重申间隔：任务栏 / 其它置顶窗被激活后，最多 300ms 拉回来 */
const TOPMOST_REASSERT_MS = 300

let picking = false

function isRect(value: unknown): value is ScreenRect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key] as number)
  )
}

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
    // 关键：不能 resizable:false，否则系统把窗口钳到工作区（盖不住任务栏）
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 遮罩要马上响应拖拽，不能被后台节流
      backgroundThrottling: false
    }
  })
  win.setMenuBarVisibility(false)

  win.webContents.on('preload-error', (_event, path, error) => {
    options.log?.('error', 'region preload failed', { path, error: String(error) })
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    options.log?.('error', 'region page failed to load', { code, description })
  })

  /** 盖满整屏 + 置于任务栏之上：顺序不能反（先定尺寸，再置顶） */
  const coverScreen = (reason: string): void => {
    if (win.isDestroyed()) return
    win.setBounds(bounds, false)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
    if (reason === 'initial' || reason === 'blur') {
      const actual = win.getBounds()
      const covered =
        actual.width >= bounds.width &&
        actual.height >= bounds.height &&
        actual.x <= bounds.x &&
        actual.y <= bounds.y
      options.log?.(covered ? 'info' : 'warn', 'region overlay coverage', {
        reason,
        actual,
        display: bounds,
        covered
      })
    }
  }

  const result = await new Promise<PickedRegion | null>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (value: PickedRegion | null): void => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
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
      if (timer) clearInterval(timer)
      ipcMain.removeHandler('region:confirm')
      ipcMain.removeListener('region:cancel', onCancel)
      finish(null)
    })

    win.webContents.once('did-finish-load', () => {
      win.show()
      coverScreen('initial')
      win.focus()
      timer = setInterval(() => coverScreen('tick'), TOPMOST_REASSERT_MS)
    })

    // 点任务栏 = 焦点被抢：立刻拉回最前，Esc 才有用
    win.on('blur', () => {
      if (win.isDestroyed()) return
      setTimeout(() => {
        if (win.isDestroyed()) return
        coverScreen('blur')
        win.focus()
      }, 20)
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
