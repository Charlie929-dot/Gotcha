import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import log from 'electron-log/main'
import { DB_FILE_NAME, openDatabase, queryTimeline } from '../db'
import { WinrtOcrBridge } from '../capture/ocr/winrt-bridge'
import { ScreenCapture } from '../capture/screen-stream'
import { getActiveWindow, isBlacklisted } from '../capture/window-meta'
import {
  CaptureController,
  CaptureDbConnections,
  createCaptureSession,
  type CaptureLog,
  type CaptureSession
} from './capture-controller'
import { resolveCapture } from './args'
import { claimSingleInstance } from './single-instance'
import { BALL_STATE_FILE } from './ball-state'
import { createBallShell, type BallShell } from './ball'
import { installTray, type TrayShell } from './tray'

// 测试隔离钩子：E2E 用临时 userData，绝不碰真实数据（gotchas.md）
if (process.env.GOTCHA_USER_DATA) {
  mkdirSync(process.env.GOTCHA_USER_DATA, { recursive: true })
  app.setPath('userData', process.env.GOTCHA_USER_DATA)
}

let mainWindow: BrowserWindow | null = null
let ballShell: BallShell | null = null
let trayShell: TrayShell | null = null
let shuttingDown = false
let quitRequested = false
let logInitialized = false

function ensureLog(): void {
  if (logInitialized) return
  log.initialize()
  log.transports.file.level = 'info'
  logInitialized = true
}

/** 连接生命周期：时间线只读 / 采集写连接（m1b Plan §3 Phase 0） */
const connections = new CaptureDbConnections({
  dbPath: join(app.getPath('userData'), DB_FILE_NAME),
  fileExists: (path) => existsSync(path),
  openWritable: (path) => openDatabase(path),
  openReadonly: (path) => new Database(path, { readonly: true, fileMustExist: true })
})

const captureLog: CaptureLog = (level, msg, data) => {
  ensureLog()
  const line = `[capture] ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`
  if (level === 'error') log.error(line)
  else if (level === 'warn') log.warn(line)
  else log.info(line)
}

app.on('window-all-closed', () => {
  // 球窗口常驻，正常不会触发；仅当球没起来（窗口全关）时按旧行为退出
  if (!quitRequested) app.quit()
})

app.on('before-quit', (event) => {
  quitRequested = true
  if (shuttingDown) return
  shuttingDown = true
  // 退出前等 stop 收口（在途 OCR 丢弃、stats 落盘、流释放）；3s 超时后放弃并强退。
  // 用 before-quit + preventDefault：will-quit 阶段再拦会被 Electron 当成 quit 已在进行。
  event.preventDefault()
  void (async () => {
    try {
      await withTimeout(controller.stop(), 3_000, '采集停止超时（3s）')
    } catch (error) {
      console.warn(`[gotcha] 退出时停止采集失败：${String(error)}`)
    }
    connections.closeAll()
    trayShell?.dispose()
    app.quit()
  })()
})

/** 打开 / 聚焦时间线窗口（球点击、托盘、second-instance 共用入口，Q3） */
function showTimelineWindow(): void {
  if (!app.isReady()) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createMainWindow()
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    show: true,
    width: 1100,
    height: 800,
    title: 'Gotcha · 时间线',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerTimelineIpc(): void {
  ipcMain.handle('timeline:query', (event, from: unknown, to: unknown) => {
    // 只接受时间线窗口 sender：球打不开时间线、时间线打不开采集（§4.9）
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender.id !== mainWindow.webContents.id
    ) {
      return []
    }
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to < from
    ) {
      return []
    }
    const connection = connections.queryDb()
    if (!connection) return []
    try {
      return queryTimeline(connection, from, to)
    } catch {
      return []
    }
  })
}

/** 采集会话装配（仅 --capture / GOTCHA_CAPTURE=1 或显式开启时进入；默认暂停时连库都不开） */
function createSession(): Promise<CaptureSession> {
  ensureLog()
  const userDataDir = app.getPath('userData')
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  const captureHtmlPath = join(__dirname, '../renderer/capture.html')
  const ocrScript = app.isPackaged
    ? join(process.resourcesPath, 'ocr', 'winrt-ocr.ps1')
    : join(app.getAppPath(), 'resources', 'ocr', 'winrt-ocr.ps1')

  return createCaptureSession({
    userDataDir,
    devServerUrl,
    captureHtmlPath,
    now: () => Date.now(),
    ensureWriteDb: () => connections.ensureWritable(),
    releaseWriteDb: (openedThisTime) => connections.releaseWritableIfNew(openedThisTime),
    createScreenStream: () => new ScreenCapture({ devServerUrl, htmlPath: captureHtmlPath }),
    createOcr: () => new WinrtOcrBridge({ scriptPath: ocrScript }),
    getActiveWindow,
    isBlacklisted: (window) => isBlacklisted(window.executable),
    saveShot: (eventId, imagePath, shotsDir) => {
      const image = nativeImage.createFromPath(imagePath)
      writeFileSync(join(shotsDir, `${eventId}.jpg`), image.toJPEG(80))
    },
    log: captureLog
  })
}

const controller = new CaptureController({
  createSession,
  log: captureLog,
  onStatusChange: (status) => {
    ballShell?.setStatus(status)
    trayShell?.update(status)
  }
})

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// 单实例：必须在创建任何窗口之前抢锁；没抢到直接退出（§4.8）
const primaryInstance = claimSingleInstance(app, () => {
  showTimelineWindow()
})

if (primaryInstance) {
  app.whenReady().then(async () => {
    const capture = resolveCapture(process.argv, process.env)
    if (capture) {
      try {
        await controller.start()
        console.log(`[gotcha] 采集开启：db 就绪（schema v1，${DB_FILE_NAME}）`)
      } catch (error) {
        // 采集装配失败也要保证球与时间线可用，错误不吞：写控制台
        console.error(`[gotcha] 采集启动失败：${String(error)}`)
      }
    } else {
      console.log('[gotcha] 采集默认暂停（A3 红线）：无 --capture 且 GOTCHA_CAPTURE≠1，无任何采集行为')
    }

    registerTimelineIpc()

    ballShell = createBallShell({
      preloadPath: join(__dirname, '../preload/ball.js'),
      devServerUrl: process.env['ELECTRON_RENDERER_URL'],
      htmlPath: join(__dirname, '../renderer/ball/ball.html'),
      stateFilePath: join(app.getPath('userData'), BALL_STATE_FILE),
      getStatus: () => controller.status(),
      openTimeline: showTimelineWindow,
      toggleCapture: () => {
        void controller.toggle()
      },
      quit: () => app.quit(),
      log: captureLog
    })

    trayShell = installTray(
      {
        openTimeline: showTimelineWindow,
        toggleCapture: () => {
          void controller.toggle()
        },
        quit: () => app.quit()
      },
      controller.status()
    )

    // 球是常驻外壳：窗口被关掉（异常 / 调试）就退出，避免只剩隐藏采集窗口驻留进程
    ballShell.window.on('closed', () => {
      if (!quitRequested) app.quit()
    })
  })
}
