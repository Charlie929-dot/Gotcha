import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import log from 'electron-log/main'
import { DB_FILE_NAME, openDatabase, queryTimeline, type Db } from '../db'
import { getSetting } from '../db/settings'
import { WinrtOcrBridge } from '../capture/ocr/winrt-bridge'
import { ScreenCapture } from '../capture/screen-stream'
import { getActiveWindow, isBlacklisted } from '../capture/window-meta'
import { cleanStaleFrames } from '../capture/temp-store'
import {
  emptyGlobalGraph,
  queryGlobalGraph,
  queryGraphDay,
  queryMomentEvents,
  queryNodeEvents
} from '../understand/graph-query'
import { saveNodePositions } from '../understand/node-positions'
import {
  listSearchApps,
  querySearchHitEvents,
  searchEvents
} from '../understand/search'
import { loadEnvFile } from '../understand/cloud/env-file'
import { createDeepSeekClient } from '../understand/cloud/deepseek'
import {
  apiKeySource,
  DEFAULT_PROVIDER,
  parseProvidersConfig,
  resolveFromSettings,
  resolveLlmProvider,
  type ApiKeySource,
  type LlmProvider
} from '../understand/cloud/providers'
import { fetchProviderModels as fetchModelsFromProvider } from '../understand/cloud/models'
import { createInductionRuntime, type ClientResolution, type InductionRuntime, type InductionSnapshot } from './induction-runtime'
import { GRAPH_SETTING_KEYS, readGraphSettings, saveGraphSettings, type GraphSettingsView } from './graph-settings'
import { createDeterministicFakeLlm } from './fake-llm'
import { createGraphWindow } from './graph-window'
import { runGraphBackfill } from './graph-backfill-runtime'
import { embeddingModelCandidates, pickEmbeddingModelDir } from '../understand/embedding/paths'
import { isModelReady } from '../understand/embedding/session'
import { registerGraphIpc, type ProviderKeySaveResult } from './graph-ipc'
import { validateApiKey, writeEnvKey } from './provider-keys'
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
import { toggleEnabled } from './tray-menu'
import {
  DEFAULT_HOTKEYS,
  HOTKEY_SETTING_KEYS,
  registerHotkeys,
  type HotkeyBindings,
  type HotkeyHandle
} from './hotkeys'
import { persistSwitch, pauseCapture, readSwitchSettings, StartupResumeCountdown } from './capture-switch'
import { createFakeCaptureSession } from './fake-capture'

// 测试隔离钩子：E2E 用临时 userData，绝不碰真实数据（gotchas.md）
if (process.env.GOTCHA_USER_DATA) {
  mkdirSync(process.env.GOTCHA_USER_DATA, { recursive: true })
  app.setPath('userData', process.env.GOTCHA_USER_DATA)
}

/** 启动参数直开（--capture / GOTCHA_CAPTURE=1）只调试用，不写 settings（D13） */
const launchCapture = resolveCapture(process.argv, process.env)
/** 只有显式 UI 操作（Alt+P / 托盘 / 球右键）才落盘两键；--capture 直开不写 */
const persistsSwitch = !launchCapture

/**
 * E2E 假采集：必须同时满足「显式开关 + 临时 userData + 非打包态」；
 * 任一不满足就走真实采集路径，绝不静默降级（§3 Phase 2 / §6）。
 */
const fakeCapture =
  process.env.GOTCHA_FAKE_CAPTURE === '1' &&
  Boolean(process.env.GOTCHA_USER_DATA) &&
  !app.isPackaged

/**
 * E2E 假 LLM：同样要求「显式开关 + 临时 userData + 非打包态」，且只在假采集链路里用。
 * 只要不是三个条件同时满足就按真实供应商配置解析，绝不静默降级成假数据。
 */
const fakeLlm =
  process.env.GOTCHA_FAKE_LLM === '1' &&
  Boolean(process.env.GOTCHA_USER_DATA) &&
  !app.isPackaged
const fakeLlmBundle = fakeLlm
  ? createDeterministicFakeLlm({
      delayMs: Math.max(0, Number(process.env.GOTCHA_FAKE_LLM_DELAY_MS) || 0)
    })
  : null

