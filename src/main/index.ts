import { app, BrowserWindow, nativeImage } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { DB_FILE_NAME, openDatabase, type Db } from '../db'
import { getNumberSetting } from '../db/settings'
import { WinrtOcrBridge } from '../capture/ocr/winrt-bridge'
import { CapturePipeline } from '../capture/pipeline'
import { startScheduler } from '../capture/scheduler'
import { captureWindowFrame } from '../capture/screen'
import { loadStats, saveStats, statsKey } from '../capture/stats'
import { getActiveWindow, isBlacklisted } from '../capture/window-meta'
import { resolveCapture } from './args'

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let stopCapture: (() => void) | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    show: false, // M1a 无常驻 UI；时间线是 Phase 3 的 dev 工具窗口
    width: 1024,
    height: 768,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 采集装配（仅 --capture / GOTCHA_CAPTURE=1 进入；默认暂停时连库都不开） */
function startCapture(): void {
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

  const engine = new WinrtOcrBridge({ scriptPath: ocrScript })
  const now = (): number => Date.now()
  const pipeline = new CapturePipeline({
    db,
    ocr: engine,
    now,
    getActiveWindow,
    captureWindow: (bounds) => captureWindowFrame(bounds, tempDir, now()),
    deleteFrame: (imagePath) => rmSync(imagePath, { force: true }),
    isBlacklisted: (window) => isBlacklisted(window.executable),
    saveShot: saveShots
      ? (eventId, imagePath) => {
          const image = nativeImage.createFromPath(imagePath)
          writeFileSync(join(shotsDir, `${eventId}.jpg`), image.toJPEG(80))
        }
      : undefined,
    diffThreshold: getNumberSetting(db, 'capture.diff_threshold', 8),
    initialStats: loadStats(db, statsKey(now())),
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
  const flushTimer = setInterval(() => {
    if (db) saveStats(db, statsKey(now()), pipeline.getStats())
  }, 60_000)

  stopCapture = (): void => {
    scheduler.stop()
    clearInterval(flushTimer)
    if (db) saveStats(db, statsKey(now()), pipeline.getStats())
    void engine.dispose()
  }
}

app.whenReady().then(() => {
  const capture = resolveCapture(process.argv, process.env)
  if (capture) {
    startCapture()
  } else {
    console.log('[gotcha] 采集默认暂停（A3 红线）：无 --capture 且 GOTCHA_CAPTURE≠1，无任何采集行为')
  }
  createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  stopCapture?.()
  stopCapture = null
  db?.close()
  db = null
})
