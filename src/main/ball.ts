/**
 * 悬浮球窗口（m1b-plan §3 Phase 1）
 *
 * 职责：透明球窗口的创建 / 贴边位置 / 鼠标穿透切换 / 拖动与吸附 / 位置落盘 /
 * 状态广播 / 右键菜单。几何计算与文件读写都在纯函数模块（ball-position / ball-state），
 * 这里只做 Electron 接线。
 *
 * 穿透模型（§3 Phase 1）：窗口默认 `setIgnoreMouseEvents(true, { forward: true })`，
 * renderer 用转发的指针事件做圆形命中检测，进圆内 → 关穿透，出圆/出窗 → 恢复穿透。
 * 该通道只接受球窗口 sender（§4.9 权限面分离）。
 */

import { BrowserWindow, Menu, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { CaptureStatus } from './capture-controller'
import {
  BALL_WINDOW_SIZE,
  clampPosition,
  nearestEdge,
  positionFor,
  positionOnPixelGrid,
  ratioFor,
  resolveLayout,
  type BallDisplay,
  type BallPoint
} from './ball-position'
import { readBallState, writeBallState } from './ball-state'
import { buildTrayMenu, toMenuTemplate } from './tray-menu'

export interface BallShellOptions {
  preloadPath: string
  devServerUrl?: string
  htmlPath: string
  stateFilePath: string
  getStatus(): CaptureStatus
  openTimeline(): void
  toggleCapture(): void
  quit(): void
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}

export interface BallShell {
  window: BrowserWindow
  setStatus(status: CaptureStatus): void
  reposition(): void
  dispose(): void
}

interface PointerPoint {
  screenX: number
  screenY: number
}

interface DragEndPayload extends Partial<PointerPoint> {
  moved?: unknown
}

const DRAG_MOVE_THROTTLE_MS = 16

function isPointerPoint(value: unknown): value is PointerPoint {
  if (typeof value !== 'object' || value === null) return false
  const point = value as Partial<PointerPoint>
  return (
    typeof point.screenX === 'number' &&
    Number.isFinite(point.screenX) &&
    typeof point.screenY === 'number' &&
    Number.isFinite(point.screenY)
  )
}

function toBallDisplays(): BallDisplay[] {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }
  }))
}

