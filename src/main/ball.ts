/**
 * 悬浮球窗口（m1b-plan §3 Phase 1，2026-10-22 拍板改为腾讯管家式停靠，D15；
 * 2026-10-23 补自动缩回机制，D16）
 *
 * 职责：透明球窗口的创建 / 位置与停靠 / 鼠标穿透切换 / 拖动与吸附 / 位置落盘 /
 * 状态与停靠信息广播 / 右键菜单 / 自动缩回兜底。几何、落盘与兜底判定都在纯函数模块
 * （ball-position / ball-state / ball-retract），这里只做 Electron 接线。
 *
 * 停靠模型：窗口始终整块落在工作区内（贴齐边缘），球体缩入（露出 24px）由 renderer
 * 的 CSS transform 完成；悬停滑出、离开宽限后缩回也在 renderer 侧（不移动窗口，避免
 * 滑出/缩回时命中区域抖动）。拖动松手离边缘 ≤24px 才吸附，否则停在原地（free）。
 *
 * 穿透模型：窗口默认 `setIgnoreMouseEvents(true, { forward: true })`。renderer 上报
 * 球体命中（`pointerInside`）与交互状态（idle / expanded / grace / dragging），
 * 只有 idle 且指针不在球上时才恢复穿透；展开 / 宽限 / 拖动期间保持可交互，否则
 * renderer 收不到 pointerleave，球会卡在展开态（D16）。该通道只接受球窗口 sender
 * （§4.9 权限面分离）。
 *
 * 自动缩回兜底（D16）：renderer 负责 600ms 宽限计时；主进程在展开 / 宽限期间每 50ms
 * 用 `screen.getCursorScreenPoint()` 检查真实指针，离开窗口安全区（64×64 + 8px）超过
 * 宽限 + 100ms 后发 `ball:force-retract`，保证丢事件时也能收回。
 */

