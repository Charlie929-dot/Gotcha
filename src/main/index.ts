import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import Database from 'better-sqlite3'
import log from 'electron-log/main'
import { DB_FILE_NAME, openDatabase, queryTimeline, type Db } from '../db'
import { getNumberSetting, getSetting, setSetting } from '../db/settings'
import { readUsage, recordUsage } from '../understand/induction'
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
import {
  createInductionRuntime,
  type ClientResolution,
  type InductionRuntime,
  type InductionSnapshot
} from './induction-runtime'
import { GRAPH_SETTING_KEYS, readGraphSettings, saveGraphSettings, type GraphSettingsView } from './graph-settings'
import { createDeterministicFakeLlm } from './fake-llm'
import { createDeterministicFakeEmbedder, type DeterministicFakeEmbedder } from './fake-embedding'
import { createGraphWindow } from './graph-window'
import { createAskWindow } from './ask-window'
import { askChain } from '../chain/agent/ask'
import { readSegmentEvidence } from '../chain/agent/evidence'
import { runGraphBackfill, loadSharedEmbedder } from './graph-backfill-runtime'
import { createMomentRuntime, type MomentRuntime } from './moment-runtime'
import {
  createThemeOnlineRuntime,
  type OnlineTickResult,
  type ThemeOnlineRuntime
} from './theme-online-runtime'
import { embeddingModelCandidates, pickEmbeddingModelDir } from '../understand/embedding/paths'
import type { Embedder } from '../understand/embedding/types'
import { createLocalEmbedder, isModelReady } from '../understand/embedding/session'
import {
  registerGraphIpc,
  type GraphChangedEvent,
  type GraphRecomputeResult,
  type ProviderKeySaveResult
} from './graph-ipc'
import { registerAskIpc, type AskConsentView } from './ask-ipc'
import {
  appendAskHistory,
  ASK_HISTORY_FILE,
  clearAskHistory,
  readAskHistory,
  toHistoryEntry
} from './ask-history'
import { listThemeMerges, revertThemeMerge } from '../understand/theme-merge'
import { validateApiKey, writeEnvKey } from './provider-keys'
import {
  CaptureController,
  CaptureDbConnections,
  createCaptureSession,
  type CaptureLog,
  type CaptureSession
} from './capture-controller'
import { resolveCapture } from './args'
import {
  createChainRecording,
  loadChainEventSource,
  type ChainRecordingHandle
} from './chain-recording'
import { DEFAULT_RETENTION, type RetentionEncoding } from '../chain/retention'
import type { EncodedImage } from './chain-retention'
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

/**
 * E2E 假向量：与假采集 / 假 LLM 同一套三条件门（显式开关 + 临时 userData + 非打包态）。
 * 在线路径的 E2E 必须注入它（docs/m2-graph-redesign.md §13.2）：真模型要加载 ~0.5 s，
 * 且相似度不可控，「哪个时刻归到哪个主题」的断言会随模型输出漂。
 * 注入后 `readEmbeddingsReady()` 按就绪处理——这是测试口径，不是对用户的静默降级。
 */
const fakeEmbedding =
  process.env.GOTCHA_FAKE_EMBEDDING === '1' &&
  Boolean(process.env.GOTCHA_USER_DATA) &&
  !app.isPackaged
const fakeEmbeddingBundle: DeterministicFakeEmbedder | null = fakeEmbedding
  ? createDeterministicFakeEmbedder()
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
/** 问记忆窗口（S3-lite） */
let askWindow: BrowserWindow | null = null
let ballShell: BallShell | null = null
let trayShell: TrayShell | null = null
let hotkeyHandle: HotkeyHandle | null = null
let hotkeyNoticeShown = false
let inductionRuntime: InductionRuntime | null = null
/** 采集运行时的时刻在线补跑（M2 P2 · S1；本地、零出网） */
let momentRuntime: MomentRuntime | null = null
/** 在线归属（M2 P2 · S6）：新时刻 → 主题 / 命名 / 模糊确认；本地模型就绪时接管新数据 */
let themeOnlineRuntime: ThemeOnlineRuntime | null = null
let disposeGraphIpc: (() => void) | null = null
let disposeAskIpc: (() => void) | null = null
/**
 * 信息链接线（D42）：跟采集开关同一条命。启动时加载原生事件源（失败就降级成不采集），
 * 采集 running 时开、stopping 时收口并等在途截图落库。
 */