export function createBallShell(options: BallShellOptions): BallShell {
  const displays = toBallDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const saved = readBallState(options.stateFilePath)
  if (saved && !displays.some((display) => display.id === saved.display_id)) {
    options.log('info', 'ball state display missing, fallback primary', {
      saved_display_id: saved.display_id
    })
  }
  const initial = resolveLayout(saved, displays, primaryId)
  let edge = initial.edge
  let offsetRatio = initial.offsetRatio
  let displayId = initial.displayId

  const scaleForDisplay = (id: number): number => {
    const found = screen.getAllDisplays().find((display) => display.id === id)
    return found?.scaleFactor ?? screen.getPrimaryDisplay().scaleFactor
  }

  /** 统一走像素网格吸附后再落位，避免非整数缩放下窗口尺寸漂移 */
  const placeWindow = (position: BallPoint, scale: number): void => {
    if (win.isDestroyed()) return
    const snapped = positionOnPixelGrid(position, scale)
    win.setPosition(snapped.x, snapped.y, false)
  }

  const initialScale = scaleForDisplay(displayId)
  const initialPosition = positionOnPixelGrid(initial.position, initialScale)

  const win = new BrowserWindow({
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
    x: initialPosition.x,
    y: initialPosition.y,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.setIgnoreMouseEvents(true, { forward: true })
  // 球常驻置顶，不能出现在自己的截图里（§4.10 真机验证项）
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'floating')
  win.setSkipTaskbar(true)
  win.setMenuBarVisibility(false)
  win.setTitle('Gotcha 球')

  const pushStatus = (status: CaptureStatus): void => {
    if (!win.isDestroyed()) win.webContents.send('ball:status', status)
  }

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed() && !win.isVisible()) win.showInactive()
    pushStatus(options.getStatus())
  })

  if (options.devServerUrl) {
    void win.loadURL(`${options.devServerUrl.replace(/\/+$/, '')}/ball/ball.html`)
  } else {
    void win.loadFile(options.htmlPath)
  }

  /** 吸附到最近边缘并落盘（只在拖动结束时调用） */
  const snapToEdge = (position: BallPoint): void => {
    const center = {
      x: position.x + BALL_WINDOW_SIZE / 2,
      y: position.y + BALL_WINDOW_SIZE / 2
    }
    const display = screen.getDisplayNearestPoint(center)
    const workArea = {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }
    const clamped = clampPosition(position, workArea)
    const nextEdge = nearestEdge(clamped, workArea)
    const nextRatio = ratioFor(nextEdge, clamped, workArea)
    const finalPosition = positionFor(nextEdge, nextRatio, workArea)

    edge = nextEdge
    offsetRatio = nextRatio
    displayId = display.id
    placeWindow(finalPosition, display.scaleFactor)

    try {
      writeBallState(options.stateFilePath, {
        edge: nextEdge,
        offset_ratio: nextRatio,
        display_id: display.id
      })
    } catch (error) {
      options.log('warn', 'ball state write failed', { error: String(error) })
    }
  }

  let drag: { offsetX: number; offsetY: number; lastMoveAt: number } | null = null

  const ensureSender = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    !win.isDestroyed() && event.sender.id === win.webContents.id

  const onPointerInside = (event: IpcMainEvent, inside: unknown): void => {
    if (!ensureSender(event) || typeof inside !== 'boolean') return
    win.setIgnoreMouseEvents(!inside, { forward: true })
  }

  const onDragStart = (event: IpcMainEvent, point: unknown): void => {
    if (!ensureSender(event) || !isPointerPoint(point)) return
    const [x, y] = win.getPosition()
    drag = { offsetX: x - point.screenX, offsetY: y - point.screenY, lastMoveAt: 0 }
  }

  const onDragMove = (event: IpcMainEvent, point: unknown): void => {
    if (!ensureSender(event) || !drag || !isPointerPoint(point)) return
    const now = Date.now()
    if (now - drag.lastMoveAt < DRAG_MOVE_THROTTLE_MS) return
    drag.lastMoveAt = now
    const target = {
      x: Math.round(point.screenX + drag.offsetX),
      y: Math.round(point.screenY + drag.offsetY)
    }
    const display = screen.getDisplayNearestPoint({
      x: target.x + BALL_WINDOW_SIZE / 2,
      y: target.y + BALL_WINDOW_SIZE / 2
    })
    placeWindow(target, display.scaleFactor)
  }

  const onDragEnd = (event: IpcMainEvent, payload: unknown): void => {
    const current = drag
    if (!ensureSender(event) || !current) return
    drag = null

    const end = (typeof payload === 'object' && payload !== null ? payload : {}) as DragEndPayload
    const moved = end.moved === true
    if (!moved) {
      options.openTimeline()
      return
    }
    let position: BallPoint
    if (isPointerPoint(end)) {
      position = {
        x: Math.round(end.screenX + current.offsetX),
        y: Math.round(end.screenY + current.offsetY)
      }
    } else {
      const [x, y] = win.getPosition()
      position = { x, y }
    }
    snapToEdge(position)
  }

  const onContextMenu = (event: IpcMainEvent): void => {
    if (!ensureSender(event)) return
    const template = buildTrayMenu(options.getStatus(), {
      openTimeline: options.openTimeline,
      toggleCapture: options.toggleCapture,
      quit: options.quit
    }).map(toMenuTemplate)
    Menu.buildFromTemplate(template).popup({ window: win })
  }

  const onCurrentStatus = (event: IpcMainInvokeEvent): CaptureStatus => {
    if (!ensureSender(event)) return 'paused'
    return options.getStatus()
  }

  /** 球点击（未拖动）落地页：打开 / 聚焦时间线窗口（Q3） */
  const onOpenTimeline = (event: IpcMainEvent): void => {
    if (!ensureSender(event)) return
    options.openTimeline()
  }

  ipcMain.on('ball:pointer-inside', onPointerInside)
  ipcMain.on('ball:drag-start', onDragStart)
  ipcMain.on('ball:drag-move', onDragMove)
  ipcMain.on('ball:drag-end', onDragEnd)
  ipcMain.on('ball:context-menu', onContextMenu)
  ipcMain.on('ball:open-timeline', onOpenTimeline)
  ipcMain.handle('ball:current-status', onCurrentStatus)

  /** 显示器增删 / 分辨率变化后重新吸附，避免球停在不可见区域 */
  const reposition = (): void => {
    const now = toBallDisplays()
    const layout = resolveLayout(
      { edge, offset_ratio: offsetRatio, display_id: displayId },
      now,
      screen.getPrimaryDisplay().id
    )
    edge = layout.edge
    offsetRatio = layout.offsetRatio
    displayId = layout.displayId
    placeWindow(layout.position, scaleForDisplay(layout.displayId))
  }

  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  screen.on('display-metrics-changed', reposition)

  return {
    window: win,
    setStatus: (status) => pushStatus(status),
    reposition,
    dispose: () => {
      screen.removeListener('display-added', reposition)
      screen.removeListener('display-removed', reposition)
      screen.removeListener('display-metrics-changed', reposition)
      ipcMain.removeListener('ball:pointer-inside', onPointerInside)
      ipcMain.removeListener('ball:drag-start', onDragStart)
      ipcMain.removeListener('ball:drag-move', onDragMove)
      ipcMain.removeListener('ball:drag-end', onDragEnd)
      ipcMain.removeListener('ball:context-menu', onContextMenu)
      ipcMain.removeListener('ball:open-timeline', onOpenTimeline)
      ipcMain.removeHandler('ball:current-status')
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
