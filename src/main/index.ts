import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import Database from 'better-sqlite3'
import log from 'electron-log/main'
import { DB_FILE_NAME, openDatabase, queryTimeline, type Db } from '../db'
import { getNumberSetting, getSetting, setSetting } from '../db/settings'
import { previewMemoryProfile, readMemoryDay, recallMemory, syncVault } from '../memory/store'
import { indexDiaryVectors, countPendingVectors, pruneOrphanVectors } from '../memory/vectors'
import { buildPersonaPrompt, readPersona, resolveVaultDir } from '../memory/persona'
import {
  applyMemoryPatch,
  buildMemorySettingsView,
  parseMemoryPatch,
  type MemorySettingsSaveResult
} from './memory-settings'
import { buildMemoryListView, deleteMemoryView, parseMemoryListQuery, restoreMemoryView } from './memory-admin'
import type { DiaryToolDeps } from '../chain/agent/tools'
import { readUsage, recordUsage } from '../understand/induction'
import { WinrtOcrBridge } from '../capture/ocr/winrt-bridge'
import { ScreenCapture } from '../capture/screen-stream'
import { selectionToFrameCrop } from '../capture/full-frame'
import {
  isAskShotPath,
  pruneAskShots,
  readAskShotDataUrl,
  saveAskShot
} from './ask-shot'
import { cropFrameToPng } from './ask-crop'
import { openAskPopup } from './ask-popup'
import { displayUnderCursor, pickRegion } from './region-picker'
import {
  frameMatchesDisplay,
  getScreenGrab,
  loadScreenGrabOnce,
  parseGrabbedFrame,
  REGION_GRAB_TIMEOUT_MS,
  type ScreenGrabBinding
} from './screen-grab'
import { getActiveWindow, isBlacklisted } from '../capture/window-meta'
import {
  CHAIN_FRAME_FILE_PATTERN,
  cleanStaleFrames,
  createTempJanitor,
  OCR_FILE_PATTERN,
  type TempCleanupResult,
  type TempJanitor
} from '../capture/temp-store'
import {
  emptyGlobalGraph,
  queryGlobalGraph,
  queryGraphDay,
  queryMomentEvents,
  queryMomentSummary,
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
import { createCloudAskOutbound } from '../understand/cloud/ask-outbound'
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
import { askChain, type ChainAskOptions } from '../chain/agent/ask'
import type { AskRecentSegment } from '../chain/agent/payload'
import type { ChainDb } from '../chain/store'
import { querySegments } from '../chain/store'
import { ensureChainSchema } from '../chain/schema'
import {
  searchChainSegmentsBatch,
  type ChainSearchBatchQuery,
  type ChainSearchBatchResult
} from '../chain/query'
import { readSegmentEvidence } from '../chain/agent/evidence'
import {
  BACKFILL_EMBEDDER_OPTIONS,
  loadSharedEmbedder,
  runGraphBackfill
} from './graph-backfill-runtime'
import { createEmbeddingHost } from './embedding-host'
import { createSearchHost } from './search-host'
import { createSearchMetricsStore } from './search-metrics'
import { createMomentRuntime, type MomentRuntime } from './moment-runtime'
import {
  createThemeOnlineRuntime,
  type OnlineTickResult,
  type ThemeOnlineRuntime
} from './theme-online-runtime'
import { embeddingModelCandidates, pickEmbeddingModelDir } from '../understand/embedding/paths'
import { EMBEDDING_MODEL_NAME, type Embedder } from '../understand/embedding/types'
import { isModelReady } from '../understand/embedding/session'
import {
  registerGraphIpc,
  type GraphChangedEvent,
  type GraphRecomputeResult,
  type ProviderKeySaveResult
} from './graph-ipc'
import { registerAskIpc, type AskConsentView, type AskQueryContext } from './ask-ipc'
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
import { createBallMenu, type BallMenuShell } from './ball-menu'
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
let ballMenuShell: BallMenuShell | null = null
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

/** 启动清理上次崩溃 / 删除失败留下的临时帧（F06 + 性能方案 P0-4） */
function cleanTempFramesOnStartup(): void {
  const userDataDir = app.getPath('userData')
  const cleaned: TempCleanupResult = cleanStaleFrames(join(userDataDir, 'tmp'))
  // tmp-chain 是证据图 / OCR 的中转目录：以前清理只认 tmp/frame-*.png，
  // 这里 129 个孤立 ocr-*.png（495 MB）从来没被删过。留 1h 安全边际：
  // 启动清理发生在起流之前，正常流程的临时帧几分钟内就会 rename / 删除，
  // 留下来的都是残留；1h 既能回收当天的，也不会和刚崩溃进程的收尾抢文件。
  const chain = cleanStaleFrames(join(userDataDir, 'tmp-chain'), {
    patterns: [CHAIN_FRAME_FILE_PATTERN, OCR_FILE_PATTERN],
    olderThanMs: 60 * 60 * 1000
  })
  const total = {
    removed: cleaned.removed + chain.removed,
    failed: cleaned.failed + chain.failed,
    chain_removed: chain.removed
  }
  if (total.removed === 0 && total.failed === 0) return
  captureLog(total.failed > 0 ? 'warn' : 'info', 'temp frames cleaned on startup', total)
}

/** tmp-chain 周期清理：长会话（几天不重启）里删除失败的 OCR 中转图不会一直堆着 */
const TEMP_JANITOR_INTERVAL_MS = 10 * 60 * 1000
/** 15 分钟足够覆盖一次在途 OCR 读（秒级）；比启动清理的 1h 更积极，稳态不超一小时 */
const TEMP_CHAIN_OCR_MAX_AGE_MS = 15 * 60 * 1000
const TEMP_CHAIN_FRAME_MAX_AGE_MS = 60 * 60 * 1000

let tempJanitor: TempJanitor | null = null

function startTempJanitor(): void {
  if (tempJanitor) return
  const chainDir = join(app.getPath('userData'), 'tmp-chain')
  tempJanitor = createTempJanitor({
    intervalMs: TEMP_JANITOR_INTERVAL_MS,
    targets: [
      { dir: chainDir, patterns: [OCR_FILE_PATTERN], olderThanMs: TEMP_CHAIN_OCR_MAX_AGE_MS },
      { dir: chainDir, patterns: [CHAIN_FRAME_FILE_PATTERN], olderThanMs: TEMP_CHAIN_FRAME_MAX_AGE_MS }
    ],
    log: (level, message, data) => captureLog(level, message, data)
  })
  tempJanitor.start()
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
 * 向量推理宿主（P1-4）：`onnxruntime` 会话跑在 `utilityProcess` 里，主进程只收发消息。
 * 懒创建：第一次真要算向量时才 fork（`utilityProcess.fork` 要求 app ready）。
 */
let embeddingHost: ReturnType<typeof createEmbeddingHost> | null = null
function getEmbeddingHost(): ReturnType<typeof createEmbeddingHost> {
  if (!embeddingHost) {
    embeddingHost = createEmbeddingHost({ log: captureLog })
  }
  return embeddingHost
}

/**
 * 检索工作进程（性能方案 §5.11）：`search_info` 的 LIKE 全扫在 40 MB 正文上要 1 s+，
 * 放主进程里会把球 / 热键 / 窗口 IPC 一起卡住。懒创建，形态同向量宿主。
 */
let searchHost: ReturnType<typeof createSearchHost> | null = null
function getSearchHost(): ReturnType<typeof createSearchHost> {
  if (!searchHost) {
    searchHost = createSearchHost({ dbPath, log: captureLog })
  }
  return searchHost
}

/**
 * 检索耗时常驻指标（性能方案 §5.9 第 6 条，也是 §5.11 的复评门槛）：
 * 按日累计关键词路的次数 / 命中数 / 耗时分布（`stats.search.day.<yyyy-mm-dd>`）。
 * 写失败只记一条 warn —— 指标坏了不能影响「问记忆」。
 */
let searchMetricsStore: ReturnType<typeof createSearchMetricsStore> | null = null
function getSearchMetricsStore(): ReturnType<typeof createSearchMetricsStore> {
  if (!searchMetricsStore) {
    searchMetricsStore = createSearchMetricsStore({
      read: (key) => {
        const db = connections.queryDb()
        return db ? getSetting(db, key) : null
      },
      write: (key, value) => {
        const writable = connections.ensureWritable()
        setSetting(writable.db, key, value)
      }
    })
  }
  return searchMetricsStore
}

function recordSearchSample(sample: {
  ms: number
  hits: number
  ok: boolean
  fallback?: boolean
}): void {
  try {
    getSearchMetricsStore().record(sample)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    captureLog('warn', 'search metrics failed', {
      error: message.length > 200 ? `${message.slice(0, 200)}…` : message
    })
  }
}

/** 每路命中条数之和（指标口径：一次检索给模型看了多少条） */
function countHitsPerText(result: ChainSearchBatchResult): number {
  return result.hitsPerText.reduce((sum, hits) => sum + hits.length, 0)
}

/**
 * 工具循环里的 `search_info` 走这里：worker 正常时结果与进程内完全一致（同一份 SQL）；
 * worker 起不来 / 超时 / 崩了就退回主线程查（宁可卡一下，也别让「问记忆」答不出来）。
 */
async function runSearchBatch(query: ChainSearchBatchQuery): Promise<ChainSearchBatchResult> {
  const startedAt = Date.now()
  try {
    const result = await getSearchHost().search(query)
    recordSearchSample({ ms: Date.now() - startedAt, hits: countHitsPerText(result), ok: true })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    captureLog('warn', 'search worker failed, fallback to main thread', {
      error: message.length > 200 ? `${message.slice(0, 200)}…` : message
    })
    const db = connections.queryDb()
    if (!db) {
      recordSearchSample({ ms: Date.now() - startedAt, hits: 0, ok: false, fallback: true })
      throw error
    }
    try {
      const result = searchChainSegmentsBatch(db, query)
      recordSearchSample({
        ms: Date.now() - startedAt,
        hits: countHitsPerText(result),
        ok: true,
        fallback: true
      })
      return result
    } catch (fallbackError) {
      recordSearchSample({ ms: Date.now() - startedAt, hits: 0, ok: false, fallback: true })
      throw fallbackError
    }
  }
}

/**
 * 图谱回填 / 在线归属共用的 embedder 入口。
 * E2E 注入假向量时直接返回假实现（不加载 95 MB 模型）；正常路径走 utilityProcess 里的真模型会话
 * （256 token / 批 1，见 `BACKFILL_EMBEDDER_OPTIONS`）。模型缺失时这里会 throw，调用方按老口径降级。
 */
function loadGraphEmbedder(): Promise<Embedder | null> {
  if (fakeEmbeddingBundle) return Promise.resolve(fakeEmbeddingBundle.embedder)
  return loadSharedEmbedder(resolveModelDir(), {
    log: captureLog,
    ...createEmbedderFactory()
  })
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
    chainEmbedder = Promise.resolve().then(() =>
      getEmbeddingHost().getEmbedder({
        key: 'chain',
        modelDir: resolveModelDir(),
        maxLength: 512,
        batchSize: 1,
        intraOpNumThreads: 4
      })
    ).catch((error: unknown) => {
      captureLog('warn', 'chain embedder unavailable', {
        error: error instanceof Error ? error.name : 'unknown'
      })
      chainEmbedder = null
      return null
    })
  }
  return chainEmbedder
}

/**
 * 回填 / 归属用的 embedder 工厂：
 * - 假向量注入时直接给假实现；
 * - 正常路径指向 utilityProcess 宿主（图谱 profile：256 token / 批 1 / 4 线程）。
 *   模型缺失时 `getEmbedder` 抛 `model-missing`，`runGraphBackfill` 会降级成只回填结构。
 */
function createEmbedderFactory(): { createEmbedder?: (modelDir: string) => Promise<Embedder> } {
  if (fakeEmbeddingBundle) {
    const embedder = fakeEmbeddingBundle.embedder
    return { createEmbedder: async () => embedder }
  }
  return {
    createEmbedder: async (modelDir: string) =>
      getEmbeddingHost().getEmbedder({
        key: 'graph',
        modelDir,
        ...BACKFILL_EMBEDDER_OPTIONS
      })
  }
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
  if (!db) return { toggleCapture: DEFAULT_HOTKEYS.toggleCapture }
  return {
    // D51：图谱入口摘除后不再注册 openGraph，Alt+Space 归还系统
    toggleCapture:
      getSetting(db, HOTKEY_SETTING_KEYS.toggleCapture).trim() || DEFAULT_HOTKEYS.toggleCapture
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
      }
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

/** 选区问答的交接单：一条问题 + 一张已经落盘的截图（问记忆窗口据此自动开问） */
interface AskPrefill {
  question: string
  imagePath: string
}

/** 窗口还在加载就先等 did-finish-load，否则渲染层收不到这条消息 */
function sendToAskWindow(window: BrowserWindow, payload: AskPrefill): void {
  const deliver = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('ask:prefill', payload)
  }
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', deliver)
  else deliver()
}

/** 「设置」入口（托盘 / 球右键）：打开问记忆并展开设置抽屉 */
function sendAskSettings(window: BrowserWindow): void {
  const deliver = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('ask:open-settings')
  }
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', deliver)
  else deliver()
}

