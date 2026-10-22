import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import log from 'electron-log/main'
import { DB_FILE_NAME, openDatabase, queryTimeline, type Db } from '../db'
import { getNumberSetting } from '../db/settings'
import { WinrtOcrBridge } from '../capture/ocr/winrt-bridge'
import { CapturePipeline } from '../capture/pipeline'
import { startScheduler } from '../capture/scheduler'
import { ScreenCapture } from '../capture/screen-stream'
import { createDailyStatsFlusher, loadStats, statsKey } from '../capture/stats'
import { getActiveWindow, isBlacklisted } from '../capture/window-meta'
import { resolveCapture } from './args'

// 测试隔离钩子：E2E 用临时 userData，绝不碰真实数据（gotchas.md）
if (process.env.GOTCHA_USER_DATA) {
  mkdirSync(process.env.GOTCHA_USER_DATA, { recursive: true })
  app.setPath('userData', process.env.GOTCHA_USER_DATA)
}

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let timelineDb: Db | null = null
let stopCapture: (() => void) | null = null
let screenCapture: ScreenCapture | null = null

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
    // 采集窗口是隐藏的，不会触发 window-all-closed；关掉时间线即退出，保持原有行为
    if (screenCapture) app.quit()
  })
}

/** 时间线查询连接：采集模式复用写连接；暂停模式只读打开（不存在则不建库，守 A3） */
function openTimelineDb(): Db | null {
  if (db) return db
  if (timelineDb) return timelineDb
  const file = join(app.getPath('userData'), DB_FILE_NAME)
  if (!existsSync(file)) return null
  timelineDb = new Database(file, { readonly: true, fileMustExist: true })
  return timelineDb
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
    const connection = openTimelineDb()
    if (!connection) return []
    try {
      return queryTimeline(connection, from, to)
    } catch {
      return []
    }
  })
}

/** 采集装配（仅 --capture / GOTCHA_CAPTURE=1 进入；默认暂停时连库都不开） */
async function startCapture(): Promise<void> {
  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  db = openDatabase(join(userDataDir, DB_FILE_NAME))

  log.initialize()
  log.transports.file.level = 'info'
  log.info(`[capture] started schema=v1 db=${DB_FILE_NAME}`)
  console.log(`[gotcha] 采集开启：db 就绪（schema v1，${DB_FILE_NAME}）`)

  const tempDir = join(userDataDir, 'tmp')
  const shotsDir = join(userDataDir, 'shots')
  mkdirSync(tempDir, { recursive: true })
  const saveShots = getNumberSetting(db, 'capture.save_shots', 0) === 1
  if (saveShots) mkdirSync(shotsDir, { recursive: true })

  const ocrScript = app.isPackaged
    ? join(process.resourcesPath, 'ocr', 'winrt-ocr.ps1')
    : join(app.getAppPath(), 'resources', 'ocr', 'winrt-ocr.ps1')

  // 持久屏幕捕获流：避开 desktopCapturer 每次 1–2s 阻塞主进程（gotchas.md）
  screenCapture = new ScreenCapture({
    devServerUrl: process.env['ELECTRON_RENDERER_URL'],
    htmlPath: join(__dirname, '../renderer/capture.html')
  })
  try {
    await screenCapture.start()
  } catch (error) {
    // 流起不来时保留时间线可用；后续 tick 的 captureWindow 会抛错并计 capture_errors
    log.warn(`[capture] 屏幕捕获流启动失败：${String(error)}`)
    console.warn(`[gotcha] 屏幕捕获流启动失败：${String(error)}`)
  }

  const engine = new WinrtOcrBridge({ scriptPath: ocrScript })
  const now = (): number => Date.now()
  // 首次载入与落盘归属同一个日期 key，避免瞬时跨日各算一次
  const todayStatsKey = statsKey(now())
  const pipeline = new CapturePipeline({
    db,
    ocr: engine,
    now,
    getActiveWindow,
    captureWindow: (bounds) => screenCapture!.capture(bounds, tempDir, now()),
    deleteFrame: (imagePath) => rmSync(imagePath, { force: true }),
    isBlacklisted: (window) => isBlacklisted(window.executable),
    saveShot: saveShots
      ? (eventId, imagePath) => {
          const image = nativeImage.createFromPath(imagePath)
          writeFileSync(join(shotsDir, `${eventId}.jpg`), image.toJPEG(80))
        }
      : undefined,
    diffThreshold: getNumberSetting(db, 'capture.diff_threshold', 8),
    initialStats: loadStats(db, todayStatsKey),
    log: (entry) => {
      const line = `[capture] ${entry.msg}${entry.data ? ` ${JSON.stringify(entry.data)}` : ''}`
      if (entry.level === 'warn') log.warn(line)
      else log.info(line)
    }
  })

  const scheduler = startScheduler({
    intervalMs: 2000,
    now,
    onTick: () => pipeline.tick()
  })
  // 跨午夜先落旧 key 再清零（gotchas「stats 跨午夜归属漂移」）
  const statsFlusher = createDailyStatsFlusher({ db, counter: pipeline, now, key: todayStatsKey })
  const flushTimer = setInterval(() => statsFlusher.flush(), 60_000)

  stopCapture = (): void => {
    scheduler.stop()
    clearInterval(flushTimer)
    statsFlusher.flush()
    void engine.dispose()
  }
}

app.whenReady().then(async () => {
  const capture = resolveCapture(process.argv, process.env)
  if (capture) {
    try {
      await startCapture()
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
  app.quit()
})

app.on('will-quit', () => {
  stopCapture?.()
  stopCapture = null
  screenCapture?.dispose()
  screenCapture = null
  timelineDb?.close()
  timelineDb = null
  db?.close()
  db = null
})