let chainRecording: ChainRecordingHandle | null = null
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

/**
 * 主进程未捕获异常 / 未处理的 Promise 拒绝：**写进 main.log，不弹 Electron 错误窗**。
 *
 * 2026-10-27 真机踩到：一个「段结束早于子行」的校验错在定时器里抛出，Electron 弹了个
 * 标题 `Error` 的窗——抢前台 14.6 秒、还变成了一段，而日志里什么都没有。有了这条，
 * 栈会落在 main.log 的 error 行里，事后能查（代价是看不到系统弹窗，日志即证据）。
 */
function installCrashLogging(): void {
  process.on('uncaughtException', (error) => {
    const detail = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
    try {
      captureLog('error', 'uncaught exception', detail)
    } catch {
      // 日志本身挂了就只能认了，别在异常处理里再抛
    }
    console.error('[gotcha] uncaught exception', detail)
  })
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? { message: reason.message, stack: reason.stack } : { message: String(reason) }
    try {
      captureLog('error', 'unhandled rejection', detail)
    } catch {
      // 同上
    }
    console.error('[gotcha] unhandled rejection', detail)
  })
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
  // 密钥立即生效：刷新图谱窗口的供应商状态；在线路径也唤醒一下（等待中的命名 / 确认可以发了）
  pushGraphSnapshot()
  themeOnlineRuntime?.wake()
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
 * 图谱回填 / 在线归属共用的 embedder 入口。
 * E2E 注入假向量时直接返回假实现（不加载 95 MB 模型）；正常路径仍走进程内共享的真模型会话。
 */
function loadGraphEmbedder(): Promise<Embedder | null> {
  if (fakeEmbeddingBundle) return Promise.resolve(fakeEmbeddingBundle.embedder)
  return loadSharedEmbedder(resolveModelDir(), { log: captureLog })
}

/**
 * 信息链派生用的本地向量会话：模型与图谱共用一份文件，但 `maxLength = 512`
 * （段正文比单条 OCR 长；图谱那份是 256、批 1，别混用）。懒加载、进程内只建一次；
 * 模型缺失只关向量，标签 / 双链照抽（名字只能做精确同名合并）。
 */
let chainEmbedder: Promise<Embedder | null> | null = null
function loadChainEmbedder(): Promise<Embedder | null> {
  if (fakeEmbeddingBundle) return Promise.resolve(fakeEmbeddingBundle.embedder)
  if (!chainEmbedder) {
    chainEmbedder = createLocalEmbedder({
      modelDir: resolveModelDir(),
      maxLength: 512,
      batchSize: 1,
      intraOpNumThreads: 4
    }).catch((error: unknown) => {
      captureLog('warn', 'chain embedder unavailable', {
        error: error instanceof Error ? error.name : 'unknown'
      })
      chainEmbedder = null
      return null
    })
  }
  return chainEmbedder
}

/** 回填的 embedder 工厂：只有假向量注入时才显式给（真模型路径自己按 `modelDir` 加载） */
function createEmbedderFactory(): { createEmbedder?: (modelDir: string) => Promise<Embedder> } {
  if (!fakeEmbeddingBundle) return {}
  const embedder = fakeEmbeddingBundle.embedder
  return { createEmbedder: async () => embedder }
}

/**
 * 本地向量模型是否就绪（`model.onnx` + `vocab.txt` 都在）。
 * 只 stat 两个文件；读设置走只读连接，模型没装时更不能因为一次状态查询去建库（A3）。
 * E2E 注入假向量时按就绪处理：在线路径的开关判定依赖它（`onlineThemesActive`）。
 */
function readEmbeddingsReady(): boolean {
  return fakeEmbeddingBundle !== null || isModelReady(resolveModelDir())
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

/**
 * 归纳落库后通知开着的图谱窗口就地刷新（手动 / 自动都推）。
 * 没有窗口就什么都不做——下次打开自然会拉到新数据，不为了通知去建窗口。
 */
function pushGraphChanged(outcome: {
  nodes: number
  edges: number
  placeholders: number
}): void {
  if (!graphWindow || graphWindow.isDestroyed()) return
  const event: GraphChangedEvent = {
    nodes: outcome.nodes,
    edges: outcome.edges,
    placeholders: outcome.placeholders,
    at: Date.now()
  }
  graphWindow.webContents.send('graph:changed', event)
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
     * 在线路径可用时，自动批量归纳让位（P2 · S6）：新数据由在线归属处理，
     * 批量归纳降级为「补历史 / 调试」；手动「立即归纳」不受影响。
     */
    shouldAutoRun: () => !onlineThemesActive(),
    /**
     * 归纳落库后推 `graph:changed`：自动归纳跑完，开着的画布就地刷新
     * （以前只有手动「立即归纳」会重新拉图，自动跑完得关掉窗口再打开才看得到）。
     */
    onGraphChanged: (outcome) => pushGraphChanged(outcome),
    /**
     * 本地向量模型是否就绪：顶部黄条「新主题暂无法计算」用。
     * 每次取快照现读，用户装好模型后下一次刷新就会消失。
     */
    readEmbeddingsReady,
    log: captureLog
  })
  return inductionRuntime
}