interface AskOpenOptions {
  prefill?: AskPrefill
  /** 打开就展开设置抽屉（D53） */
  settings?: boolean
}

/** 问记忆窗口（S3-lite）：懒创建、关闭即销毁；打开即视为一次交互 */
function showAskWindow(options: AskOpenOptions = {}): void {
  if (!app.isReady()) return
  if (askWindow && !askWindow.isDestroyed()) {
    if (askWindow.isMinimized()) askWindow.restore()
    askWindow.show()
    askWindow.focus()
    if (options.prefill) sendToAskWindow(askWindow, options.prefill)
    if (options.settings) sendAskSettings(askWindow)
    return
  }
  const window = createAskWindow({
    devServerUrl: process.env['ELECTRON_RENDERER_URL'],
    htmlPath: join(__dirname, '../renderer/ask/ask.html'),
    preloadPath: join(__dirname, '../preload/ask.js'),
    onClosed: () => {
      askWindow = null
    }
  })
  askWindow = window
  if (options.prefill) sendToAskWindow(window, options.prefill)
  if (options.settings) sendAskSettings(window)
}

function openAsk(options: AskOpenOptions = {}): void {
  cancelStartupResume(true)
  showAskWindow(options)
}

/** 选区问答在跑：连点球不会叠出两层遮罩 / 两个输入框 */
let regionBusy = false