const dbPath = join(app.getPath('userData'), DB_FILE_NAME)
/**
 * 进程级复用：dispose() 仍销毁隐藏窗口 / 媒体流（Q6），但 ScreenCapture 保留一次
 * desktopCapturer.getSources() 得到的显示源映射。否则每次 Alt+P 恢复都会重新执行
 * 已知会同步冻结主进程 1.2–2.3s 的源枚举。假采集路径不会使用它。
 */
const screenCapture = fakeCapture
  ? null
  : new ScreenCapture({
      devServerUrl: process.env['ELECTRON_RENDERER_URL'],
      htmlPath: join(__dirname, '../renderer/capture.html')
    })

let mainWindow: BrowserWindow | null = null
let graphWindow: BrowserWindow | null = null
let ballShell: BallShell | null = null
let trayShell: TrayShell | null = null
let hotkeyHandle: HotkeyHandle | null = null
let hotkeyNoticeShown = false
let inductionRuntime: InductionRuntime | null = null
let disposeGraphIpc: (() => void) | null = null
let startupCountdown: StartupResumeCountdown | null = null
/** 倒计时到点后的 starting 阶段，Alt+P 可把自动恢复接管为显式开启 */
let startupResumeClaimedExplicitly = false
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
  dbPath,
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

/** 启动清理上次崩溃 / 删除失败留下的临时帧（F06）：只删 userData/tmp 下的 frame-*.png */
function cleanTempFramesOnStartup(): void {
  const cleaned = cleanStaleFrames(join(app.getPath('userData'), 'tmp'))
  if (cleaned.removed === 0 && cleaned.failed === 0) return
  captureLog(cleaned.failed > 0 ? 'warn' : 'info', 'temp frames cleaned on startup', {
    removed: cleaned.removed,
    failed: cleaned.failed
  })
}

/* ------------------------------------------------------------------ *
 * 图谱 / 归纳接线（M2 Phase 2）
 * ------------------------------------------------------------------ */

/** 用户目录 `.env`（KEY=VALUE）；缺失 / 读失败都返回空对象。密钥只从 env / .env 读。 */
function loadUserEnv(): Record<string, string> {
  try {
    return loadEnvFile(join(app.getPath('userData'), '.env'))
  } catch {
    return {}
  }
}

/** 当前保存的供应商列表（无库时用默认预设；坏 JSON 返回空，设置界面据此提示） */
function currentProviders(): LlmProvider[] {
  const db = connections.queryDb()
  if (!db) return [{ ...DEFAULT_PROVIDER }]
  return parseProvidersConfig(getSetting(db, GRAPH_SETTING_KEYS.providers)).providers
}

/** 已保存供应商的密钥：进程环境变量 > userData/.env；未知供应商 / 未配置返回空串 */
function storedProviderKey(providerId: string): string {
  const provider = currentProviders().find((item) => item.id === providerId)
  if (!provider) return ''
  const resolved = resolveLlmProvider(providerId, [provider], process.env, loadUserEnv())
  return resolved.ok ? resolved.apiKey : ''
}

/** 设置界面只显示密钥来源（env / .env / 未配置），不把值送到渲染进程 */
function providerKeyStatus(): Record<string, ApiKeySource> {
  const fileEnv = loadUserEnv()
  const status: Record<string, ApiKeySource> = {}
  for (const provider of currentProviders()) {
    status[provider.id] = apiKeySource(provider.apiKeyEnv, process.env, fileEnv)
  }
  return status
}

/**
 * 写入设置界面填写的 API Key：只进 `userData/.env`（与手写 .env 同一读取路径），
 * 不进 settings 表、不进日志、不回显。同名环境变量存在时如实告知它优先。
 */
function saveProviderKey(providerId: string, apiKey: string): ProviderKeySaveResult {
  const provider = currentProviders().find((item) => item.id === providerId)
  if (!provider) return { ok: false, error: '供应商不存在，请先保存供应商配置' }
  const validated = validateApiKey(apiKey)
  if (!validated.ok) return validated
  try {
    writeEnvKey(join(app.getPath('userData'), '.env'), provider.apiKeyEnv, validated.key)
  } catch (error) {
    captureLog('warn', 'provider key write failed', { error: String(error) })
    return { ok: false, error: '无法写入 userData/.env（检查文件权限）' }
  }
  // 密钥立即生效：刷新图谱窗口的供应商状态
  pushGraphSnapshot()
  const source = apiKeySource(provider.apiKeyEnv, process.env, loadUserEnv())
  return source === 'env'
    ? { ok: true, warning: `已写入 .env；但同名环境变量 ${provider.apiKeyEnv} 存在，实际仍用它` }
    : { ok: true }
}