/**
 * 时刻在线补跑（M2 P2 · S1）：采集跑起来时每 60s 把稳定下来的事件补成时刻。
 * 本地、零出网、不依赖向量模型，因此不受 D24 出网门约束。
 * A3 口径：一次都没跑过采集（库还没建）时不为了定时器建库，直接不起。
 */
function ensureMomentRuntime(): MomentRuntime | null {
  if (momentRuntime) return momentRuntime
  if (!connections.queryDb()) return null
  try {
    momentRuntime = createMomentRuntime({
      db: connections.ensureWritable().db,
      log: captureLog
    })
  } catch (error) {
    captureLog('warn', 'moment runtime unavailable', {
      error: error instanceof Error ? error.name : 'unknown'
    })
    return null
  }
  return momentRuntime
}

/** 在线归属开关（`graph.online_themes`，缺省开）；无库时不建库、按默认开处理 */
function readOnlineThemesEnabled(): boolean {
  const db = connections.queryDb()
  return db ? getSetting(db, GRAPH_SETTING_KEYS.onlineThemes) === '1' : true
}

/**
 * 在线路径是否真的能接手新数据：开关打开 + 本地向量模型就绪。
 * 自动批量归纳据此让位（`inductionRuntime` 的 `shouldAutoRun`）——模型没装时
 * 在线路径算不出向量，批量归纳仍是唯一的建主题路径（G5）。
 */
function onlineThemesActive(): boolean {
  if (!readOnlineThemesEnabled()) return false
  return readEmbeddingsReady()
}

/**
 * 在线归属运行时（M2 P2 · S6）：采集 running 时每 60s 跑一轮。
 * - 本地归属 / 向量零出网；命名与模糊确认走 `theme-queue` 串行队列；
 * - 出网受 D24 确认门、D18 暂停、每日预算与指数退避约束（队列层 + 本层钳制）；
 * - A3：库还没建（一次都没跑过采集）时不为了定时器建库。
 */
function ensureThemeOnlineRuntime(): ThemeOnlineRuntime | null {
  if (themeOnlineRuntime) return themeOnlineRuntime
  if (!connections.queryDb()) return null
  let db: Db
  try {
    db = connections.ensureWritable().db
  } catch (error) {
    captureLog('warn', 'theme online runtime unavailable', {
      error: error instanceof Error ? error.name : 'unknown'
    })
    return null
  }
  themeOnlineRuntime = createThemeOnlineRuntime({
    db,
    resolveClient,
    readConsent: () => {
      const current = connections.queryDb()
      return current ? getSetting(current, GRAPH_SETTING_KEYS.outboundConsent) === '1' : false
    },
    readEmbeddingsReady,
    loadEmbedder: loadGraphEmbedder,
    readEnabled: readOnlineThemesEnabled,
    onGraphChanged: (outcome) => pushGraphChanged(outcome),
    log: captureLog
  })
  return themeOnlineRuntime
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
  if (inductionRuntime && previousConsent !== settings.outboundConsent) {
    inductionRuntime.setConsent(settings.outboundConsent)
  }
  // 在线路径：撤权立刻 abort 在途（D24），授权后重新唤醒等待中的命名 / 确认任务
  if (!settings.outboundConsent) themeOnlineRuntime?.pauseEgress()
  else themeOnlineRuntime?.resumeEgress()
  themeOnlineRuntime?.reconfigure()
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
  void runGraphBackfill({
    db,
    modelDir: resolveModelDir(),
    log: captureLog,
    ...createEmbedderFactory()
  })
}