interface RegionFrame {
  image: Uint8Array
  width: number
  height: number
  source: 'wgc' | 'stream'
}

/**
 * 选区问答要的那一帧：优先系统级 WGC（一帧即建即拆，不碰常驻流），
 * 没编译 / 抓失败 / 尺寸对不上就退回 Chromium 屏幕流；两边都失败返回 null。
 *
 * 为什么优先 WGC：它是系统合成器直接给帧（Windows 自带截图用的同一条路），
 * 不用先起隐藏窗口的录屏流，暂停采集时也能拍。退回的那条路是旧实现，保留作兜底。
 */
async function captureRegionFrame(display: Electron.Display): Promise<RegionFrame | null> {
  const grab = fakeCapture ? null : getScreenGrab()
  if (grab) {
    const started = Date.now()
    try {
      // WGC / MonitorFromPoint 只认物理像素：DIP 先换算，跨屏 125% 才不会拍到隔壁
      const point = screen.dipToScreenPoint({
        x: display.bounds.x + display.bounds.width / 2,
        y: display.bounds.y + display.bounds.height / 2
      })
      const frame = parseGrabbedFrame(grab.grabMonitor(point.x, point.y, REGION_GRAB_TIMEOUT_MS))
      if (frame && frameMatchesDisplay(frame, display)) {
        captureLog('info', 'region frame captured', {
          source: 'wgc',
          ms: Date.now() - started,
          width: frame.width,
          height: frame.height,
          bytes: frame.jpeg.byteLength,
          borderSuppressed: frame.borderSuppressed
        })
        return { image: frame.jpeg, width: frame.width, height: frame.height, source: 'wgc' }
      }
      captureLog('warn', 'region native frame unusable', {
        frame: frame ? { width: frame.width, height: frame.height } : null,
        display: { width: display.bounds.width, height: display.bounds.height },
        scaleFactor: display.scaleFactor
      })
    } catch (error) {
      captureLog('warn', 'region native grab failed', { error: String(error) })
    }
  }
  if (!screenCapture) return null
  const started = Date.now()
  const frame = await screenCapture.captureDisplay(display.id, { format: 'jpeg' })
  captureLog('info', 'region frame captured', {
    source: 'stream',
    ms: Date.now() - started,
    width: frame.width,
    height: frame.height,
    bytes: frame.image.byteLength
  })
  return { image: frame.image, width: frame.width, height: frame.height, source: 'stream' }
}