import { BrowserWindow, Menu, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { CaptureStatus } from './capture-controller'
import {
  BALL_WINDOW_SIZE,
  clampPosition,
  dockedPosition,
  nearestEdgeWithin,
  positionOnPixelGrid,
  ratioFor,
  ratiosForFree,
  resolveLayout,
  type BallDisplay,
  type BallEdge,
  type BallPoint
} from './ball-position'
import { readBallState, writeBallState } from './ball-state'
import {
  BALL_RETRACT_POLL_MS,
  decideRetract,
  type BallRetractState
} from './ball-retract'
import { buildTrayMenu, toMenuTemplate } from './tray-menu'

/**
 * 球上角标（m1b-plan §3 Phase 2）：
 * - countdown：启动自动恢复的 3s 倒计时（3 → 2 → 1），期间球保持暂停视觉；
 * - error：恢复 / 开始失败，保持暂停并提示；
 * - hotkey-unavailable：`Alt+P` 被占用，托盘菜单仍可切换。
 */
export type BallNotice =
  | { kind: 'countdown'; seconds: number }
  | { kind: 'error'; text: string }
  | { kind: 'hotkey-unavailable'; text: string }

export interface BallShellOptions {
  preloadPath: string
  devServerUrl?: string
  htmlPath: string
  stateFilePath: string
  getStatus(): CaptureStatus
  openTimeline(): void
  /** D20：球点击默认打开图谱；时间线入口保留在菜单 / 图谱工具栏 */
  openGraph(): void
  /** 问记忆窗口（S3-lite） */
  openAsk(): void
  toggleCapture(): void
  quit(): void
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}

export interface BallShell {
  window: BrowserWindow
  setStatus(status: CaptureStatus): void
  /** 角标：null 清除；页面重载后自动重放最近一条 */
  showNotice(notice: BallNotice | null): void
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

const BALL_INTERACTION_STATES: readonly BallRetractState[] = [
  'idle',
  'expanded',
  'grace',
  'dragging'
]

function isInteractionState(value: unknown): value is BallRetractState {
  return typeof value === 'string' && (BALL_INTERACTION_STATES as readonly string[]).includes(value)
}

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

function workAreaOf(display: Electron.Display): {
  x: number
  y: number
  width: number
  height: number
} {
  return {
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height
  }
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
  let docked = initial.docked
  let edge: BallEdge | null = initial.edge
  let offsetRatio = initial.offsetRatio
  let xRatio = saved?.x_ratio ?? 0.5
  let yRatio = saved?.y_ratio ?? 0.5
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
  // 球常驻置顶，不能出现在自己的截图里（§4.10 已验证）
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'floating')
  win.setSkipTaskbar(true)
  win.setMenuBarVisibility(false)
  win.setTitle('Gotcha 球')

  const pushStatus = (status: CaptureStatus): void => {
    if (!win.isDestroyed()) win.webContents.send('ball:status', status)
  }

  let latestNotice: BallNotice | null = null

  /** 角标广播：也用于「页面重载后重放」，避免倒计时 / 报错角标丢失 */
  const pushNotice = (notice: BallNotice | null): void => {
    latestNotice = notice
    if (!win.isDestroyed()) win.webContents.send('ball:notice', notice)
  }

  /** 停靠信息广播：renderer 据此决定是否缩入（docked + edge） */
  const pushPlacement = (): void => {
    if (!win.isDestroyed()) win.webContents.send('ball:placement', { docked, edge })
  }

  let pointerInside = false
  let interaction: BallRetractState = 'idle'
  let watcher: ReturnType<typeof setInterval> | null = null
  let outsideSince: number | null = null
  let forceSent = false

  /** 穿透开关：只有缩入态且指针不在球上时才恢复穿透（D16） */
  const applyIgnore = (): void => {
    if (win.isDestroyed()) return
    win.setIgnoreMouseEvents(!(pointerInside || interaction !== 'idle'), { forward: true })
  }

  const stopWatcher = (): void => {
    if (watcher !== null) {
      clearInterval(watcher)
      watcher = null
    }
    outsideSince = null
    forceSent = false
  }

  /** 兜底：展开 / 宽限期间检查真实指针，离开安全区超时后强制缩回 */
  const checkCursor = (): void => {
    if (win.isDestroyed() || !win.isVisible()) return
    const decision = decideRetract({
      state: interaction,
      cursor: screen.getCursorScreenPoint(),
      bounds: win.getBounds(),
      outsideSince,
      now: Date.now()
    })
    outsideSince = decision.outsideSince
    if (!decision.forceRetract || forceSent) return
    forceSent = true
    win.webContents.send('ball:force-retract')
  }

  const startWatcher = (): void => {
    if (watcher !== null) return
    outsideSince = null
    forceSent = false
    watcher = setInterval(checkCursor, BALL_RETRACT_POLL_MS)
  }

  const applyInteraction = (next: BallRetractState): void => {
    if (next === interaction) return
    interaction = next
    if (interaction === 'expanded' || interaction === 'grace') startWatcher()
    else stopWatcher()
    applyIgnore()
  }

  win.on('closed', stopWatcher)

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed() && !win.isVisible()) win.showInactive()
    // 页面重载后状态归零，避免沿用旧展开态 / 穿透状态
    pointerInside = false
    applyInteraction('idle')
    applyIgnore()
    pushStatus(options.getStatus())
    pushPlacement()
    pushNotice(latestNotice)
  })

  if (options.devServerUrl) {
    void win.loadURL(`${options.devServerUrl.replace(/\/+$/, '')}/ball/ball.html`)
  } else {
    void win.loadFile(options.htmlPath)
  }

  const persist = (): void => {
    try {
      writeBallState(options.stateFilePath, {
        edge,
        offset_ratio: offsetRatio,
        x_ratio: xRatio,
        y_ratio: yRatio,
        display_id: displayId
      })
    } catch (error) {
      options.log('warn', 'ball state write failed', { error: String(error) })
    }
  }

  /**
   * 松手落位（只在拖动结束时调用）：
   * 离边缘 ≤ DOCK_THRESHOLD 才吸附停靠，否则自由停在原地。
   */
  const settleAt = (position: BallPoint): void => {
    const center = {
      x: position.x + BALL_WINDOW_SIZE / 2,
      y: position.y + BALL_WINDOW_SIZE / 2
    }
    const display = screen.getDisplayNearestPoint(center)
    const workArea = workAreaOf(display)
    const clamped = clampPosition(position, workArea)
    const nextEdge = nearestEdgeWithin(clamped, workArea)

    displayId = display.id
    if (nextEdge) {
      docked = true
      edge = nextEdge
      offsetRatio = ratioFor(nextEdge, clamped, workArea)
      placeWindow(dockedPosition(nextEdge, offsetRatio, workArea), display.scaleFactor)
    } else {
      docked = false
      edge = null
      const ratios = ratiosForFree(clamped, workArea)
      xRatio = ratios.xRatio
      yRatio = ratios.yRatio
      placeWindow(clamped, display.scaleFactor)
    }
    persist()
    pushPlacement()
  }

  let drag: { offsetX: number; offsetY: number; lastMoveAt: number } | null = null

  const ensureSender = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    !win.isDestroyed() && event.sender.id === win.webContents.id

  const onPointerInside = (event: IpcMainEvent, inside: unknown): void => {
    if (!ensureSender(event) || typeof inside !== 'boolean') return
    if (inside === pointerInside) return
    pointerInside = inside
    applyIgnore()
  }

  const onInteractionState = (event: IpcMainEvent, state: unknown): void => {
    if (!ensureSender(event) || !isInteractionState(state)) return
    applyInteraction(state)
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
      options.openGraph()
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
    settleAt(position)
  }

  const onContextMenu = (event: IpcMainEvent): void => {
    if (!ensureSender(event)) return
    const template = buildTrayMenu(options.getStatus(), {
      openGraph: options.openGraph,
      openAsk: options.openAsk,
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

  /** 球点击（未拖动）落地页：打开 / 聚焦图谱窗口（D20） */
  const onOpenGraph = (event: IpcMainEvent): void => {
    if (!ensureSender(event)) return
    options.openGraph()
  }

  /** 球右键 / 菜单仍可单独打开时间线（D20 保留入口） */
  const onOpenTimeline = (event: IpcMainEvent): void => {
    if (!ensureSender(event)) return
    options.openTimeline()
  }

  ipcMain.on('ball:pointer-inside', onPointerInside)
  ipcMain.on('ball:interaction-state', onInteractionState)
  ipcMain.on('ball:drag-start', onDragStart)
  ipcMain.on('ball:drag-move', onDragMove)
  ipcMain.on('ball:drag-end', onDragEnd)
  ipcMain.on('ball:context-menu', onContextMenu)
  ipcMain.on('ball:open-graph', onOpenGraph)
  ipcMain.on('ball:open-timeline', onOpenTimeline)
  ipcMain.handle('ball:current-status', onCurrentStatus)

  /** 显示器增删 / 分辨率变化后重新落位：停靠保持边缘比例，自由位保持相对位置 */
  const reposition = (): void => {
    const now = toBallDisplays()
    const layout = resolveLayout(
      { edge, offset_ratio: offsetRatio, x_ratio: xRatio, y_ratio: yRatio, display_id: displayId },
      now,
      screen.getPrimaryDisplay().id
    )
    docked = layout.docked
    edge = layout.edge
    offsetRatio = layout.offsetRatio
    displayId = layout.displayId
    placeWindow(layout.position, scaleForDisplay(layout.displayId))
    pushPlacement()
  }

  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  screen.on('display-metrics-changed', reposition)

  return {
    window: win,
    setStatus: (status) => pushStatus(status),
    showNotice: (notice) => pushNotice(notice),
    reposition,
    dispose: () => {
      screen.removeListener('display-added', reposition)
      screen.removeListener('display-removed', reposition)
      screen.removeListener('display-metrics-changed', reposition)
      stopWatcher()
      ipcMain.removeListener('ball:pointer-inside', onPointerInside)
      ipcMain.removeListener('ball:interaction-state', onInteractionState)
      ipcMain.removeListener('ball:drag-start', onDragStart)
      ipcMain.removeListener('ball:drag-move', onDragMove)
      ipcMain.removeListener('ball:drag-end', onDragEnd)
      ipcMain.removeListener('ball:context-menu', onContextMenu)
      ipcMain.removeListener('ball:open-graph', onOpenGraph)
      ipcMain.removeListener('ball:open-timeline', onOpenTimeline)
      ipcMain.removeHandler('ball:current-status')
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