/**
 * 解析当前生效供应商 → 客户端。失败只返回原因（missing-key / invalid-providers /
 * unknown-provider / invalid-config），不抛到采集与 UI。
 */
function resolveClient(): ClientResolution {
  if (fakeLlmBundle) return { ok: true, client: fakeLlmBundle.client }
  const db = connections.queryDb()
  const resolved = resolveFromSettings(
    {
      active: db ? getSetting(db, GRAPH_SETTING_KEYS.activeProvider) : '',
      providers: db ? getSetting(db, GRAPH_SETTING_KEYS.providers) : ''
    },
    process.env,
    loadUserEnv()
  )
  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.reason,
      apiKeyEnv: resolved.reason === 'missing-key' ? resolved.apiKeyEnv : undefined
    }
  }
  try {
    return {
      ok: true,
      client: createDeepSeekClient({
        baseUrl: resolved.provider.baseUrl,
        model: resolved.provider.model,
        apiKey: resolved.apiKey
      })
    }
  } catch (error) {
    captureLog('warn', 'llm client init failed', { error: String(error) })
    return { ok: false, reason: 'invalid-config' }
  }
}

/** 模型候选目录（设置覆盖 → 打包资源 → 仓库 resources → userData 历史位置） */
function embeddingModelDirs(): string[] {
  const db = connections.queryDb()
  return embeddingModelCandidates({
    setting: db ? getSetting(db, 'graph.embedding_model_dir') : '',
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userDataDir: app.getPath('userData')
  })
}

/** 选中真正可用的模型目录（随应用分发的模型在大多数机器上直接命中，用户不用手工放置） */
function resolveModelDir(): string {
  return pickEmbeddingModelDir(embeddingModelDirs(), isModelReady)
}

/**
 * 本地向量模型是否就绪（`model.onnx` + `vocab.txt` 都在）。
 * 只 stat 两个文件；读设置走只读连接，模型没装时更不能因为一次状态查询去建库（A3）。
 */
function readEmbeddingsReady(): boolean {
  return isModelReady(resolveModelDir())
}

/** 归纳运行时未创建时的只读快照（不建库；图谱窗口在采集暂停时也能显示原因） */
function currentInductionSnapshot(): InductionSnapshot {
  if (inductionRuntime) return inductionRuntime.getSnapshot()
  const db = connections.queryDb()
  const resolved = resolveClient()
  return {
    status: 'stopped',
    halted: false,
    consent: db ? getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1' : false,
    captureRunning: controller.status() === 'running',
    client: resolved.ok
      ? { ok: true }
      : { ok: false, reason: resolved.reason, apiKeyEnv: resolved.apiKeyEnv },
    embeddingsReady: readEmbeddingsReady()
  }
}

function pushGraphSnapshot(snapshot?: InductionSnapshot): void {
  if (!graphWindow || graphWindow.isDestroyed()) return
  graphWindow.webContents.send('graph:status', snapshot ?? currentInductionSnapshot())
}

/** 懒创建：只有采集真正跑起来 / 图谱窗口需要动作时才拿写连接，默认暂停不建库（A3） */
function ensureInductionRuntime(): InductionRuntime {
  if (inductionRuntime) return inductionRuntime
  inductionRuntime = createInductionRuntime({
    getDb: () => connections.ensureWritable().db,
    resolveClient,
    readConsent: () => {
      const db = connections.queryDb()
      return db ? getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1' : false
    },
    onSnapshot: (snapshot) => pushGraphSnapshot(snapshot),
    /**
     * 本地向量模型是否就绪：顶部黄条「新主题暂无法计算」用。
     * 每次取快照现读，用户装好模型后下一次刷新就会消失。
     */
    readEmbeddingsReady,
    log: captureLog
  })
  return inductionRuntime
}

function readHotkeyBindings(): HotkeyBindings {
  const db = connections.queryDb()
  if (!db) return { ...DEFAULT_HOTKEYS }
  return {
    toggleCapture:
      getSetting(db, HOTKEY_SETTING_KEYS.toggleCapture).trim() || DEFAULT_HOTKEYS.toggleCapture,
    openGraph:
      getSetting(db, HOTKEY_SETTING_KEYS.openGraph).trim() || DEFAULT_HOTKEYS.openGraph
  }
}