/** 空闲时预热原生抓帧（只建设备 / item，不读像素）：首次 D3D 初始化 ~250ms，别让第一次点球等它 */
function warmupScreenGrab(grab: ScreenGrabBinding): void {
  try {
    const display = screen.getPrimaryDisplay()
    const point = screen.dipToScreenPoint({
      x: display.bounds.x + display.bounds.width / 2,
      y: display.bounds.y + display.bounds.height / 2
    })
    const ready = grab.warmup(point.x, point.y)
    captureLog(ready ? 'info' : 'warn', 'screen grab warmed', { ready })
  } catch (error) {
    captureLog('warn', 'screen grab warmup failed', { error: String(error) })
  }
}

/**
 * 段二：选区问答整条链
 * 截整屏一帧（系统级 WGC，失败退回采集那条常驻流）→ 遮罩选区 → 按选区裁剪 → 留存 →
 * 中下方浮动输入框 → 问记忆。
 * 任何一步失败都只记 warn：这是辅助入口，不能因为它把球搞挂。
 */
async function openRegionAsk(): Promise<void> {
  if (regionBusy || !screenCapture) return
  regionBusy = true
  const userData = app.getPath('userData')
  try {
    const display = displayUnderCursor()
    // 先把当前屏抓一帧当「裁图源」；遮罩本身是透明叠在活屏上的（不铺这张图），
    // 所以裁出来的就是用户框选那一刻之前的那一帧。JPEG 只是省内存，裁完仍存 PNG。
    const frame = await captureRegionFrame(display)
    if (!frame) return
    const picked = await pickRegion({
      devServerUrl: process.env['ELECTRON_RENDERER_URL'],
      htmlPath: join(__dirname, '../renderer/region/index.html'),
      preloadPath: join(__dirname, '../preload/region.js'),
      display,
      log: (level, message, data) => captureLog(level, message, data)
    })
    if (!picked) return
    const crop = selectionToFrameCrop(
      picked.rect,
      { width: display.bounds.width, height: display.bounds.height },
      { width: frame.width, height: frame.height }
    )
    if (!crop) return
    const png = cropFrameToPng(frame.image, crop)
    if (!png) return
    const imagePath = saveAskShot(userData, png, Date.now())
    const thumb = readAskShotDataUrl(imagePath)
    if (!thumb) return
    openAskPopup({
      devServerUrl: process.env['ELECTRON_RENDERER_URL'],
      htmlPath: join(__dirname, '../renderer/ask-popup/index.html'),
      preloadPath: join(__dirname, '../preload/ask-popup.js'),
      imageDataUrl: thumb,
      display,
      onSend: (question) => {
        cancelStartupResume(true)
        showAskWindow({ prefill: { question, imagePath } })
      }
    })
  } catch (error) {
    captureLog('warn', 'region ask failed', { error: String(error) })
  } finally {
    regionBusy = false
  }
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
  tempJanitor?.stop()
  tempJanitor = null
  disposeGraphIpc?.()
  disposeAskIpc?.()
  ballMenuShell?.dispose()
  ballMenuShell = null
  inductionRuntime?.dispose()
  inductionRuntime = null
  momentRuntime?.stop()
  momentRuntime = null
  themeOnlineRuntime?.dispose()
  themeOnlineRuntime = null
  // 向量工作进程：退出前杀掉，别留孤儿进程（在途推理直接失败，不影响收口）
  embeddingHost?.dispose()
  embeddingHost = null
  searchHost?.dispose()
  searchHost = null
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
  // P0-2 第一阶段：信息链正文镜像成 events 行（默认开，capture.events_mirror=0 可关）。
  // 每次起采集读一次（暂停 / 开始即生效）；先双写、后切读，等时间线 / 时刻 / 主题的覆盖对得上再降级。
  chainRecording = createChainRecording({
    db,
    source,
    screen: screenCapture ?? undefined,
    userDataDir: app.getPath('userData'),
    log: captureLog,
    eventsMirror: { enabled: () => getSetting(db, 'capture.events_mirror') === '1' },
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
    // D51：图谱与时间线入口摘除后，归纳调度与在线归属（唯一会出云的旧路径）不再随采集启动；
    // 代码与数据保留，重做画布时再决定怎么接。
    // 时刻在线补跑只跟采集状态走：暂停 / 停止时没有新事件，停掉定时器不空转
    if (!shuttingDown) {
      if (status === 'running') {
        ensureMomentRuntime()?.start()
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

/** 检索探针回包：只带计数与首条段 id（没有正文、没有标题） */
interface SearchProbeResult {
  ok: boolean
  elapsedMs: number
  /** 每个关键词一路的命中条数（顺序与入参对齐） */
  hits: number[]
  topSegmentId: number | null
  /** 失败时的截断消息（最多 200 字，日志红线同款） */
  error?: string
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
   * 检索探针（§5.13 真机校验）：直接走生产那条 `runSearchBatch()`——
   * 即 `utilityProcess` 里的 LIKE 全扫，坏了才退回主线程。只回每路命中数与首条段 id：
   * 日志红线不打印正文，钩子也不往外递正文。
   */
  searchProbe(texts: string[], limit?: number): Promise<SearchProbeResult>
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
    searchProbe: async (texts, limit = 5) => {
      const started = Date.now()
      const query: ChainSearchBatchQuery = {
        texts: texts.slice(0, 16).map((text) => text.slice(0, 200)),
        limit: Math.min(Math.max(1, Math.trunc(limit)), 200),
        includeOpen: true
      }
      try {
        const result = await runSearchBatch(query)
        return {
          ok: true,
          elapsedMs: Date.now() - started,
          hits: result.hitsPerText.map((hits) => hits.length),
          topSegmentId: result.hitsPerText[0]?.[0]?.segment.id ?? null
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          elapsedMs: Date.now() - started,
          hits: [],
          topSegmentId: null,
          error: message.length > 200 ? `${message.slice(0, 200)}…` : message
        }
      }
    },
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
// D51：时间线窗口不再有界面入口，二次启动改为打开「问记忆」（剩下的唯一主窗口）
const primaryInstance = claimSingleInstance(app, () => {
  openAsk()
})

if (primaryInstance) {
  app.whenReady().then(async () => {
    installCrashLogging()
    cleanTempFramesOnStartup()
    startTempJanitor()
    // 选区问答的截图随对话留存 30 天：启动时按年龄清一轮（读不到图的历史条目界面如实降级）
    try {
      pruneAskShots(app.getPath('userData'))
    } catch (error) {
      captureLog('warn', 'ask shots prune failed', { error: String(error) })
    }
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

    // 选区截图的系统级抓帧（Windows.Graphics.Capture）：只加载一次；没编译就退回屏幕流。
    // 预热放在 1.5s 后，别和启动抢主线程。
    if (!fakeCapture) {
      const screenGrab = loadScreenGrabOnce(
        app.getAppPath(),
        app.isPackaged ? process.resourcesPath : undefined
      )
      if (screenGrab) {
        setTimeout(() => warmupScreenGrab(screenGrab), 1500)
      } else {
        captureLog('warn', 'screen grab native module missing (region ask falls back to stream)')
      }
    }

    // 问记忆（S3-lite）：只读链库 + 出云确认门（D24）+ 日账（D22）
    // 对话记录：显式提问 / 清空才写盘（A3 口径不变），文件在 userData 下
    const askHistoryPath = join(app.getPath('userData'), ASK_HISTORY_FILE)
    /**
     * 日记增量同步（第二本账）。节流 60s：问一次记忆最多 stat 一遍日记目录。
     * 只有这里会开写连接（`mem_items` 是唯一写入点）；检索路径仍走只读连接。
     * 目录不存在（没配日记）就什么都不做——不为了一个没开的功能够建库。
     */
    let memorySyncedAt = 0
    const syncMemoryIfDue = (): void => {
      const now = Date.now()
      if (now - memorySyncedAt < 60_000) return
      const vaultDir = resolveVaultDir(connections.queryDb())
      if (vaultDir === null) return
      memorySyncedAt = now
      try {
        const { db: writable } = connections.ensureWritable()
        // 日记住进的是同一个 memory.db：顺手把信息链表建好（幂等）。
        // 否则「只开过日记、从没采集过」的库在问记忆时会缺 chain_segment（freshness / 检索都会炸）。
        ensureChainSchema(writable)
        const result = syncVault(writable, vaultDir)
        if (result.added > 0 || result.updated > 0 || result.removed > 0) {
          captureLog('info', 'memory sync', { dir: vaultDir, ...result })
        }
        // 每次同步后都排一次（没变化时只做一次指纹比对，不加载模型）：
        // 升级到 v10 后 `mem_vectors` 是空的，哪怕日记一个字没改也要补索引
        scheduleMemoryVectors()
      } catch (error) {
        captureLog('warn', 'memory sync failed', { dir: vaultDir, error: String(error) })
      }
    }
    /**
     * 个人记忆向量索引（`llm-call.md` §4 / D57）：**后台串行队列**，一次 200 条、算完再排下一档，
     * 不阻塞启动与同步。embedder 复用 chain profile（同一份 bge 模型；多开一个 ONNX 会话白占内存），
     * 模型缺失时 `loadChainEmbedder()` 返回 null，这里直接什么都不做（只关向量，不关记忆）。
     */
    let memoryVectorTimer: ReturnType<typeof setTimeout> | null = null
    let memoryVectorRunning = false
    /** 记忆功能在这一刻进入可用状态（首轮向量索引要避让启动那几十秒） */
    const memoryStartedAt = Date.now()
    const runMemoryVectorIndex = async (): Promise<void> => {
      if (memoryVectorRunning) return
      memoryVectorRunning = true
      try {
        const { db } = connections.ensureWritable()
        // 先清孤儿再判断要不要算：只查一次指纹，不用为「没有待索引」加载模型（模型加载要几秒）
        const pruned = pruneOrphanVectors(db)
        const pending = countPendingVectors(db, EMBEDDING_MODEL_NAME)
        if (pending === 0) {
          if (pruned > 0) captureLog('info', 'memory vectors pruned', { pruned })
          return
        }
        const embedder = await loadChainEmbedder()
        if (embedder === null) return
        let embedded = 0
        let remaining = pending
        // 小口吃：一次 50 条、最多 10 档（500 条），档与档之间让出 300ms ——
        // 真 bge 在 4 线程上跑，一次 200 条会把采集 / 聊天的 CPU 抢掉（2026-10-29 真机反馈「启动变慢」）。
        // 升级后首次全量 2 382 条大约分 5 次同步跑完，不再一口气占满。
        for (let round = 0; round < 10; round += 1) {
          const result = await indexDiaryVectors(db, embedder, { limit: 50 })
          embedded += result.embedded
          remaining = result.remaining
          if (result.embedded === 0 || result.remaining <= 0) break
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        captureLog('info', 'memory vectors indexed', { embedded, pruned, pending })
        // 还没补完（升级后首次要跑几轮）：60s 后再来一轮，别等下一次有人提问才继续
        if (remaining > 0) scheduleMemoryVectors(60_000)
      } catch (error) {
        captureLog('warn', 'memory vectors failed', { error: String(error) })
      } finally {
        memoryVectorRunning = false
      }
    }
    const scheduleMemoryVectors = (gapMs?: number): void => {
      if (memoryVectorTimer !== null) return
      // 启动后的第一轮压到 60s 之后：先让球、托盘、采集稳住，别在最需要响应的时候去算向量
      const delay =
        gapMs ?? Math.max(5_000, 60_000 - (Date.now() - memoryStartedAt))
      memoryVectorTimer = setTimeout(() => {
        memoryVectorTimer = null
        void runMemoryVectorIndex()
      }, delay)
    }
    /**
     * 个人记忆设置（日记目录 + 人设）：读 = 现读 settings；存 = 校验 → 落库 → **立即同步**。
     * 用户口径（2026-10-29）：没有单独的「重新同步」按钮，保存就同步。
     * 同步失败不回滚设置（目录本身已校验存在，失败通常是读文件 / 库问题），如实回错误。
     */
    const readMemorySettings = (): ReturnType<typeof buildMemorySettingsView> | { error: string } => {
      const db = connections.queryDb()
      // 从没建过库：不为了「看一眼设置」建库（A3），让界面显示不可用
      if (!db) return { error: 'db-unavailable' }
      return buildMemorySettingsView(db)
    }
    const saveMemorySettings = (patch: unknown): MemorySettingsSaveResult => {
      const parsed = parseMemoryPatch(patch)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      let db: Db
      try {
        db = connections.ensureWritable().db
      } catch (error) {
        captureLog('warn', 'memory settings save: db unavailable', { error: String(error) })
        return { ok: false, error: '数据库暂不可用，设置没有保存' }
      }
      try {
        ensureChainSchema(db)
        applyMemoryPatch(db, parsed.patch)
      } catch (error) {
        captureLog('error', 'memory settings save failed', { error: String(error) })
        return { ok: false, error: '保存设置失败' }
      }
      const view = buildMemorySettingsView(db)
      if (view.resolvedDir === null) return { ok: true, view, sync: null, syncedDir: null }
      try {
        const result = syncVault(db, view.resolvedDir)
        captureLog('info', 'memory sync', { dir: view.resolvedDir, ...result })
        // 保存设置 = 立即同步（用户口径）→ 顺手排向量索引（内部按指纹判断要不要真算）
        scheduleMemoryVectors()
        // 同步后统计会变（新增 / 删除），视图重读一次再回给界面
        return { ok: true, view: buildMemorySettingsView(db), sync: result, syncedDir: view.resolvedDir }
      } catch (error) {
        captureLog('warn', 'memory sync failed', {
          dir: view.resolvedDir,
          error: String(error)
        })
        return {
          ok: true,
          view,
          sync: null,
          syncedDir: view.resolvedDir,
          syncError: String(error)
        }
      }
    }
    const askConsentView = (): AskConsentView => {
      const db = connections.queryDb()
      const consented = db ? getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1' : false
      const resolved = resolveClient()
      return resolved.ok
        ? { consented, clientReady: true }
        : { consented, clientReady: false, clientReason: resolved.reason }
    }
    // 问记忆的依赖（提问与「继续查」共用一份：两边口径必须一致，否则续查会绕过脱敏 / 预算 / 记账）
    // 出云安全只在边界生效：核心拿到的只是一个载荷组装端口，不 import 脱敏实现。
    const askOutbound = createCloudAskOutbound()
    /**
     * 提问前最后一段证据（应用 / 标题 / 时刻）：给「这个界面 / 刚才那个」一个指代落点。
     * 取段库最新的那一段（含开着的）；app / 标题在载荷层过策略，命中阻断就整条不出云。
     */
    const latestSegmentHint = (db: ChainDb): AskRecentSegment | undefined => {
      const [row] = querySegments(db, { includeOpen: true, limit: 1 })
      if (!row) return undefined
      return {
        app: row.app ?? '',
        title: row.title_last ?? row.title_first ?? '',
        at: row.start_ts
      }
    }
    /**
     * 日记记忆（第二本账）给工具循环的实现：查询走当前连接（通常只读），
     * 只有同步（`syncMemoryIfDue`）会开写连接 —— 走过来问的记忆不该顺手改库。
     */
    const diaryToolsFor = (db: ChainDb): DiaryToolDeps => ({
      recall: (query) =>
        recallMemory(db, { ...query, now: Date.now() }).hits.map((hit) => ({
          itemId: hit.id,
          day: hit.day_key,
          section: hit.section,
          kind: hit.kind,
          text: hit.text,
          tags: hit.tags,
          refs: hit.refs,
          reasons: hit.reasons
        })),
      readDay: (day) => {
        const view = readMemoryDay(db, day)
        if (view === null) return null
        return {
          day,
          text: view.text,
          items: view.items.map((item) => ({ itemId: item.id, section: item.section, text: item.text }))
        }
      },
      profile: () => {
        const view = previewMemoryProfile(db)
        const stats = view.stats
        return {
          // 工具结果是送云的：这里只给几个数字与短字符串，不把整张统计表塞进去
          stats: {
            items: stats.items,
            days: stats.days,
            firstDay: stats.firstDay,
            lastDay: stats.lastDay,
            streakDays: stats.streakDays,
            tasksOpen: stats.tasks.open,
            tasksDone: stats.tasks.done,
            topTags: stats.topTags.slice(0, 5).map((tag) => `#${tag.tag}`).join(' '),
            topRefs: stats.topRefs.slice(0, 5).map((ref) => ref.ref).join(' '),
            note: '统计口径：按 mem_items 的条目 / 天数 / 待办勾选现算'
          },
          observations: view.observations
        }
      }
    })
    const askOptionsFor = (db: ChainDb, context: AskQueryContext): ChainAskOptions => ({
      db,
      resolveClient,
      outbound: askOutbound,
      embedQuestion: async (text) => {
        const embedder = await loadChainEmbedder()
        if (!embedder) return null
        const [vector] = await embedder.embed([text])
        return vector ?? null
      },
      // 工具循环注入：固定钟、采集运行态、问答历史（freshness / ask_history 工具的数据源）
      now: () => Date.now(),
      captureRunning: () => controller.status() === 'running',
      // ask_history 默认只查本会话（D55 ②）：以前把全库问答倒给模型，别的会话的问题会被写成
      // 「你刚才问的」。要跨会话必须显式 scope:"all"，每条带 session 标记。
      readAskHistory: (scope) => {
        const current = (entry: { conversationId?: string; id: string }): boolean =>
          (entry.conversationId ?? entry.id) === context.conversationId
        return readAskHistory(askHistoryPath)
          .filter((entry) => scope === 'all' || current(entry))
          .map((entry) => ({
            at: entry.at,
            question: entry.question,
            kind: entry.kind,
            session: (current(entry) ? 'current' : 'other') as 'current' | 'other'
          }))
      },
      // 指代线索：提问前最后一段（不是证据；引用仍要经 search_info / read_segment）
      recent: latestSegmentHint(db),
      searchBatch: runSearchBatch,
      // 个人记忆（第二本账）：日记条目 + 「关于我」统计；人设是本地配置，只拼在 system 最前面
      diary: diaryToolsFor(db),
      personaPrompt: buildPersonaPrompt(readPersona(db)),
      // 多轮对话：同一会话之前的几轮（主进程只从自己落盘的历史里筛，渲染层伪造不了）
      history: context.history,
      signal: context.signal,
      // 选区问答：截图随本轮问题送给模型。路径只接受 ask-shots 下的文件（用户在界面上自己框的图，不脱敏）
      ...(context.imagePath && isAskShotPath(app.getPath('userData'), context.imagePath)
        ? { imageDataUrl: readAskShotDataUrl(context.imagePath) ?? undefined }
        : {}),
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
    })

    disposeAskIpc = registerAskIpc({
      getWindow: () => askWindow,
      ask: async (question, context) => {
        // 先把日记目录的增量同步进来（节流；失败只记日志，不挡住提问）。
        // **必须在取 queryDb 之前**：同步要开写连接，会把只读连接关掉，
        // 先取再同步会拿到一个已经关闭的句柄。
        syncMemoryIfDue()
        const db = connections.queryDb()
        // A3 红线：没有库（从未采集）就不建库；时间轴上本来也没东西可找
        if (!db) {
          return {
            kind: 'no-evidence',
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: question.length }
          }
        }
        return askChain(askOptionsFor(db, context), question)
      },
      // 「还要继续查吗」→ 恢复暂停的循环（问题用检查点里的原话，续查通道不再传）
      resume: async (resumeId, decision, context) => {
        const db = connections.queryDb()
        if (!db) {
          return {
            kind: 'no-evidence',
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
          }
        }
        return askChain(
          { ...askOptionsFor(db, context), resume: { id: resumeId, decision } },
          ''
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
      record: (question, result, conversationId, imagePath) => {
        appendAskHistory(
          askHistoryPath,
          toHistoryEntry(question, result, Date.now(), conversationId, imagePath)
        )
      },
      // 选区问答：历史里的截图路径 → data URL（渲染层读不了文件；只认 ask-shots 下的文件）
      image: (path) => {
        const root = app.getPath('userData')
        return isAskShotPath(root, path) ? readAskShotDataUrl(path) : null
      },
      conversationHistory: (conversationId) => {
        // 由新到旧取出该会话最近的几轮，翻成「问题 + 上一轮的答复」当上下文。
        // 只给最近 6 轮（载荷层还会再截到 4 轮并重新脱敏），旧记录没有 conversationId 时按单条会话计。
        return readAskHistory(askHistoryPath)
          .filter((entry) => (entry.conversationId ?? entry.id) === conversationId)
          .slice(0, 6)
          .reverse()
          .map((entry) => ({
            question: entry.question,
            answer:
              entry.answer ??
              entry.clarify?.question ??
              (entry.kind === 'no-evidence' ? '信息链里没找到' : '')
          }))
          .filter((turn) => turn.answer !== '')
      },
      history: () => readAskHistory(askHistoryPath),
      clearHistory: () => clearAskHistory(askHistoryPath),
      // D53：设置抽屉（供应商 / 密钥 / 出网确认）与图谱窗口共用同一批实现，
      // 校验 / 落盘 / 副作用都必须一致，否则同一个设置会在两个入口表现不同。
      settings: () => readGraphSettings(connections.queryDb()),
      saveSettings: (patch) => saveGraphSettings(connections.ensureWritable().db, patch),
      onSettingsSaved: applyGraphSettings,
      providerModels: async (input) => {
        const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : storedProviderKey(input.providerId)
        return fetchModelsFromProvider({ baseUrl: input.baseUrl, apiKey })
      },
      saveProviderKey: (providerId, apiKey) => saveProviderKey(providerId, apiKey),
      providerKeys: () => providerKeyStatus(),
      // 个人记忆（vibe/free）：日记目录 + 人设；保存后立即同步日记目录
      memorySettings: readMemorySettings,
      saveMemorySettings,
      // 记忆条目（浏览 / 删除 / 撤销）：浏览走只读连接；删除与撤销走写连接，
      // 回答进行中由 ask-ipc 拒绝（开写连接会关掉正在读的只读连接）
      memoryList: (query) => {
        const db = connections.queryDb()
        if (!db) return { ok: false, error: 'db-unavailable' }
        const parsed = parseMemoryListQuery(query)
        if (!parsed.ok) return { ok: false, error: parsed.error }
        try {
          return buildMemoryListView(db, parsed.query)
        } catch (error) {
          captureLog('warn', 'memory list failed', { error: String(error) })
          return { ok: false, error: '读取记忆条目失败' }
        }
      },
      memoryDelete: (input) => {
        try {
          return deleteMemoryView(connections.ensureWritable().db, input)
        } catch (error) {
          captureLog('warn', 'memory delete failed', { error: String(error) })
          return { ok: false, error: '数据库暂不可用，没有删除' }
        }
      },
      memoryRestore: (input) => {
        try {
          return restoreMemoryView(connections.ensureWritable().db, input)
        } catch (error) {
          captureLog('warn', 'memory restore failed', { error: String(error) })
          return { ok: false, error: '数据库暂不可用，没有恢复' }
        }
      },
      log: (level, message, data) => captureLog(level, message, data)
    })

    // 启动后在后台同步一遍日记（不阻塞窗口；第一次问记忆时通常已经就绪）
    setTimeout(syncMemoryIfDue, 2_000)

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
      queryMomentSummary: (momentId) => {
        const db = connections.queryDb()
        return db ? queryMomentSummary(db, momentId) : { found: false, ocrSummary: null }
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

    ballMenuShell = createBallMenu({
      devServerUrl: process.env['ELECTRON_RENDERER_URL'],
      htmlPath: join(__dirname, '../renderer/ball-menu/index.html'),
      preloadPath: join(__dirname, '../preload/ball-menu.js'),
      // D54：菜单是独立窗口，打开时球收到 pointerleave 会缩回；由球壳钉住展开
      onVisibilityChange: (open) => ballShell?.setMenuOpen(open),
      log: captureLog
    })

    const openAskSettings = (): void => openAsk({ settings: true })

    ballShell = createBallShell({
      preloadPath: join(__dirname, '../preload/ball.js'),
      devServerUrl: process.env['ELECTRON_RENDERER_URL'],
      htmlPath: join(__dirname, '../renderer/ball/ball.html'),
      stateFilePath: join(app.getPath('userData'), BALL_STATE_FILE),
      getStatus: () => controller.status(),
      openRegionAsk: () => {
        void openRegionAsk()
      },
      openAsk,
      openSettings: openAskSettings,
      showMenu: (entries, anchor) => ballMenuShell?.open(entries, anchor),
      hideMenu: () => ballMenuShell?.close(),
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
        openAsk,
        openSettings: openAskSettings,
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

    // 开发 / 验收便利：GOTCHA_ASK_ON_START=1 启动即打开问记忆窗口（默认不改变行为）
    if (process.env['GOTCHA_ASK_ON_START'] === '1') openAsk()

    // Q1=B：只有上次显式开启（resume_on_start=1）才延迟 3s 自动恢复，且可被任意交互取消
    if (!launchCapture && readResumeOnStart()) scheduleStartupResume()
  })
}

