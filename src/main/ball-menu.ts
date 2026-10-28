/**
 * 球右键菜单（自绘，方案 B）
 *
 * 为什么不用原生 `Menu.popup`：球窗是 `focusable:false`（`WS_EX_NOACTIVATE`），
 * 原生菜单要靠"所有者窗口在前台"才收得掉——实测玩家点别处菜单赖着不走（gotchas）。
 * 这里换成独立小窗：可聚焦、失焦即关，点别处先激活别的窗口 → blur → 自动关闭，
 * 行为不再依赖原生菜单的焦点规则，样式也和问记忆的暗色主题一致。
 *
 * 纪律：
 * - 菜单项与托盘共用 `buildTrayMenu()` 的结果（文案 / 顺序 / 禁用态只有一份）；
 * - 菜单窗口只认自己的 sender；动作 id 必须在本次菜单条目里且 enabled；
 * - 任何动作都先关菜单再执行（打开问记忆时不能和菜单抢焦点）。
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from 'electron'
import { menuSize, placeBallMenu } from './ball-menu-position'
import type { TrayMenuAction, TrayMenuEntry } from './tray-menu'

export interface BallMenuOptions {
  devServerUrl?: string
  htmlPath: string
  preloadPath: string
  log(level: 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}

/** 发给渲染层的条目：动作只剩 id / 文案 / 是否可用（click 留在主进程） */
export type BallMenuItem =
  | { type: 'separator' }
  | { id: string; label: string; enabled: boolean }

export interface BallMenuShell {
  /** `anchor` 是球窗口的屏幕矩形 */
  open(entries: readonly TrayMenuEntry[], anchor: Rectangle): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

function toMenuItems(entries: readonly TrayMenuEntry[]): BallMenuItem[] {
  return entries.map((entry) =>
    'type' in entry
      ? { type: 'separator' as const }
      : { id: entry.id, label: entry.label, enabled: entry.enabled }
  )
}

export function createBallMenu(options: BallMenuOptions): BallMenuShell {
  let win: BrowserWindow | null = null
  let loaded = false
  let revealed = false
  let entries: TrayMenuEntry[] = []

  const pushEntries = (): void => {
    if (!win || win.isDestroyed() || !loaded) return
    win.webContents.send('ball-menu:entries', toMenuItems(entries))
  }

  const reveal = (): void => {
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
    pushEntries()
  }

  const create = (): BrowserWindow => {
    const created = new BrowserWindow({
      width: menuSize([]).width,
      height: menuSize([]).height,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      // 菜单必须能收焦点：失焦即关是本方案唯一可靠的"点别处就消失"来源
      focusable: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    created.setAlwaysOnTop(true, 'floating')
    created.setMenuBarVisibility(false)
    // 菜单自己不是截图对象：屏幕采集不应该把用户菜单拍进去（和球一致）
    created.setContentProtection(true)

    created.on('blur', () => {
      if (!created.isDestroyed()) created.hide()
    })
    created.on('closed', () => {
      if (win === created) {
        win = null
        loaded = false
        revealed = false
      }
    })
    created.webContents.on('did-finish-load', () => {
      loaded = true
      pushEntries()
      if (!revealed) {
        revealed = true
        created.show()
        created.focus()
      }
    })
    created.webContents.on('did-fail-load', (_event, code, desc) => {
      options.log('warn', 'ball menu page failed to load', { code, desc })
    })

    const devServerUrl = options.devServerUrl?.replace(/\/+$/, '')
    void (devServerUrl
      ? created.loadURL(`${devServerUrl}/ball-menu/index.html`)
      : created.loadFile(options.htmlPath))
    return created
  }

  const ensureWindow = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win
    win = create()
    return win
  }

  const close = (): void => {
    if (!win || win.isDestroyed()) return
    win.hide()
  }

  const select = (id: string): void => {
    const entry = entries.find(
      (item): item is TrayMenuAction => 'id' in item && item.id === id
    )
    if (!entry || !entry.enabled) return
    close()
    try {
      entry.click()
    } catch (error) {
      options.log('warn', 'ball menu action failed', { id, error: String(error) })
    }
  }

  const onSelect = (event: IpcMainEvent, id: unknown): void => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    if (typeof id !== 'string' || id === '') return
    select(id)
  }

  const onState = (event: IpcMainInvokeEvent): BallMenuItem[] => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return []
    return toMenuItems(entries)
  }

  const onCloseRequest = (event: IpcMainEvent): void => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    close()
  }

  ipcMain.on('ball-menu:select', onSelect)
  ipcMain.on('ball-menu:close', onCloseRequest)
  ipcMain.handle('ball-menu:state', onState)

  return {
    open: (nextEntries, anchor) => {
      entries = [...nextEntries]
      const menu = menuSize(entries)
      const display = screen.getDisplayNearestPoint({
        x: Math.round(anchor.x + anchor.width / 2),
        y: Math.round(anchor.y + anchor.height / 2)
      })
      const position = placeBallMenu(anchor, menu, display.workArea)
      const target = ensureWindow()
      target.setBounds({
        x: position.x,
        y: position.y,
        width: menu.width,
        height: menu.height
      })
      if (loaded) reveal()
      // 首次打开：等 did-finish-load 里统一 show + push（避免白屏闪一下）
    },
    close,
    isOpen: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
    dispose: () => {
      ipcMain.removeListener('ball-menu:select', onSelect)
      ipcMain.removeListener('ball-menu:close', onCloseRequest)
      ipcMain.removeHandler('ball-menu:state')
      if (win && !win.isDestroyed()) win.destroy()
      win = null
      loaded = false
      revealed = false
    }
  }
}