/** 注册 / 重绑（设置保存后调用）：冲突在球上提示，托盘菜单仍可兜底 */
function registerGlobalHotkeys(): void {
  hotkeyHandle?.dispose()
  hotkeyHandle = registerHotkeys(
    globalShortcut,
    {
      toggleCapture: () => {
        void toggleCapture()
      },
      openGraph: () => openGraph()
    },
    readHotkeyBindings(),
    captureLog
  )
  const failed = hotkeyHandle.results.filter((result) => !result.ok)
  if (failed.length > 0) {
    const detail = failed.map((result) => `${result.accelerator}（${result.reason}）`).join('、')
    ballShell?.showNotice({
      kind: 'hotkey-unavailable',
      text: `全局热键不可用：${detail}，可修改设置或从菜单打开`
    })
    hotkeyNoticeShown = true
  } else if (hotkeyNoticeShown) {
    ballShell?.showNotice(null)
    hotkeyNoticeShown = false
  }
}

/**
 * 设置保存后：重绑热键；确认门变化时启停归纳（授权 / 撤销）。
 * `previousConsent` 必须是**保存前**读到的值（由 IPC 层在写库前取）。
 * 旧实现拿 `inductionRuntime.getSnapshot().consent` 来比——那已经是写库后的新值，
 * 比较永远相等，于是「撤销出网授权」停不掉调度、也 abort 不了在途请求（D24 漏洞，2026-10-25 修）。
 */
function applyGraphSettings(settings: GraphSettingsView, previousConsent: boolean): void {
  registerGlobalHotkeys()
  if (!inductionRuntime) return
  if (previousConsent !== settings.outboundConsent) {
    inductionRuntime.setConsent(settings.outboundConsent)
  }
}

/** 打开图谱时后台回填 v3 结构（时刻/归属）与主题向量；模型缺失时只回填结构 */
function runGraphBackfillInBackground(): void {
  if (shuttingDown) return
  // A3 红线：默认暂停 / 从未建库时不允许因为「打开图谱」而建库或写盘
  if (!existsSync(dbPath)) return
  let db: Db
  try {
    db = connections.ensureWritable().db
  } catch (error) {
    captureLog('warn', 'graph backfill: database unavailable', {
      error: error instanceof Error ? error.name : 'unknown'
    })
    return
  }
  void runGraphBackfill({ db, modelDir: resolveModelDir(), log: captureLog })
}

function showGraphWindow(): void {
  if (!app.isReady()) return
  if (graphWindow && !graphWindow.isDestroyed()) {
    if (graphWindow.isMinimized()) graphWindow.restore()
    graphWindow.show()
    graphWindow.focus()
    return
  }
  graphWindow = createGraphWindow({
    devServerUrl: process.env['ELECTRON_RENDERER_URL'],
    htmlPath: join(__dirname, '../renderer/graph/global.html'),
    preloadPath: join(__dirname, '../preload/graph.js'),
    onClosed: () => {
      graphWindow = null
    }
  })
  runGraphBackfillInBackground()
}

/** D20：球点击 / Alt+Space 默认打开图谱；打开即视为一次交互（取消启动自动恢复倒计时） */
function openGraph(): void {
  cancelStartupResume(true)
  showGraphWindow()
}

app.on('window-all-closed', () => {
  // 球窗口常驻，正常不会触发；仅当球没起来（窗口全关）时按旧行为退出
  if (!quitRequested) app.quit()
})

