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

// 测试隔离钩子：E2E 用临时 userData，绝不碰真实数据（gotchas.md）
if (process.env.GOTCHA_USER_DATA) {
  mkdirSync(process.env.GOTCHA_USER_DATA, { recursive: true })
  app.setPath('userData', process.env.GOTCHA_USER_DATA)
}

let mainWindow: BrowserWindow | null = null
let shuttingDown = false
let quitRequested = false
let logInitialized = false

/** 连接生命周期：时间线只读 / 采集写连接（m1b Plan §3 Phase 0） */
const connections = new CaptureDbConnections({
  dbPath: join(app.getPath('userData'), DB_FILE_NAME),
  fileExists: (path) => existsSync(path),
  openWritable: (path) => openDatabase(path),
  openReadonly: (path) => new Database(path, { readonly: true, fileMustExist: true })
})

const captureLog: CaptureLog = (level, msg, data) => {
  const line = `[capture] ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`
  if (level === 'error') log.error(line)
  else if (level === 'warn') log.warn(line)
  else log.info(line)
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    show: true, // M1a dev 工具窗口：只读时间线（无图谱）
    width: 1100,
    height: 800,
    title: 'Gotcha · 时间线（M1a dev）',
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
    // 采集窗口是隐藏的，不会触发 window-all-closed；关掉时间线即退出，保持原有行为。
    // quit 已在进行时不再补一次 app.quit()，避免和 before-quit 的异步收口互卡。
    if (!quitRequested && controller.status() !== 'paused') app.quit()
  })
}

function registerTimelineIpc(): void {
  ipcMain.handle('timeline:query', (_event, from: unknown, to: unknown) => {
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
  if (!logInitialized) {
    log.initialize()
    log.transports.file.level = 'info'
    logInitialized = true
  }
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

const controller = new CaptureController({ createSession, log: captureLog })

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

app.whenReady().then(async () => {
  const capture = resolveCapture(process.argv, process.env)
  if (capture) {
    try {
      await controller.start()
      console.log(`[gotcha] 采集开启：db 就绪（schema v1，${DB_FILE_NAME}）`)
    } catch (error) {
      // 采集装配失败也要保证时间线能打开，错误不吞：写控制台
      console.error(`[gotcha] 采集启动失败：${String(error)}`)
    }
  } else {
    console.log('[gotcha] 采集默认暂停（A3 红线）：无 --capture 且 GOTCHA_CAPTURE≠1，无任何采集行为')
  }
  registerTimelineIpc()
  createMainWindow()
})

app.on('window-all-closed', () => {
  // 用户关掉最后一个窗口才主动退出；quit 进行中（window-all-closed 由 quit 触发）不再重入
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
    app.quit()
  })()
})