/**
 * 用户改了相似度阈值 / 连线数后按新阈值重算连线（设置抽屉保存后由渲染层显式触发）。
 * - 不做 60s 节流：这是显式动作；但同一时间只允许一次回填（在途返回 `busy`）；
 * - 模型未就绪时不报错：只回填结构，`embeddings: false` 让渲染层如实提示「没重算连线」；
 * - A3 红线同 `runGraphBackfillInBackground`：没建过库不因为一次重算就建库。
 */
async function recomputeGraph(): Promise<GraphRecomputeResult> {
  if (shuttingDown || !existsSync(dbPath)) return { ok: false, reason: 'unavailable' }
  let db: Db
  try {
    db = connections.ensureWritable().db
  } catch (error) {
    captureLog('warn', 'graph recompute: database unavailable', {
      error: error instanceof Error ? error.name : 'unknown'
    })
    return { ok: false, reason: 'unavailable' }
  }
  const result = await runGraphBackfill({
    db,
    modelDir: resolveModelDir(),
    log: captureLog,
    minIntervalMs: 0,
    ...createEmbedderFactory()
  })
  if (result.status === 'skipped') {
    return { ok: false, reason: result.reason === 'busy' ? 'busy' : 'unavailable' }
  }
  return {
    ok: true,
    edges: result.theme?.structure.edges?.inserted ?? 0,
    merges: result.theme?.merges?.applied ?? 0,
    embeddings: result.theme !== null
  }
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

/**
 * 证据图 → data URL（渲染层是 sandbox，读不了文件）。
 * 读不到 / 超过 4MB 就返回 null，界面只是少一张图，不影响回答。
 */
function readShotDataUrl(path: string): string | null {
  try {
    if (statSync(path).size > 4 * 1024 * 1024) return null
    const mime = extname(path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`
  } catch {
    return null
  }
}

/** 问记忆窗口（S3-lite）：懒创建、关闭即销毁；打开即视为一次交互 */
function showAskWindow(): void {  if (!app.isReady()) return
  if (askWindow && !askWindow.isDestroyed()) {
    if (askWindow.isMinimized()) askWindow.restore()
    askWindow.show()
    askWindow.focus()
    return
  }
  askWindow = createAskWindow({
    devServerUrl: process.env['ELECTRON_RENDERER_URL'],
    htmlPath: join(__dirname, '../renderer/ask/ask.html'),
    preloadPath: join(__dirname, '../preload/ask.js'),
    onClosed: () => {
      askWindow = null
    }
  })
}

function openAsk(): void {
  cancelStartupResume(true)
  showAskWindow()
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
  disposeAskIpc?.()
  inductionRuntime?.dispose()
  inductionRuntime = null
  momentRuntime?.stop()
  momentRuntime = null
  themeOnlineRuntime?.dispose()
  themeOnlineRuntime = null
  // 退出前等 stop 收口（在途 OCR 丢弃、stats 落盘、流释放）；3s 超时后放弃并强退。
  // 用 before-quit + preventDefault：will-quit 阶段再拦会被 Electron 当成 quit 已在进行。
  event.preventDefault()
  void (async () => {
    try {
      await withTimeout(controller.stop(), 3_000, '采集停止超时（3s）')
    } catch (error) {
      console.warn(`[gotcha] 退出时停止采集失败：${String(error)}`)
    }
    // 信息链：停源 + 收口最后一段 + 等在途截图落库（截图是异步抓的，不等就会丢最后一张）
    try {
      const stopping = chainRecording?.stop()
      if (stopping) await withTimeout(stopping, 2_000, '信息链收口超时（2s）')
      chainRecording = null
    } catch (error) {
      console.warn(`[gotcha] 退出时信息链收口失败：${String(error)}`)
    }
    connections.closeAll()
    trayShell?.dispose()
    if (fakeCapture || fakeLlm || fakeEmbedding) globalThis.__gotchaTest = undefined
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

/** PowerShell 脚本资源路径（打包后在 `resources/<dir>`，开发态在仓库 `resources/<dir>`） */
function scriptResourcePath(dir: string, file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, dir, file)
    : join(app.getAppPath(), 'resources', dir, file)
}

/** 采集会话装配（仅 --capture / GOTCHA_CAPTURE=1 或显式开启时进入；默认暂停时连库都不开） */
function createSession(): Promise<CaptureSession> {
  ensureLog()
  const userDataDir = app.getPath('userData')
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  const captureHtmlPath = join(__dirname, '../renderer/capture.html')
  const ocrScript = scriptResourcePath('ocr', 'winrt-ocr.ps1')

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

/**
 * 保留期重编码（D44）：同一个 nativeImage 编码器，按档位缩放 + 质量 */
function encodeRetentionImage(input: Buffer, encoding: RetentionEncoding): EncodedImage {
  const image = nativeImage.createFromBuffer(input)
  if (image.isEmpty()) throw new Error('证据图解码失败')
  const size = image.getSize()
  const scaled =
    encoding.maxWidth !== null && size.width > encoding.maxWidth
      ? image.resize({ width: encoding.maxWidth, quality: 'good' })
      : image
  const finalSize = scaled.getSize()
  return { bytes: scaled.toJPEG(encoding.quality), width: finalSize.width, height: finalSize.height }
}

/**
 * 信息链接线（D42）。三条口径：
 * 1. **跟采集总开关同一处**：不另做开关，隐私红线只有一处（Alt+P / 托盘 / `--capture`）。
 * 2. **原生源加载不出来就不采集**：如实记 warn，不建表、不假装在记（D41 降级纪律）。
 * 3. **假采集路径不碰真实钩子**：E2E 用假采集，这里直接不接线（否则测试会装全局钩子）。
 */
function ensureChainRecording(): ChainRecordingHandle | null {
  if (chainRecording) return chainRecording
  if (fakeCapture) return null
  let db: Db
  try {
    db = connections.ensureWritable().db
  } catch (error) {
    captureLog('warn', 'chain recording skipped: write db unavailable', { error: String(error) })
    return null
  }
  const source = loadChainEventSource({
    repoRoot: app.getAppPath(),
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    log: captureLog
  })
  chainRecording = createChainRecording({
    db,
    source,
    screen: screenCapture ?? undefined,
    userDataDir: app.getPath('userData'),
    log: captureLog,
    // 内容来源（D43）：UIA 优先、OCR 兜底。脚本缺失 / 工作器起不来都会降级成「留空」，不会崩
    content: {
      uiaScript: scriptResourcePath('chain', 'uia-text.ps1'),
      ocrScript: scriptResourcePath('ocr', 'winrt-ocr.ps1')
    },
    // 保留期分层（D44）：老证据重编码 / 打包；参数见 chain/retention.ts 的实测表
    retention: { encode: encodeRetentionImage },
    // 派生层（v0.8 / D45）：向量本地算；标签 / 双链走同一份出网确认门（D24）与每日预算（D22）
    derive: {
      resolveClient,
      readConsent: () => {
        const db = connections.queryDb()
        return db ? getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1' : false
      },
      loadEmbedder: loadChainEmbedder
    }
  })
  return chainRecording
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
    // 时刻在线补跑只跟采集状态走：暂停 / 停止时没有新事件，停掉定时器不空转
    if (!shuttingDown) {
      if (status === 'running') {
        ensureMomentRuntime()?.start()
        ensureThemeOnlineRuntime()?.start()
        // 信息链跟着采集开：新方向的事件源（D42）
        ensureChainRecording()?.start()
      } else if (status === 'paused' || status === 'stopping') {
        momentRuntime?.stop()
        themeOnlineRuntime?.pause()
        // 收口开着的段并等在途截图落库（不 await：状态回调是同步的，退出流程会再确认一次）
        void chainRecording?.stop()
      }
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

/**
 * 测试钩子：只在假采集 / 假 LLM / 假向量（临时 userData + 非打包）下挂到主进程 globalThis。
 * 任何一条注入都意味着「这是测试进程」，钩子不额外放宽业务约束（`toggle()` 走同一个入口）。
 */
interface GotchaTestHook {
  toggle(): Promise<void>
  status(): string
  notice(notice: unknown): void
  /** D20：全局热键无法用合成按键触发，E2E 走同一入口 */
  openGraph(): void
  openTimeline(): void
  /** 假 LLM 请求计数（断言暂停后零新增请求 / 零真实网络） */
  fakeLlm(): { requests: number; aborted: number } | null
  /**
   * 在线归属跑一轮（S7 E2E）：60s 定时器对用例太慢，这里直接走 `runOnce()`。
   * 采集没跑 / 暂停 / 销毁时返回 `skipped`，不绕过 D18（暂停仍零出网）。
   */
  onlineTick(): Promise<OnlineTickResult | null>
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
    onlineTick: () => {
      const runtime = ensureThemeOnlineRuntime()
      return runtime ? runtime.runOnce() : Promise.resolve(null)
    },
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
    installCrashLogging()
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

    // 问记忆（S3-lite）：只读链库 + 出云确认门（D24）+ 日账（D22）
    // 对话记录：显式提问 / 清空才写盘（A3 口径不变），文件在 userData 下
    const askHistoryPath = join(app.getPath('userData'), ASK_HISTORY_FILE)
    const askConsentView = (): AskConsentView => {
      const db = connections.queryDb()
      const consented = db ? getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1' : false
      const resolved = resolveClient()
      return resolved.ok
        ? { consented, clientReady: true }
        : { consented, clientReady: false, clientReason: resolved.reason }
    }
    disposeAskIpc = registerAskIpc({
      getWindow: () => askWindow,
      ask: async (question) => {
        const db = connections.queryDb()
        // A3 红线：没有库（从未采集）就不建库；时间轴上本来也没东西可找
        if (!db) {
          return {
            kind: 'no-evidence',
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: question.length }
          }
        }
        return askChain(
          {
            db,
            resolveClient,
            embedQuestion: async (text) => {
              const embedder = await loadChainEmbedder()
              if (!embedder) return null
              const [vector] = await embedder.embed([text])
              return vector ?? null
            },
            canSend: () => getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1',
            overBudget: () => {
              const budget = getNumberSetting(db, GRAPH_SETTING_KEYS.budgetTokensPerDay, 1_000_000)
              if (budget <= 0) return false
              const usage = readUsage(db, Date.now())
              return usage.promptTokens + usage.completionTokens >= budget
            },
            onUsage: (usage) => {
              try {
                // 显式提问是用户动作：允许打开写连接记账（D22 日账）
                const writable = connections.ensureWritable().db
                recordUsage(writable, Date.now(), {
                  calls: 1,
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens
                })
              } catch (error) {
                captureLog('warn', 'ask usage record failed', { error: String(error) })
              }
            },
            log: (level, message, data) => captureLog(level, message, data)
          },
          question
        )
      },
      segment: (segmentId) => {
        const db = connections.queryDb()
        return db ? readSegmentEvidence(db, segmentId, { readShot: readShotDataUrl }) : null
      },
      consent: askConsentView,
      setConsent: (consented) => {
        const writable = connections.ensureWritable().db
        setSetting(writable, GRAPH_SETTING_KEYS.outboundConsent, consented ? '1' : '0')
        return askConsentView()
      },
      record: (question, result) => {
        appendAskHistory(askHistoryPath, toHistoryEntry(question, result, Date.now()))
      },
      history: () => readAskHistory(askHistoryPath),
      clearHistory: () => clearAskHistory(askHistoryPath),
      log: (level, message, data) => captureLog(level, message, data)
    })

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
      setConsent: (consented) => {
        ensureInductionRuntime().setConsent(consented)
        // 在线路径有独立队列：撤权要立刻 abort 在途，授权后唤醒等待中的任务
        if (consented) themeOnlineRuntime?.resumeEgress()
        else themeOnlineRuntime?.pauseEgress()
      },
      readSettings: () => readGraphSettings(connections.queryDb()),
      saveSettings: (patch) => {
        // 显式 UI 动作：允许打开写连接（默认暂停仍不建库）
        const db = connections.ensureWritable().db
        return saveGraphSettings(db, patch)
      },
      onSettingsSaved: applyGraphSettings,
      recomputeGraph,
      listMerges: () => {
        // 只读查询：没建过库就没有合并记录，且不能因为「打开抽屉」建库（A3）
        const db = connections.queryDb()
        return db ? listThemeMerges(db) : []
      },
      revertMerge: (groupId) => {
        // A3：从未建库时不存在可撤销的合并
        if (!existsSync(dbPath)) return { ok: false, reason: 'not-found' }
        const db = connections.ensureWritable().db
        const result = revertThemeMerge(db, groupId)
        if (result.ok) {
          captureLog('info', 'graph merge reverted', { groupId, restored: result.from.length })
        }
        return result
      },
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
      openAsk,
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
        openAsk,
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

    if (fakeCapture || fakeLlm || fakeEmbedding) installTestHook()

    registerGlobalHotkeys()

    // Q1=B：只有上次显式开启（resume_on_start=1）才延迟 3s 自动恢复，且可被任意交互取消
    if (!launchCapture && readResumeOnStart()) scheduleStartupResume()
  })
}