app.on('before-quit', (event) => {
  quitRequested = true
  if (shuttingDown) return
  shuttingDown = true
  startupCountdown?.cancel()
  hotkeyHandle?.dispose()
  disposeGraphIpc?.()
  inductionRuntime?.dispose()
  inductionRuntime = null
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
    if (fakeCapture || fakeLlm) globalThis.__gotchaTest = undefined
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

/** 用户主动打开时间线 = 一次交互：取消在途的启动自动恢复并把意图置 0（D13） */
function openTimeline(): void {
  cancelStartupResume(true)
  showTimelineWindow()
}

/**
 * 从节点下钻打开时间线并定位到某一天（C4）：
 * - 窗口已存在：发 `timeline:set-day` 并聚焦，不重建；
 * - 未创建：带 `?day=<ts>` 初始化，渲染进程据此切日。
 */
function openTimelineDay(day: number | null): void {
  cancelStartupResume(true)
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (day !== null) mainWindow.webContents.send('timeline:set-day', day)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createMainWindow(day)
}

function createMainWindow(initialDay: number | null = null): void {
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
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    if (initialDay !== null) url.searchParams.set('day', String(initialDay))
    void mainWindow.loadURL(url.toString())
  } else {
    void mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      initialDay !== null ? { query: { day: String(initialDay) } } : undefined
    )
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
    createScreenStream: () => {
      if (!screenCapture) throw new Error('真实屏幕采集器未初始化')
      return screenCapture
    },
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
  createSession: fakeCapture
    ? async () => {
        const delayMs = Math.max(0, Number(process.env.GOTCHA_FAKE_CAPTURE_START_DELAY_MS) || 0)
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        return createFakeCaptureSession()
      }
    : createSession,
  log: captureLog,
  onStatusChange: (status) => {
    ballShell?.setStatus(status)
    trayShell?.update(status)
    if (!shuttingDown && (status === 'running' || status === 'paused' || status === 'stopping')) {
      ensureInductionRuntime().onCaptureStatus(status)
    }
    if (!shuttingDown) pushGraphSnapshot()
  }
})

/**
 * 为写 settings 打开写连接（显式操作才到这里：临时 userData / 空库会建库，属 A3 收窄口径）。
 * 打不开就放弃本次写入并记 warn，不阻塞开关动作。
 */
function switchDb(): Db | null {
  try {
    return connections.ensureWritable().db
  } catch (error) {
    captureLog('warn', 'switch settings write skipped (db unavailable)', {
      error: String(error)
    })
    return null
  }
}

/**
 * 启动自动恢复：`resume_on_start=1` 时先暂停视觉 + 3s 倒计时，到点才真正开始。
 * 失败保持暂停 + 球上提示，不写 settings（启动恢复不是新的显式授权，D13/A3）。
 */
async function resumeFromStartup(): Promise<void> {
  try {
    await controller.start()
    // ScreenCapture 首次起流可能同步冻结主进程；让冻结期间排队的热键 / 球 IPC 先处理，
    // 再决定自动恢复是否真正完成，避免用户明明在倒计时内操作却被判为来不及取消。
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (!startupCountdown?.active) {
      if (startupResumeClaimedExplicitly) {
        startupResumeClaimedExplicitly = false
        if (persistsSwitch) {
          const db = switchDb()
          if (db) persistSwitch(db, true)
        }
        ballShell?.showNotice(null)
        captureLog('info', 'capture startup resume claimed by explicit toggle')
        return
      }
      await controller.stop()
      captureLog('info', 'capture startup resume canceled during start')
      return
    }
    startupCountdown.complete()
    ballShell?.showNotice(null)
    captureLog('info', 'capture resumed on start')
  } catch (error) {
    startupResumeClaimedExplicitly = false
    startupCountdown?.complete()
    ballShell?.showNotice({ kind: 'error', text: '自动恢复失败，仍为暂停' })
    captureLog('error', 'capture resume on start failed', { error: String(error) })
  }
}

function scheduleStartupResume(): void {
  startupCountdown = new StartupResumeCountdown({
    onTick: (seconds) => ballShell?.showNotice({ kind: 'countdown', seconds }),
    onDue: () => {
      void resumeFromStartup()
    }
  })
  startupCountdown.start()
  trayShell?.balloon('3 秒后开始记录', '点球或按 Alt+P 可取消，托盘菜单同样有效')
}

/**
 * 取消在途的启动自动恢复；`persist` 时把两键置 0/0（用户点球 / 托盘 / 退出都算取消，
 * 按 D13「3s 内任意交互即取消」落盘）。Alt+P 在倒计时里按则是立刻显式开始，见 toggleCapture。
 */
function cancelStartupResume(persist: boolean): boolean {
  if (!startupCountdown?.cancel()) return false
  ballShell?.showNotice(null)
  if (persist && persistsSwitch) {
    const db = switchDb()
    if (db) persistSwitch(db, false)
  }
  return true
}

/** 读启动恢复授权：没有库（空 userData）就是暂停，不建库、不写盘（A3） */
function readResumeOnStart(): boolean {
  if (!existsSync(dbPath)) return false
  try {
    return readSwitchSettings(connections.queryDb()).resumeOnStart
  } catch (error) {
    captureLog('warn', 'capture switch settings unreadable', { error: String(error) })
    return false
  }
}

/**
 * 唯一 toggle 入口（Alt+P / 托盘 / 球右键共用，§3 Phase 2）：
 * - 暂停：先落 0/0 再关闸（顺序反了会在退出 / 崩溃中途残留「已授权恢复」）；
 *   写库失败也必须关闸（F01：隐私暂停不能依赖磁盘可用），失败在球上可见；
 * - 恢复：`await start()` 成功后才切亮，失败保持暂停 + 角标提示，绝不「显示运行但没采」。
 * 转换在途（starting / stopping）忽略重复触发，避免连点排队。
 */
async function toggleCapture(): Promise<void> {
  // Alt+P 在倒计时里 = 立刻显式开始。若到点后的真实起流已经进入 starting，
  // 接管该 in-flight start；不能被 toggleEnabled(starting)=false 静默忽略。
  const canceledStartupResume = cancelStartupResume(false)
  const status = controller.status()
  if (canceledStartupResume && status === 'starting') {
    startupResumeClaimedExplicitly = true
    try {
      await controller.start()
    } catch {
      // resumeFromStartup 负责统一显示失败提示与日志；这里只清标记，避免 void 调用未处理拒绝。
      startupResumeClaimedExplicitly = false
    }
    return
  }
  if (!toggleEnabled(status)) return

  if (status === 'running') {
    const result = await pauseCapture({
      persist: persistsSwitch
        ? () => {
            const db = switchDb()
            if (!db) throw new Error('capture switch db unavailable')
            persistSwitch(db, false)
          }
        : undefined,
      stop: () => controller.stop()
    })
    if (result.persistError) {
      captureLog('error', 'capture switch pause persist failed', {
        error: String(result.persistError)
      })
    }
    if (result.stopError) {
      captureLog('error', 'capture stop failed', { error: String(result.stopError) })
    }
    if (!result.stopped) {
      ballShell?.showNotice({
        kind: 'error',
        text: result.saved ? '暂停未完成，仍在记录，请重试' : '暂停未完成且授权未保存，请重试'
      })
    } else if (!result.saved) {
      ballShell?.showNotice({
        kind: 'error',
        text: '已暂停记录，但授权未保存，下次启动仍可能自动恢复'
      })
    }
    return
  }

  try {
    await controller.start()
    if (persistsSwitch) {
      const db = switchDb()
      if (db) persistSwitch(db, true)
    }
    ballShell?.showNotice(null)
  } catch (error) {
    ballShell?.showNotice({ kind: 'error', text: '开始记录失败，检查屏幕录制权限后重试' })
    captureLog('error', 'capture start failed', { error: String(error) })
  }
}

/** 测试钩子：只在假采集（临时 userData + 非打包）下挂到主进程 globalThis */
interface GotchaTestHook {
  toggle(): Promise<void>
  status(): string
  notice(notice: unknown): void
  /** D20：全局热键无法用合成按键触发，E2E 走同一入口 */
  openGraph(): void
  openTimeline(): void
  /** 假 LLM 请求计数（断言暂停后零新增请求 / 零真实网络） */
  fakeLlm(): { requests: number; aborted: number } | null
  induction(): InductionSnapshot
}

declare global {
  var __gotchaTest: GotchaTestHook | undefined
}

function installTestHook(): void {
  globalThis.__gotchaTest = {
    toggle: () => toggleCapture(),
    status: () => controller.status(),
    notice: (notice) => {
      if (notice === null) ballShell?.showNotice(null)
      else ballShell?.showNotice(notice as Parameters<BallShell['showNotice']>[0])
    },
    openGraph: () => openGraph(),
    openTimeline: () => openTimeline(),
    fakeLlm: () =>
      fakeLlmBundle
        ? { requests: fakeLlmBundle.counters.requests, aborted: fakeLlmBundle.counters.aborted }
        : null,
    induction: () => currentInductionSnapshot()
  }
}

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
  openTimeline()
})

if (primaryInstance) {
  app.whenReady().then(async () => {
    cleanTempFramesOnStartup()
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

    disposeGraphIpc = registerGraphIpc({
      getGraphWindow: () => graphWindow,
      queryGraph: (from, to) => {
        const db = connections.queryDb()
        return db ? queryGraphDay(db, from, to, { includeEvents: true }) : { nodes: [], edges: [] }
      },
      queryGlobal: () => {
        const db = connections.queryDb()
        return db ? queryGlobalGraph(db) : emptyGlobalGraph()
      },
      queryNodeEvents: (nodeId) => {
        const db = connections.queryDb()
        return db
          ? queryNodeEvents(db, nodeId)
          : { found: false, events: [], missingIds: [], malformed: false }
      },
      queryMomentEvents: (momentId) => {
        const db = connections.queryDb()
        return db
          ? queryMomentEvents(db, momentId)
          : { found: false, events: [], missingIds: [], malformed: false }
      },
      search: (input) => {
        const db = connections.queryDb()
        // A3 红线：没有库（从未采集）时不因为搜索建库，返回空结果
        return db
          ? searchEvents(db, input)
          : { query: '', mode: 'empty', hits: [], matchedEvents: 0, truncated: false }
      },
      searchHitEvents: (input) => {
        const db = connections.queryDb()
        return db
          ? querySearchHitEvents(db, input)
          : { found: false, events: [], missingIds: [], malformed: false }
      },
      searchApps: () => {
        const db = connections.queryDb()
        return db ? listSearchApps(db) : []
      },
      savePositions: (input) => {
        // A3 红线：从未建库时不能因为画布沉降而建库 / 写盘
        if (!existsSync(dbPath)) return { ok: true, saved: 0, rejected: 0 }
        // 显式 UI 动作（Foam 沉降后回写 seed）：允许打开写连接
        const db = connections.ensureWritable().db
        return saveNodePositions(db, input)
      },
      getSnapshot: currentInductionSnapshot,
      runInductionNow: (dayStart?: number) =>
        ensureInductionRuntime().runOnce({ manual: true, dayStart }),
      setConsent: (consented) => ensureInductionRuntime().setConsent(consented),
      readSettings: () => readGraphSettings(connections.queryDb()),
      saveSettings: (patch) => {
        // 显式 UI 动作：允许打开写连接（默认暂停仍不建库）
        const db = connections.ensureWritable().db
        return saveGraphSettings(db, patch)
      },
      onSettingsSaved: applyGraphSettings,
      getHotkeys: () => hotkeyHandle?.results ?? [],
      openTimeline: (day) => openTimelineDay(day ?? null),
      fetchProviderModels: async (input) => {
        // 输入框里未保存的密钥优先；留空则用已保存的（env > .env）
        const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : storedProviderKey(input.providerId)
        return fetchModelsFromProvider({ baseUrl: input.baseUrl, apiKey })
      },
      saveProviderKey: (providerId, apiKey) => saveProviderKey(providerId, apiKey),
      getProviderKeyStatus: () => providerKeyStatus(),
      log: captureLog
    })

    ballShell = createBallShell({
      preloadPath: join(__dirname, '../preload/ball.js'),
      devServerUrl: process.env['ELECTRON_RENDERER_URL'],
      htmlPath: join(__dirname, '../renderer/ball/ball.html'),
      stateFilePath: join(app.getPath('userData'), BALL_STATE_FILE),
      getStatus: () => controller.status(),
      openTimeline,
      openGraph,
      toggleCapture: () => {
        void toggleCapture()
      },
      quit: () => {
        cancelStartupResume(true)
        app.quit()
      },
      log: captureLog
    })

    trayShell = installTray(
      {
        openGraph,
        openTimeline,
        toggleCapture: () => {
          void toggleCapture()
        },
        quit: () => {
          cancelStartupResume(true)
          app.quit()
        }
      },
      controller.status()
    )

    // 球是常驻外壳：窗口被关掉（异常 / 调试）就退出，避免只剩隐藏采集窗口驻留进程
    ballShell.window.on('closed', () => {
      if (!quitRequested) app.quit()
    })

    if (fakeCapture || fakeLlm) installTestHook()

    registerGlobalHotkeys()

    // Q1=B：只有上次显式开启（resume_on_start=1）才延迟 3s 自动恢复，且可被任意交互取消
    if (!launchCapture && readResumeOnStart()) scheduleStartupResume()
  })
}
