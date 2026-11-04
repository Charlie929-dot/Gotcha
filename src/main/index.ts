import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import Database from 'better-sqlite3'
import log from 'electron-log/main'
import { DB_FILE_NAME, openDatabase, queryTimeline, type Db } from '../db'
import { getNumberSetting, getSetting, setSetting } from '../db/settings'
import { memoryDayRange, previewMemoryProfile, readMemoryDay, recallMemory, syncVault } from '../memory/store'
import { buildSituation, splitRecallKeywords } from '../memory/opening'
import {
  countPendingVectors,
  hasDiaryVectors,
  indexDiaryVectors,
  pruneOrphanVectors,
  recallDiaryByVector
} from '../memory/vectors'
import { buildPersonaPrompt, personaCardDir, readPersona, readPersonaCard, resolveVaultDir, savePersonaCard } from '../memory/persona'
import type { TaskOutcome, TaskRow } from '../memory/agent/tasks'
import {
  createTaskRuntime,
  type TaskAdminSaveInput,
  type TaskRuntime
} from './task-runtime'
import { isGrowthWritingTask } from '../memory/agent/growth-tasks'
import {
  applyMemoryPatch,
  buildMemorySettingsView,
  parseMemoryPatch,
  type MemorySettingsSaveResult
} from './memory-settings'
import { buildMemoryListView, deleteMemoryView, parseMemoryListQuery, restoreMemoryView } from './memory-admin'
import type {
  GiveBirthResult,
  DiaryToolDeps,
  LetterAt,
  QqStickerToolDeps,
  QuoteMessageLookup
} from '../chain/agent/tools'
import { askModeKindOfBranch, asksMemoryContext, type AskModeState } from '../chain/agent/mode'
import {
  defaultToolsForBranchKind,
  hasDiaryTools,
  hasGrowthTools,
  hasLetterTools,
  hasScreenTools,
  hasTaskTools,
  QQ_TOOL_NAMES
} from '../chain/agent/tool-catalog'
import { readUsage, recordUsage } from '../understand/induction'
import { WinrtOcrBridge } from '../capture/ocr/winrt-bridge'
import { ScreenCapture } from '../capture/screen-stream'
import { selectionToFrameCrop } from '../capture/full-frame'
import {
  isAskShotPath,
  pruneAskShots,
  readAskShotDataUrl,
  saveAskShot,
  saveAskUpload
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
import type { AskRecentSegment, RedactableAskOpening } from '../chain/agent/payload'
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
import { createAskConversationRegistry } from './ask-conversation'
import {
  createCommandHandler,
  currentModeState,
  memoryDayKey,
  serializeCommands,
  type CompactOutcome
} from './commands'
import { giveBirth as giveBirthOnRepo } from './give-birth'
import { handoverReceiptText } from './handover'
import { createLetterStore } from './letters'
import {
  lifeGateOf,
  settleLifeHandover,
  type InheritLifeDeps,
  type LifeGate
} from './life-inherit'
import { defaultMomLetterFor } from './default-mom-letter'
import {
  birthDayOf,
  branchKindOf,
  type BranchKind,
  ensureLineage,
  findBranch,
  generationOf,
  lifeOf,
  lineageSnapshot,
  mainBranchForBranch,
  readLineage,
  recordLineageUsage,
  toolsOfBranch,
  usageAfterCompact
} from './lineage'
import { createMemoryRepo } from './memory-repo'
import {
  applyMemoryRepoPatch,
  buildMemoryRepoSettingsView,
  readMemorySchedule
} from './memory-repo-settings'
import { createMemoryScheduler } from './memory-schedule'
import { createNotebookStore } from './notebook'
import { createGrowthStore } from './growth'
import { forkDetachedIfNeeded } from './node-fork'
import {
  askConversationSentChars,
  compactAskConversation
} from '../chain/agent/conversation'
import {
  appendAskHistory,
  ASK_HISTORY_FILE,
  clearAskHistory,
  readAskHistory,
  toHistoryEntry
} from './ask-history'
import { createQqChannel, formatAskResult, QQ_REPLY_DEFAULT_CHARS, type QqChannel, type QqChannelConfig } from './qq/channel'
import { ChatLog } from './qq/chat-log'
import { QqOb11Server } from './qq/ob11'
import { QqMediaGate, prepareOutboundImage } from './qq/media'
import {
  buildQqStickerListView,
  QqStickerStore,
  type QqStickerEntry,
  type QqStickerListView
} from './qq/stickers'
import { NapcatManager } from './qq/napcat'
import {
  applyQqPatch,
  buildQqSettingsView,
  parseQqPatch,
  QQ_DEFAULT_HOST,
  QQ_DEFAULT_PORT,
  readNapcatAutoStart,
  readNapcatShellDir,
  readQqConfig,
  writeNapcatShellDir,
  type QqSettingsSaveResult,
  type QqSettingsView
} from './qq/qq-settings'
import type { ChainAskResult, ChainAskTurnContext } from '../chain/agent/types'
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
/** 记忆仓定时器（D90）：退出时停掉，别留野定时器 */
let stopMemorySchedule: (() => void) | null = null
/** 任务运行时（自调用 v0.2）：任务库连接 + 到点调度器；退出时停掉 */
let taskRuntime: TaskRuntime | null = null
/** 成长档案（§8）：「每天写日记」那条自主任务的 id（写完串下一篇用；没有 = null） */
let growthDailyTaskId: number | null = null
/** QQ 通道（D63）：默认关闭；挂在这里是为了 before-quit 能直接收口端口 */
let qqChannel: QqChannel | null = null
/** QQ 聊天台账（D96）：短号 ↔ QQ id + 原话；退出前 flush 一次 */
let qqChatLog: ChatLog | null = null
/** QQ 表情包池（D96 / PR2）：`<userData>/qq/stickers`；退出前 flush 一次 */
let qqStickers: QqStickerStore | null = null
/** QQ 发图闸门（D96 / PR2）：同一张表情 24h 内不连发、每日上限；落 `media-usage.json` */
let qqMediaGate: QqMediaGate | null = null
/** NapCat 托管（D66）：退出只停轮询，不结束用户正在用的 QQ（拍板：退出不关） */
let qqNapcat: NapcatManager | null = null
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
  stopMemorySchedule?.()
  stopMemorySchedule = null
  // 任务调度器：停掉定时器并关掉任务库那条独立写连接
  taskRuntime?.stop()
  taskRuntime = null
  growthDailyTaskId = null
  // QQ 通道先释放端口（不等回执；在途问答随进程退出一起收口）
  qqNapcat?.dispose()
  qqNapcat = null
  void qqChannel?.stop()
  qqChannel = null
  // 聊天台账：把合并窗口里没写盘的几条落下去
  qqChatLog?.dispose()
  qqChatLog = null
  // 表情包池 / 发图计数：索引都是即时写的，这里只是收口
  qqStickers?.dispose()
  qqStickers = null
  qqMediaGate?.dispose()
  qqMediaGate = null
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
 * QQ 发图的编码器（D96 / PR2）：与保留期同一套 `nativeImage` 口径。
 * 长边 ≤1600、JPEG 85；**不放大**；空图 / 解码失败返回 null（调用方按原图走或如实拒绝）。
 */
function encodeQqOutboundImage(input: {
  bytes: Buffer
  mime: string
  maxSide: number
}): { bytes: Buffer; mime: string } | null {
  const image = nativeImage.createFromBuffer(input.bytes)
  if (image.isEmpty()) return null
  const size = image.getSize()
  const longSide = Math.max(size.width, size.height)
  const scaled =
    longSide > input.maxSide
      ? image.resize({
          width:
            size.width >= size.height ? input.maxSide : Math.round((size.width * input.maxSide) / longSide),
          quality: 'good'
        })
      : image
  const bytes = scaled.toJPEG(85)
  return bytes.length > 0 ? { bytes, mime: 'image/jpeg' } : null
}

/** 表情 / 图片条目 → 工具视图（只带标签类信息，不带字节 / 路径） */
function stickerViewOf(entry: QqStickerEntry): {
  id: string
  label: string
  desc: string
  tags: readonly string[]
  useCount: number
} {
  return {
    id: entry.id,
    label: entry.label,
    desc: entry.desc,
    tags: [...entry.tags],
    useCount: entry.useCount
  }
}

/** data URL → 字节（`save_sticker` 收图用；不是合法图片 data URL 返回 null） */
function bytesOfImageDataUrl(dataUrl: string): Buffer | null {
  const matched = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/iu.exec(dataUrl.trim())
  if (matched === null) return null
  try {
    const bytes = Buffer.from(matched[1], 'base64')
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

/** 表情 id：池子里的 12 位 hex（不是消息短号） */
function stickerIdOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = (input as Record<string, unknown>)['id']
  if (typeof raw !== 'string') return null
  const id = raw.trim().toLowerCase()
  return /^[a-f0-9]{12}$/u.test(id) ? id : null
}

/** 设置抽屉「改标签 / 描述」的参数（只认这两个;为空 = 不改） */
function parseStickerEdit(
  input: unknown
): { id: string; patch: { label?: string; desc?: string } } | null {
  if (typeof input !== 'object' || input === null) return null
  const id = stickerIdOf(input)
  if (id === null) return null
  const row = input as Record<string, unknown>
  const patch: { label?: string; desc?: string } = {}
  if (typeof row['label'] === 'string') patch.label = row['label']
  if (typeof row['desc'] === 'string') patch.desc = row['desc']
  if (patch.label === undefined && patch.desc === undefined) return null
  return { id, patch }
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
      return buildMemorySettingsView(db, { userDataDir: app.getPath('userData') })
    }
    const saveMemorySettings = (patch: unknown): MemorySettingsSaveResult => {
      const parsed = parseMemoryPatch(patch, { userDataDir: app.getPath('userData') })
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
      const view = buildMemorySettingsView(db, { userDataDir: app.getPath('userData') })
      if (view.resolvedDir === null) return { ok: true, view, sync: null, syncedDir: null }
      try {
        const result = syncVault(db, view.resolvedDir)
        captureLog('info', 'memory sync', { dir: view.resolvedDir, ...result })
        // 保存设置 = 立即同步（用户口径）→ 顺手排向量索引（内部按指纹判断要不要真算）
        scheduleMemoryVectors()
        // 同步后统计会变（新增 / 删除），视图重读一次再回给界面
        return {
          ok: true,
          view: buildMemorySettingsView(db, { userDataDir: app.getPath('userData') }),
          sync: result,
          syncedDir: view.resolvedDir
        }
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
    const diaryToolsFor = (db: ChainDb, options: { sinceDay?: string } = {}): DiaryToolDeps => ({
      recall: (query) => {
        const result = recallMemory(db, { ...query, now: Date.now() })
        return result.hits
          .filter((hit) => options.sinceDay === undefined || hit.day_key >= options.sinceDay)
          .map((hit) => ({
            itemId: hit.id,
            day: hit.day_key,
            section: hit.section,
            kind: hit.kind,
            text: hit.text,
            tags: hit.tags,
            refs: hit.refs,
            reasons: hit.reasons
          }))
      },
      readDay: (day) => {
        // 女儿代读不到出生日之前的日记（M4）；返回 null 由工具如实回「这一天没有」
        if (options.sinceDay !== undefined && day < options.sinceDay) return null
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
    /**
     * 用户上传的图片落盘（历史回看用）：path 回填到 context.attachments 上；
     * 写失败只记日志——这次提问照样带图（data URL 还在），只是历史里点不开。
     */
    const prepareAskUploads = (context: AskQueryContext): void => {
      if (!context.attachments || context.attachments.length === 0) return
      const root = app.getPath('userData')
      const now = Date.now()
      context.attachments.forEach((item, index) => {
        if (item.kind !== 'image' || item.path || !item.dataUrl) return
        const saved = saveAskUpload(root, item.dataUrl, now, index)
        if (saved) item.path = saved
        else captureLog('warn', 'ask upload save failed', { index })
      })
    }
    /** 用户上传的附件 → 送云视图（图片 data URL + 文本文件；用户主动提供，不过脱敏墙） */
    const askAttachmentsOf = (context: AskQueryContext): ChainAskOptions['attachments'] => {
      const attachments = context.attachments ?? []
      const images = attachments
        .filter((item) => item.kind === 'image' && item.dataUrl)
        .map((item) => item.dataUrl as string)
      const files = attachments
        .filter((item) => item.kind === 'file' && item.text)
        .map((item) => ({ name: item.name ?? '文件', text: item.text as string }))
      return images.length > 0 || files.length > 0 ? { images, files } : undefined
    }
    /**
     * 记忆仓（memory-life M1）：ta 的记忆是一个本地 git 仓库。
     * - 家谱权威在仓外（`memory-lineage.json`），仓里只放只读快照；
     * - 会话落 `conversations/<会话 id>.jsonl`，图片按内容哈希存 `conversations/assets/` 二进制；
     * - git 不可用不阻塞任何事：ask 照常跑，`/help` 如实报不可用。
     */
    const memoryRepo = createMemoryRepo({
      root: join(app.getPath('userData'), 'memory-repo'),
      log: (level, message, data) => captureLog(level, message, data)
    })
    const lineageFile = join(app.getPath('userData'), 'memory-lineage.json')
    /**
     * 小本本（自调用 v0.2 §7）：记忆仓里的 `notebook.md`，跟着分支走。
     * `read()` 每轮进 `<now>`，`update` 是 `update_notebook` 的端口；`/notebook` 看 / 删。
     */
    const notebookStore = createNotebookStore({
      root: memoryRepo.root,
      now: () => Date.now()
    })
    /**
     * 成长档案（自调用 v0.2 §8）：记忆仓里的 `growth/`（日记 / 周记），跟着分支走。
     * `write` 是 `write_growth` 的端口；`/growth` 看列表与全文；全文不每轮注入。
     */
    const growthStore = createGrowthStore({
      root: memoryRepo.root,
      now: () => Date.now()
    })
    /**
     * 信（D81）：写在当前分支的 `letters/`；`<now>` 只报未读数，
     * 正文走 read_letter。桌面落点是 `<桌面>/记忆球的信/`。
     */
    const letterStore = createLetterStore({
      repo: memoryRepo,
      desktopDir: app.getPath('desktop'),
      now: () => Date.now()
    })
    /**
     * 会话存储（D64，只追加）：桌面窗口 / QQ 用户各自一个 conversationId。
     * 接了记忆仓就从当前节点的 `conversations/` 恢复（重启不断片），下一问只追加；
     * system 前缀不变，缓存才命中。
     */
    const askConversations = createAskConversationRegistry({
      root: memoryRepo.root,
      log: (level, message, data) => captureLog(level, message, data)
    })
    /** 启动自检：家谱（缺就建 / 坏就备份重建）+ 记忆仓（缺就 init）+ 快照进仓 */
    const ensureMemoryRepo = async (): Promise<void> => {
      try {
        const lineage = await ensureLineage(lineageFile)
        if (lineage.recovered) {
          captureLog('warn', 'memory lineage recovered', { backup: lineage.backupPath ?? '' })
        }
        const status = await memoryRepo.ensure()
        if (!status.ok) {
          captureLog('warn', 'memory repo unavailable', { reason: status.reason })
          return
        }
        await memoryRepo.writeFile('lineage.snapshot.json', lineageSnapshot(lineage.lineage))
        captureLog('info', 'memory repo ready', { branch: status.branch, head: status.head ?? '' })
      } catch (error) {
        captureLog('warn', 'memory repo startup failed', { error: String(error) })
      }
    }
    void ensureMemoryRepo()
    /**
     * 记忆仓定时（D90）：到点自己记一笔 / 推一次。
     * commit 前先写家谱快照（和「每轮问答之后」同一个口径），消息带时分让人看得出是什么时候插的旗子。
     */
    const memoryScheduler = createMemoryScheduler({
      commit: async () => {
        const lineage = await readLineage(lineageFile)
        if (lineage.status === 'ok') {
          await memoryRepo.writeFile('lineage.snapshot.json', lineageSnapshot(lineage.lineage))
        }
        const clock = new Date().toTimeString().slice(0, 5)
        const result = await memoryRepo.commit(`memory: 定时记一笔 ${clock}`)
        if (result.committed) captureLog('info', 'memory schedule committed', { hash: result.hash ?? '' })
      },
      push: async () => {
        const result = await memoryRepo.push()
        if (result.ok) captureLog('info', 'memory schedule pushed', {})
        else if (result.reason === 'failed') captureLog('warn', 'memory schedule push failed', {})
      },
      log: (level, message, data) => captureLog(level, message, data)
    })
    stopMemorySchedule = () => memoryScheduler.stop()
    /** 每轮问答之后：一天一个提交（不阻塞回答；失败只记日志） */
    const commitMemoryDay = (): void => {
      void (async () => {
        const lineage = await readLineage(lineageFile)
        if (lineage.status === 'ok') {
          await memoryRepo.writeFile('lineage.snapshot.json', lineageSnapshot(lineage.lineage))
        }
        const result = await memoryRepo.commitDay(memoryDayKey(Date.now()))
        if (result.committed) captureLog('info', 'memory day committed', { hash: result.hash ?? '' })
        else if (result.reason === 'failed') captureLog('warn', 'memory day commit failed', {})
      })().catch((error) => captureLog('warn', 'memory day commit failed', { error: String(error) }))
    }
    /**
     * 生命（M3）：`life_tokens_used` 按节点记，每轮 ask 前现读。
     * 读不到就不显示（不阻塞）；数字只进 `<now>` 的一行事实，不是证据。
     * M4：额外带出生日（女儿读不到出生前的日记）与母亲的信（`<mom_letter>`）。
     */
    interface AskLifeContext {
      branch: string
      used: number
      limit: number
      /** 分支种类（D79）：persona 才有默认的母亲信 */
      kind: BranchKind
      /** 第一代（家谱里没有母亲）：只有这一代拿默认的妈妈的信（D79 / D80） */
      firstGeneration: boolean
      /** 当前分支的昵称（写信时的「来自」） */
      nickname: string
      /** 这一代的出生日（本地 `yyyy-mm-dd`）；代分支才有 */
      bornDay?: string
      /** 母亲留下的信（仓内相对路径）；第一代没有 */
      letterPath?: string
    }
    /** 当前分支（问答历史按分支隔离，D72）；家谱读不到就按 default，不编造 */
    const activeBranchNow = async (): Promise<string> => {
      try {
        const read = await readLineage(lineageFile)
        return read.status === 'ok' ? read.lineage.active : 'default'
      } catch {
        return 'default'
      }
    }
    /**
     * 这一代的主线（2026-11-01 拍板）：一代只有一条，**只有主线写成长档案**。
     * `ok=false` = 家谱读不出来（认不出主线就不拦，按老行为写，不静默罢工）。
     */
    const mainlineNow = async (): Promise<{ ok: boolean; branch: string; main: string | null }> => {
      const branch = await activeBranchNow()
      try {
        const read = await readLineage(lineageFile)
        if (read.status !== 'ok') return { ok: false, branch, main: null }
        return { ok: true, branch, main: mainBranchForBranch(read.lineage, branch) }
      } catch {
        return { ok: false, branch, main: null }
      }
    }
    /** 家谱读不到时的兜底模式：chat + 全工具（老行为），不静默降成纯模型 */
    const fallbackMode: AskModeState = {
      kind: 'chat',
      branch: 'default',
      tools: defaultToolsForBranchKind('persona')
    }
    /**
     * 这一问的处境（D72）：当前分支 → 模式（kind + 工具白名单）+ 生命（M3/M4）。
     * 读不到就不显示（不阻塞）；数字只进 `<now>` 的一行事实，不是证据。
     *
     * assistant 分支（纯模型）也有生命（D86）：同样 500K、照样记账、`<now>` 里也有生命行；
     * 但它不是一条鱼，所以**不冻结、不传承**——只是把上下文占用照实显示出来。
     */
    interface AskStateNow {
      mode: AskModeState
      life?: AskLifeContext
      /** 未读信数（D81）：>0 才进 `<now>` */
      unreadLetters?: number
    }
    const askStateNow = async (): Promise<AskStateNow | undefined> => {
      try {
        const read = await readLineage(lineageFile)
        if (read.status !== 'ok') return undefined
        const lineage = read.lineage
        const branch = lineage.active
        const kind = branchKindOf(lineage, branch) ?? 'persona'
        const mode: AskModeState = {
          kind: askModeKindOfBranch(kind),
          branch,
          tools: toolsOfBranch(lineage, branch)
        }
        const life = lifeOf(lineage, branch)
        if (life === null) return { mode }
        const generation = generationOf(lineage, branch)
        // 只有「女儿代」（有母亲）才有出生日边界；第一代看全部日记
        const bornDay =
          generation !== null && generation.mother !== null ? birthDayOf(lineage, branch) : null
        const unreadLetters = hasLetterTools(mode.tools) ? await letterStore.unreadCount() : 0
        return {
          mode,
          life: {
            branch: life.branch,
            used: life.used,
            limit: life.limit,
            kind,
            firstGeneration: generation !== null && generation.mother === null,
            nickname: generation?.nickname ?? branch,
            ...(bornDay !== null ? { bornDay } : {}),
            ...(generation?.letter ? { letterPath: generation.letter } : {})
          },
          ...(unreadLetters > 0 ? { unreadLetters } : {})
        }
      } catch {
        return undefined
      }
    }
    /**
     * 母亲的信（M4 / D79 / D80）：真的写过信就用仓里那封；第一代（没有母亲）用默认的
     * 妈妈写给她的信，后代没有信就没有。纯模型 / 出生主干不给。
     */
    const momLetterFor = async (life: AskLifeContext | undefined): Promise<string | undefined> => {
      if (life === undefined) return undefined
      if (life.letterPath !== undefined) return (await memoryRepo.readFile(life.letterPath)) ?? undefined
      return defaultMomLetterFor(life.kind, life.firstGeneration)
    }
    /**
     * 生命闸门（M3/M4；2026-11-02 修「耗尽却没传承」，D97）。
     *
     * 改前：`used >= limit` 一律返回一句「生命已经结束」，既不调模型、也没有兜底传承——
     * 模型在 85%–100% 的窗口里没调用 `give_birth`，下一问用量越过 100% 就永久冻结。
     *
     * 现在：还活着、是 persona/chat、还没有女儿的生命耗尽分支返回 `inherit`——这一问照常问
     * （`give_birth` 按原门槛照旧注入），问完由 `settleLifeHandover` 兜底保证传承发生；
     * dead / 纯模型 / 出生主干 / 已经有女儿的分支话术与行为都不变。
     */
    const lifeGateNow = async (): Promise<LifeGate> => {
      try {
        const read = await readLineage(lineageFile)
        if (read.status !== 'ok') return { kind: 'allow' }
        return lifeGateOf(read.lineage)
      } catch {
        // 家谱坏掉不能把提问整条链路带崩：按「放行」处理（老行为）
        return { kind: 'allow' }
      }
    }
    /**
     * 临终传承的收口（2026-11-02，D97）：这一问答完，模型没传承就跑兜底（写信 + 生女儿）。
     *
     * - 模型自己传承了（`modelInherited`）→ 什么都不做，回执由 `onBirth` 那边挂；
     * - 没传承（不配合 / 模型不可用 / 没走到那一步）→ 主进程兜底，成功就回交接回执；
     * - 兜底失败（家谱坏 / 记忆仓不可用 / 已经切走）→ 只记日志，这一问的回答照常返回（不锁死）。
     */
    const settleInheritance = async (
      gate: LifeGate,
      modelInherited: boolean
    ): Promise<{ inherited: boolean; receipt?: string }> => {
      if (gate.kind !== 'inherit') return { inherited: modelInherited }
      const deps: InheritLifeDeps = {
        repo: memoryRepo,
        lineageFile,
        letters: letterStore,
        now: () => Date.now(),
        log: (level, message, data) => captureLog(level, message, data)
      }
      const settled = await settleLifeHandover(deps, {
        motherBranch: gate.branch,
        motherName: gate.motherName,
        modelInherited
      })
      if (settled.inherited && modelInherited !== true) {
        // 兜底真的出生了：清掉会话内存缓存，下一问从女儿的空会话开始
        // （母亲最后那一问已经落在她自己的分支里）
        askConversations.reload()
      }
      return settled
    }
    /** 这一问的结果 + 传承收口（回执 / conceived）；两条问路共用同一套口径 */
    const withInheritance = async (
      gate: LifeGate,
      result: Awaited<ReturnType<typeof askChain>>,
      birthReceipt?: string
    ): Promise<Awaited<ReturnType<typeof askChain>>> => {
      // 「还要继续查吗」的暂停轮先不收口：这一问还没完（用户点继续时会把最终答复问完），
      // 等真正结束那一轮再兜底——否则会在这里把 active 切到女儿，暂停的检查点就串代了。
      if (result.kind === 'continue-ask') return result
      const settled = await settleInheritance(gate, result.conceived === true)
      const conceived = result.conceived === true || settled.inherited
      const receipt = settled.receipt ?? birthReceipt
      return {
        ...result,
        ...(conceived ? { conceived: true as const } : {}),
        ...(receipt !== undefined && receipt !== '' ? { receipt } : {})
      }
    }
    /**
     * `/compact`（M3；2026-11-02 改口径，D97）：把**所有轮次**里超长的问答正文 / 附件正文
     * 记成「已压缩」——送云时换成占位符，原文仍在会话里（`recall` 取回），不删轮、不写摘要。
     * 因此这里**不调模型**（也就不需要出云门 / 日额度 / 脱敏墙），失败只报原因。
     */
    const compactConversation = async (
      conversationId: string | undefined
    ): Promise<CompactOutcome> => {
      if (conversationId === undefined) return { ok: false, reason: 'no-session' }
      const store = askConversations.for(conversationId)
      const current = store.load()
      if (current.turns.length === 0) {
        return { ok: false, reason: 'too-short', detail: '这个会话还没有轮次，没什么可压的。' }
      }
      const compacted = compactAskConversation(current)
      store.save(compacted.conversation)
      // 只改本地会话（不产生出云请求）；留一个提交，记忆仓里能看出压过
      await memoryRepo.commit(`memory: compact ${memoryDayKey(Date.now())}`)
      // 续命（D69 §5.2）：压完把这一节点的用量改成「压缩后的近似值」——否则下一问仍然
      // 被「生命已结束」拦住，永远走不到「按新上下文重算」那一步（2026-10-31 真机复验抓到的死锁）。
      // 新口径没有摘要请求的 usage 可扣：按送云字符量的比值缩放上一次的真实用量（`usageAfterCompact`）。
      // dead 节点由 recordLineageUsage 拒绝，不会复活已经交接出去的那一代。
      let beforeTokens = 0
      let afterTokens = 0
      try {
        const read = await readLineage(lineageFile)
        const life = read.status === 'ok' ? lifeOf(read.lineage, read.lineage.active) : null
        if (read.status === 'ok' && life !== null) {
          beforeTokens = life.used
          afterTokens = usageAfterCompact(
            life.used,
            askConversationSentChars(current),
            askConversationSentChars(compacted.conversation)
          )
          await recordLineageUsage(lineageFile, read.lineage.active, afterTokens)
        }
      } catch (error) {
        captureLog('warn', 'memory compact life update failed', { error: String(error) })
      }
      return {
        ok: true,
        covered: compacted.covered,
        placeheld: compacted.placeheld,
        beforeTokens,
        afterTokens
      }
    }
    /**
     * 开场注入（D61，2026-10-30 收敛）：
     * - 「此刻」= 本地确定规则（时间 / 今天说过几句 / 上次多久前 / 日记记到哪天），**每轮都重算**
     *   （时间会走，旧数字会变成假话），不调模型；
     * - 「想到的」= 只在新对话第一问回想 3 条日记（联想，不是证据；引用仍只由 read_diary 生成）；
     *   续问不重新联想，避免同一条记忆每轮换一个说法。
     * 两段都随载荷过脱敏墙（云端策略在边界）。
     *
     * 取数只走三个入口，不再每问摸全表：
     * - 说话时刻：`talkTimes` 由调用方给（桌面 = 问答历史，QQ = 本通道自己的时刻；
     *   以前 QQ 报的是桌面的数字）；
     * - 日记记到哪天：`memoryDayRange`（两个聚合），不再跑 `memoryStats` 的整表统计；
     * - 想到的：优先向量（索引已有），拿不到再回落关键词。
     */
    const askOpeningFor = async (
      db: ChainDb,
      question: string,
      context: AskQueryContext,
      mode: AskModeState,
      talkTimes?: readonly number[],
      sinceDay?: string
    ): Promise<RedactableAskOpening | undefined> => {
      // 纯模型（ask）：不带「此刻 / 想到的」，否则它会显得知道你的记忆
      if (!asksMemoryContext(mode.kind)) return undefined
      const now = Date.now()
      const facts = buildSituation({
        now,
        talkTimes: talkTimes ?? readAskHistory(askHistoryPath).filter((entry) => entry.conceived !== true).map((entry) => entry.at),
        lastDiaryDay: memoryDayRange(db).lastDay
      })
      const firstTurn = question.trim() !== '' && (context.history?.length ?? 0) === 0
      // 「想到的」要翻日记：这个分支没挂日记工具就不联想，免得给了片段又查不了
      const recalled =
        firstTurn && hasDiaryTools(mode.tools)
          ? await recallOpening(db, question, now, sinceDay)
          : { items: [], source: 'none' as const }
      // 只记日期不记正文：排查「开场有没有生效」用，别把日记写进日志
      captureLog('info', 'ask opening', {
        facts,
        rememberedDays: recalled.items.map((hit) => hit.day),
        recallSource: recalled.source
      })
      return {
        facts,
        ...(recalled.items.length > 0 ? { remembered: recalled.items } : {})
      }
    }
    /**
     * 第一问的「想到的」：向量优先，关键词兜底。
     *
     * 两条路返回同一形状，调用方（以及送云的载荷）不用分两套。向量只在索引已经有货时
     * 才加载 embedder（没有向量时加载模型纯属白等）；embed 失败 / 维度不对 / 没过阈值
     * 都回落到关键词——「没向量」不等于「没想到」。`source` 只进日志，方便真机核对走了哪条路。
     */
    const recallOpening = async (
      db: ChainDb,
      question: string,
      now: number,
      sinceDay?: string
    ): Promise<{
      items: Array<{ day: string; snippet: string }>
      source: 'vector' | 'keyword'
    }> => {
      if (hasDiaryVectors(db)) {
        const embedder = await loadChainEmbedder()
        if (embedder !== null) {
          const vectorHits = await recallDiaryByVector(db, embedder, question, { now, topK: 3 })
          const filtered =
            vectorHits === null
              ? null
              : vectorHits.filter((hit) => sinceDay === undefined || hit.day >= sinceDay)
          if (filtered !== null && filtered.length > 0) {
            return {
              items: filtered.map((hit) => ({ day: hit.day, snippet: hit.snippet })),
              source: 'vector'
            }
          }
        }
      }
      const keywords = splitRecallKeywords(question)
      if (keywords.length === 0) return { items: [], source: 'keyword' }
      const items = diaryToolsFor(db, { sinceDay })
        .recall({ keywords, limit: 3 })
        .map((hit) => ({
          day: hit.day,
          snippet: hit.text.replace(/\s+/gu, ' ').trim().slice(0, 120)
        }))
        .filter((hit) => hit.snippet !== '')
      return { items, source: 'keyword' }
    }
    const askOptionsFor = (
      db: ChainDb,
      context: AskQueryContext,
      mode: AskModeState,
      opening?: RedactableAskOpening,
      life?: AskLifeContext,
      momLetter?: string,
      unreadLetters?: number,
      /** 传承成功后拿到交接回执（D82）：由组合根挂到这一问的结果上 */
      onBirth?: (receipt: string) => void
    ): ChainAskOptions => {
      const chat = mode.kind === 'chat'
      const tools = mode.tools
      // 人设：只有 chat（persona 分支）注入（卡启用 → 卡全文；卡没启用 → 名字 / 口吻 / 红线）。
      // 纯模型（ask）不带人设，免得它把「问个技术问题」也演成角色。
      const persona = chat ? readPersona(db, { userDataDir: app.getPath('userData') }) : null
      const personaPrompt = persona !== null ? buildPersonaPrompt(persona) : undefined
      const personaName = (persona?.name ?? '').trim()
      /** 信的「来自」：优先人设名（贴心大肥鱼），读不到再用分支昵称 */
      const letterFrom = personaName || life?.nickname || ''
      // 指代线索：提问前最后一段（不是证据；引用仍要经 search_info / read_segment）
      const recent = hasScreenTools(tools) ? latestSegmentHint(db) : undefined
      // 生女儿（D81）：只有 persona 分支、生命 ≤15% 且带工具时才给这个入口；纯模型保持单轮
      const birthEnabled =
        life !== undefined &&
        chat &&
        tools.length > 0 &&
        life.used >= life.limit * 0.85
      return {
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
        // 没有屏幕工具就不接问答记录 / 检索：模型拿不到，也就不会「查到」不该查的
        ...(hasScreenTools(tools)
          ? {
              // ask_history 默认只查本会话（D55 ②）：以前把全库问答倒给模型，别的会话的问题会被写成
              // 「你刚才问的」。要跨会话必须显式 scope:"all"，每条带 session 标记。
              readAskHistory: (scope: 'conversation' | 'all') => {
                const current = (entry: { conversationId?: string; id: string; branch?: string }): boolean =>
                  (entry.conversationId ?? entry.id) === context.conversationId &&
                  (entry.branch ?? 'default') === mode.branch
                return readAskHistory(askHistoryPath)
                  .filter((entry) => entry.conceived !== true)
                  .filter((entry) => scope === 'all' || current(entry))
                  .map((entry) => ({
                    at: entry.at,
                    question: entry.question,
                    kind: entry.kind,
                    session: (current(entry) ? 'current' : 'other') as 'current' | 'other'
                  }))
              },
              // 指代线索：提问前最后一段（不是证据；引用仍要经 search_info / read_segment）
              ...(recent !== undefined ? { recent } : {}),
              searchBatch: runSearchBatch
            }
          : {}),
        // 个人记忆（第二本账）：日记条目 + 「关于我」统计；人设是本地配置，只拼在 system 最前面。
        // M4：女儿代带 sinceDay（出生前的日记读不到）。
        ...(hasDiaryTools(tools) ? { diary: diaryToolsFor(db, { sinceDay: life?.bornDay }) } : {}),
        // 信（D81）：写 / 列 / 读；只有挂了这个工具的分支才接后端
        ...(hasLetterTools(tools) && life !== undefined
          ? {
              letters: {
                write: (input: { to: string; write: string; at: LetterAt }) =>
                  letterStore.write({ ...input, from: letterFrom }),
                list: () => letterStore.list(),
                read: (id?: string) => letterStore.read(id)
              }
            }
          : {}),
        // 任务记忆（自调用 v0.2 §6）：共建计划 / 自主任务的四个工具 + 到点合流。
        // 只在分支挂了任务工具时接；没接的话模型调 schedule_task 会如实回「记不下」。
        ...(hasTaskTools(tools) && taskRuntime !== null
          ? {
              tasks: taskRuntime.port,
              dueTasks: () => taskRuntime?.dueHints() ?? []
            }
          : {}),
        // 小本本（自调用 v0.2 §7）：chat（persona）每轮注入当前核心页；
        // 工具在不在由分支白名单决定（没挂 update_notebook 时只看不改）。
        ...(chat ? { notebook: notebookStore } : {}),
        // 成长档案（自调用 v0.2 §8）：只有挂了 write_growth 的分支才接后端；
        // 全文不注入，写不写、写哪篇由 ta 在写作轮里自己决定。
        ...(hasGrowthTools(tools) ? { growth: growthStore } : {}),
        ...(personaPrompt !== undefined ? { personaPrompt } : {}),
        // 这次给哪些工具（D72：当前分支的 /tool 白名单）：链层据此决定单轮 / 工具循环
        tools,
        // 生女儿（D81）：生命 ≤15% 才把 give_birth 放进来（工具描述在 deepseek.ts）
        ...(birthEnabled && life !== undefined
          ? {
              giveBirth: async (nickname: string) => {
                // D82：母亲这代没起过名就补人设名（回执 / 家谱树都用它）
                const result = await giveBirth({
                  nickname,
                  motherBranch: life.branch,
                  ...(personaName !== '' ? { motherName: personaName } : {})
                })
                const daughter = result.nickname ?? result.branch
                if (result.ok && onBirth !== undefined && daughter !== undefined && daughter !== '') {
                  // 母亲名：人设名 > 这代真名 > 分支名；女儿名用刚出生的那个
                  onBirth(
                    handoverReceiptText({
                      mother: personaName || life.nickname || life.branch,
                      daughter
                    })
                  )
                }
                return result
              }
            }
          : {}),
        // 母亲的信（M4 / D80）：第一代 / 旧数据的 system 里多一段 <mom_letter>
        ...(momLetter !== undefined && momLetter !== '' ? { momLetter } : {}),
        // 未读信数（D81）：只进 `<now>` 的一行
        ...(unreadLetters !== undefined ? { unreadLetters } : {}),
        // 新对话第一问：给 ta 一点「此刻」和「想到的」（D61）；续问/老对话不带
        ...(opening !== undefined ? { opening } : {}),
        // 生命（M3）：每轮现算，进 `<now>` 的一行事实
        ...(life !== undefined ? { life } : {}),
        // 多轮对话：同一会话之前的几轮（主进程只从自己落盘的历史里筛，渲染层伪造不了）
        history: context.history,
        // 会话（D64）：只追加的消息历史（工具轮也在里面），下一问原样重放
        conversation: askConversations.for(context.conversationId),
        signal: context.signal,
        // 选区问答：截图随本轮问题送给模型。路径只接受 ask-shots 下的文件（用户在界面上自己框的图，不脱敏）
        ...(context.imagePath && isAskShotPath(app.getPath('userData'), context.imagePath)
          ? { imageDataUrl: readAskShotDataUrl(context.imagePath) ?? undefined }
          : {}),
        // 用户上传的图片 / 文本文件（用户主动提供，与选区截图同口径不过脱敏墙）
        ...(askAttachmentsOf(context) ? { attachments: askAttachmentsOf(context) } : {}),
        // 历史截图出云（默认关，2026-10-29 拍板）：开了 read_segment 才带得出截图
        ...(hasScreenTools(tools) && getSetting(db, GRAPH_SETTING_KEYS.askHistoryShots) === '1'
          ? { readShot: (path: string) => readShotDataUrl(path) }
          : {}),
        canSend: () => getSetting(db, GRAPH_SETTING_KEYS.outboundConsent) === '1',
        overBudget: () => {
          const budget = getNumberSetting(db, GRAPH_SETTING_KEYS.budgetTokensPerDay, 1_000_000)
          if (budget <= 0) return false
          const usage = readUsage(db, Date.now())
          return usage.promptTokens + usage.completionTokens >= budget
        },
        onUsage: (usage, meta) => {
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
          // 生命（M3/M4）：记到**这一问开始时**的分支；传承会在 ask 中途把 active 切到女儿，
          // 不能在回调时现读 active，否则母亲最后一问的用量会记到女儿头上。
          // 纯模型分支也有生命（D86）：照常记账；recordLineageUsage 只拒绝 dead 节点。
          // 带图的一问不记（D88）：图只活这一轮，下一轮在上下文里已经变成占位符——
          // 记进去只会让「还剩 X%」掉 8%，下一轮又跳回来。下一次请求的真实 usage 会覆盖它。
          if (meta.images > 0) return
          void recordLineageUsage(
            lineageFile,
            life?.branch ?? mode.branch,
            usage.promptTokens + usage.completionTokens
          ).catch((error) => captureLog('warn', 'memory life record failed', { error: String(error) }))
        },
        log: (level, message, data) => captureLog(level, message, data)
      }
    }

    /**
     * 本地命令（M1/M2/M3/M5）：桌面与 QQ **共用同一个 handler**——两路发 `/use` 改的是同一条鱼，
     * 「等名字 / 等 confirm」状态也只有一份。串行锁（M5）保证两路命令不互相踩。
     * 命中就在本地执行、不调模型（`/compact` 例外：压摘要过一次模型）、不进问答历史。
     */
    const command = serializeCommands(
      createCommandHandler({
        repo: memoryRepo,
        lineageFile,
        reloadConversations: () => askConversations.reload(),
        compact: compactConversation,
        // /tasks：挂在 /help 上的任务视图（共建计划 + 自主任务），取消也走这里
        tasks: {
          list: () => {
            if (taskRuntime === null) return '任务库还没起来（重启后再看）。'
            const result = taskRuntime.port.search({ view: 'pending', limit: 20 })
            if (result.total === 0) return '现在没有挂着的计划或自主任务。'
            const lines = [
              `挂着的任务（${result.total} 条${result.truncated ? '，只显示前 20 条' : ''}）：`
            ]
            for (const item of result.tasks) {
              const origin =
                item.origin === 'user' ? '共建' : item.origin === 'agent' ? '自主' : '例行'
              const repeat = item.repeat === '' ? '' : `（${item.repeat}）`
              const sync =
                item.sync === 'failed'
                  ? ' · Obsidian 未同步'
                  : item.sync === 'pending'
                    ? ' · Obsidian 待同步'
                    : ''
              lines.push(`  #${item.id} ${item.when}${repeat} ${item.instruction} · ${origin}${sync}`)
            }
            lines.push('', '取消一条：/tasks cancel <编号>')
            return lines.join('\n')
          },
          cancel: (id) => taskRuntime?.port.cancel(id).message ?? '任务库还没起来（重启后再试）。'
        },
        // /notebook：ta 的小本本（记忆仓里的 notebook.md），删一条不再准确的
        notebook: {
          list: () => notebookStore.list(),
          remove: (id) => notebookStore.remove(id)
        },
        // /growth：ta 自己的成长档案（记忆仓里的 growth/），给键看全文
        growth: {
          list: () => growthStore.list(),
          show: (key) => growthStore.show(key)
        }
      })
    )

    /**
     * QQ 通道（D63）：参考 `dsh-onebot-qq` 的 OneBot 11 口径——NapCat 反向 WS 拨入本机 127.0.0.1，
     * 我们只做「私聊文字 → 问记忆 → 纯文本回话」。
     *
     * 不复刻参考插件的插件形态（多账号 / 群聊 / 媒体 / t2i），M1 只借协议与 NapCat 对接方式；
     * 斜杠命令由 M5（D87）接上：与桌面共用同一套 `command`。
     * - 问答复用桌面同一条链路（`askChain` → 同一份出云策略、日额度、脱敏墙）与「问记忆」模式；
     * - 上下文按 QQ 用户各自留最近 6 轮（内存，重启即弃；不写桌面问答历史，免得两套记录互相污染）；
     * - 默认关闭，设置里开了才占端口；没白名单 / 没 token 一律不起（fail-closed）。
     */
    const qqHistories = new Map<string, ChainAskTurnContext[]>()
    /**
     * QQ 通道自己的「说话时刻」：桌面问答历史不记 QQ 的话，以前 QQ 开场报的是
     * 「桌面今天说过几句」——数字是别人的。这里按会话单独记，只用于开场事实。
     */
    const qqTalkTimes = new Map<string, number[]>()
    /**
     * 生女儿（D81 / D73）：真正的动作抽到 `give-birth.ts`（真实 git 仓可独立验收，不弹窗口）；
     * 这里只做组合根的事：女儿出生后重读会话、清 QQ 内存上下文、在线改 QQ 名。
     *
     * 只有生命 ≤15% 时工具才会出现，这里再校验一次（模型可能伪造调用 / 旧检查点恢复）。
     */
    const giveBirth = async (input: {
      nickname: string
      motherBranch: string
      /** 母亲这代真正叫什么（D82）：老家谱第一代只有 `default`，交接时补成人设名 */
      motherName?: string
    }): Promise<GiveBirthResult> => {
      const result = await giveBirthOnRepo(
        { repo: memoryRepo, lineageFile },
        {
          nickname: input.nickname,
          motherBranch: input.motherBranch,
          ...(input.motherName !== undefined ? { motherName: input.motherName } : {})
        }
      )
      if (!result.ok) return result

      // 女儿从空白开始：换分支了，会话注册表内存缓存全部重读（D72）
      // 会话文件在仓里、问答历史按分支筛，所以不必删母女的任何记录。
      askConversations.reload()
      qqHistories.clear()
      qqTalkTimes.clear()

      // QQ 在线（有连接）就改名；离线不调，免得等 action 超时；失败只记日志
      const qqOnline =
        qqChannel !== null && qqChannel.setProfile !== undefined && qqChannel.status().connections > 0
      if (qqOnline && qqChannel?.setProfile !== undefined && result.nickname !== undefined) {
        void qqChannel
          .setProfile(result.nickname)
          .catch((error) => captureLog('warn', 'qq profile rename failed', { error: String(error) }))
      }

      return result
    }
    /** 通道配置：从没建过库（A3）就当关闭，不为 QQ 建库 */
    const qqChannelConfig = (): QqChannelConfig => {
      const db = connections.queryDb()
      if (!db) {
        return {
          enabled: false,
          host: QQ_DEFAULT_HOST,
          port: QQ_DEFAULT_PORT,
          accessToken: '',
          allowUsers: [],
          replyMaxChars: QQ_REPLY_DEFAULT_CHARS
        }
      }
      return readQqConfig(db)
    }
    const rememberQqTurn = (
      conversationId: string,
      question: string,
      result: ChainAskResult
    ): void => {
      // 说话时刻先记：哪怕这条没答出来（澄清 / 报错），用户确实说过话
      const talks = qqTalkTimes.get(conversationId) ?? []
      qqTalkTimes.set(conversationId, [...talks, Date.now()].slice(-200))
      const answer =
        result.kind === 'answer' || result.kind === 'insufficient' ? result.answer : ''
      if (answer.trim() === '') return
      const previous = qqHistories.get(conversationId) ?? []
      qqHistories.set(conversationId, [...previous, { question, answer }].slice(-6))
    }
    qqChatLog = new ChatLog({
      file: join(app.getPath('userData'), 'qq', 'chat-log.json'),
      log: (level, message, data) => captureLog(level, message, data)
    })
    qqStickers = new QqStickerStore({
      root: join(app.getPath('userData'), 'qq', 'stickers'),
      log: (level, message, data) => captureLog(level, message, data)
    })
    qqMediaGate = new QqMediaGate({
      file: join(app.getPath('userData'), 'qq', 'media-usage.json'),
      log: (level, message, data) => captureLog(level, message, data)
    })
    /**
     * 表情包工具端口（D96 / PR2）：只在 QQ 路径挂。
     * - `pick` 在挑中时就记一次 useCount（图鉴按常用度排）；发送失败不影响这次记账；
     * - 发出去前统一过 `prepareOutboundImage`（长边 ≤1600 / ≤3MB，GIF 原样），
     *   压不动就如实返回 null（工具回「发不了」，而不是发一张糊的）。
     */
    const stickerPort: QqStickerToolDeps = {
      list: () => qqStickers?.catalog().map(stickerViewOf) ?? [],
      pick: (id) => {
        const found = qqStickers?.read(id) ?? null
        if (found === null) return null
        const prepared = prepareOutboundImage(found.bytes, encodeQqOutboundImage)
        if (!prepared.ok) return null
        const touched = qqStickers?.touch(found.entry.id) ?? found.entry
        return { view: stickerViewOf(touched), dataUrl: prepared.dataUrl }
      },
      save: ({ dataUrl, label, desc }) => {
        const bytes = bytesOfImageDataUrl(dataUrl)
        if (bytes === null) return { ok: false, error: '这张图取不到字节，收不了' }
        const store = qqStickers
        if (store === null) return { ok: false, error: '表情包还没准备好，稍后再试' }
        const added = store.add({
          bytes,
          label,
          ...(desc !== undefined && desc !== '' ? { desc } : {})
        })
        if (!added.ok) return added
        return {
          ok: true,
          id: added.entry.id,
          label: added.entry.label,
          duplicate: added.duplicate
        }
      }
    }
    qqChannel = createQqChannel(new QqOb11Server(), {
      log: (level, message, data) => captureLog(level, message, data),
      chatLog: qqChatLog,
      mediaGate: qqMediaGate,
      // 命令（M5）：与桌面同一个 handler；命中就不进模型，也不占限流 / 排队
      command,
      ask: async ({ text, conversationId, signal, images, files, quoted, recent }) => {
        // 与桌面同一套前置：历史提交只读查看中先分叉（M2），再同步日记、取只读连接
        await forkDetachedIfNeeded({
          repo: memoryRepo,
          lineageFile,
          reloadConversations: () => askConversations.reload(),
          log: (level, message, data) => captureLog(level, message, data)
        })
        // 生命闸门（M3/M4；D97）：同一代鱼，QQ 与桌面一样——dead 拒绝，耗尽但还没传承就照常问、
        // 答完兜底传承（不再像改前那样一句「生命已经结束」把手机端永久锁住）
        const gate = await lifeGateNow()
        if (gate.kind === 'blocked') {
          return {
            kind: 'error',
            reason: 'life-ended',
            message: gate.text,
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: text.length }
          }
        }
        syncMemoryIfDue()
        const db = connections.queryDb()
        if (!db) {
          // 没有库也得把传承做完：这一问没答出来，但下一代要能出生（不锁死）
          const settled = await withInheritance(gate, {
            kind: 'no-evidence',
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: text.length }
          })
          return settled
        }
        const state = await askStateNow()
        const mode = state?.mode ?? fallbackMode
        const life = state?.life
        // QQ 的短上下文按**分支**分开：切到 /mode ask 后不带 chat 的几句
        const historyKey = `${mode.branch}\u0000${conversationId}`
        const context: AskQueryContext = {
          conversationId,
          history: qqHistories.get(historyKey) ?? [],
          signal
        }
        const momLetter = await momLetterFor(life)
        // 交接回执（D82）：QQ 那一路只挂在结果上，回话格式仍由通道自己取 answer
        const birth: { receipt?: string } = {}
        const onBirth = (receipt: string): void => {
          birth.receipt = receipt
        }
        const options = askOptionsFor(
          db,
          context,
          mode,
          await askOpeningFor(db, text, context, mode, qqTalkTimes.get(historyKey) ?? [], life?.bornDay),
          life,
          momLetter,
          state?.unreadLetters,
          onBirth
        )
        /**
         * QQ 专属（D96 / PR1）：聊天台账 + `quote_message` 工具只在 QQ 路径挂，
         * 桌面看不到、也不进分支 `/tool` 白名单。短号查询限定在本会话台账里。
         */
        const chatLog = qqChatLog
        const quotePort =
          chatLog !== null
            ? (id: number): QuoteMessageLookup => {
                const record = chatLog.bySeq(conversationId, id)
                const recentSeqs = chatLog.recentSeqs(conversationId, 6)
                return record !== null
                  ? {
                      target: {
                        id: record.seq,
                        from: record.role,
                        text: record.text,
                        qqId: record.qqId
                      },
                      recent: recentSeqs
                    }
                  : { recent: recentSeqs }
              }
            : undefined
        const qqOptions: ChainAskOptions = {
          ...options,
          tools: [...mode.tools, ...QQ_TOOL_NAMES],
          ...(quoted !== undefined ? { quoted } : {}),
          ...(recent !== undefined && recent.length > 0 ? { chatRecent: recent } : {}),
          ...(quotePort !== undefined ? { quoteMessage: quotePort } : {}),
          // 表情 / 发图（D96 / PR2）：与引用一样只在 QQ 路径挂
          stickers: stickerPort
        }
        // QQ 发来的图片 / 文本文件（D88）：与桌面附件同口径（用户主动提供，不过脱敏墙；出网门照旧）
        const hasImages = images !== undefined && images.length > 0
        const hasFiles = files !== undefined && files.length > 0
        const result = await askChain(
          hasImages || hasFiles
            ? {
                ...qqOptions,
                attachments: {
                  ...(hasImages ? { images } : {}),
                  ...(hasFiles ? { files } : {})
                }
              }
            : qqOptions,
          text
        )
        // 传承收口（D97）：模型自己生了就用它的回执；没生就主进程兜底（写信 + 生女儿）。
        // 兜底出生也算「传承那一问」：不记进 QQ 的短上下文 / 说话时刻（女儿从空白开始）。
        const settled = await withInheritance(gate, result, birth.receipt)
        if (settled.conceived !== true) rememberQqTurn(historyKey, text, result)
        commitMemoryDay()
        return settled
      },
      // 「还要继续查吗」在 QQ 里也能答（2026-11-01 修）：与桌面同一个续查通道，
      // 问题用检查点里的原话（这边传 `''`），上下文取 QQ 自己的短上下文。
      resume: async ({ resumeId, decision, conversationId, question, signal }) => {
        const db = connections.queryDb()
        if (!db) {
          return {
            kind: 'no-evidence',
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
          }
        }
        const state = await askStateNow()
        const mode = state?.mode ?? fallbackMode
        const life = state?.life
        const historyKey = `${mode.branch}\u0000${conversationId}`
        const context: AskQueryContext = {
          conversationId,
          history: qqHistories.get(historyKey) ?? [],
          signal
        }
        const momLetter = await momLetterFor(life)
        // 续查也保留 QQ 专属工具（D96）：引用不因「继续查」而失效
        const resumeChatLog = qqChatLog
        const quotePort =
          resumeChatLog !== null
            ? (id: number): QuoteMessageLookup => {
                const record = resumeChatLog.bySeq(conversationId, id)
                const recentSeqs = resumeChatLog.recentSeqs(conversationId, 6)
                return record !== null
                  ? {
                      target: {
                        id: record.seq,
                        from: record.role,
                        text: record.text,
                        qqId: record.qqId
                      },
                      recent: recentSeqs
                    }
                  : { recent: recentSeqs }
              }
            : undefined
        const result = await askChain(
          {
            ...askOptionsFor(
              db,
              context,
              mode,
              await askOpeningFor(
                db,
                '',
                context,
                mode,
                qqTalkTimes.get(historyKey) ?? [],
                life?.bornDay
              ),
              life,
              momLetter,
              state?.unreadLetters
            ),
            tools: [...mode.tools, ...QQ_TOOL_NAMES],
            ...(quotePort !== undefined ? { quoteMessage: quotePort } : {}),
            stickers: stickerPort,
            resume: { id: resumeId, decision }
          },
          ''
        )
        // 续查的答案仍算当初那一问的答案：短上下文按原问题记
        const gate = await lifeGateNow()
        const settled = await withInheritance(gate, result)
        if (settled.conceived !== true) rememberQqTurn(historyKey, question, result)
        commitMemoryDay()
        return settled
      }
    })
    /**
     * NapCat 托管（D66）：找 / 装 NapCat、拉起进程、二维码、登录后热写 OneBot 配置。
     * 只在 QQ 通道开着且用户没关自动启动时才自己拉；退出 Gotcha 不结束进程。
     */
    qqNapcat = new NapcatManager({
      userDataDir: app.getPath('userData'),
      getEndpoint: () => {
        const config = qqChannelConfig()
        return { port: config.port, token: config.accessToken }
      },
      isConnected: () => (qqChannel?.status().connections ?? 0) > 0,
      getAutoStart: () => {
        const db = connections.queryDb()
        return db !== null ? readNapcatAutoStart(db) : true
      },
      getShellDir: () => {
        const db = connections.queryDb()
        return db !== null ? readNapcatShellDir(db) : ''
      },
      setShellDir: (dir) => {
        const db = connections.ensureWritable().db
        ensureChainSchema(db)
        writeNapcatShellDir(db, dir)
      },
      log: (level, message, data) => captureLog(level, message, data)
    })
    void qqNapcat.locate()
    const refreshQqChannel = async (): Promise<{ ok: boolean; error?: string }> => {
      if (!qqChannel) return { ok: false, error: 'qq channel unavailable' }
      try {
        const result = await qqChannel.start(qqChannelConfig())
        if (!result.ok) captureLog('warn', 'qq channel not started', { error: result.error })
        // 通道起来了才拉起 NapCat（D66）；已登录 / 已连着时 start 只做接管，不重复开 QQ
        if (result.ok && qqChannel.isRunning()) {
          const db = connections.queryDb()
          if (db !== null && readNapcatAutoStart(db)) void qqNapcat?.start()
        }
        return result
      } catch (error) {
        captureLog('error', 'qq channel refresh failed', { error: String(error) })
        return { ok: false, error: String(error) }
      }
    }
    const readQqSettings = (): QqSettingsView | { error: string } => {
      const db = connections.queryDb()
      if (!db) return { error: 'db-unavailable' }
      return buildQqSettingsView(db, qqChannel?.status())
    }
    const saveQqSettings = async (patch: unknown): Promise<QqSettingsSaveResult> => {
      const parsed = parseQqPatch(patch)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      let db: Db
      try {
        db = connections.ensureWritable().db
      } catch (error) {
        captureLog('warn', 'qq settings save: db unavailable', { error: String(error) })
        return { ok: false, error: '数据库暂不可用，设置没有保存' }
      }
      try {
        ensureChainSchema(db)
        applyQqPatch(db, parsed.patch)
      } catch (error) {
        captureLog('error', 'qq settings save failed', { error: String(error) })
        return { ok: false, error: '保存设置失败' }
      }
      // 保存即生效：起停端口 / 换 token 都在这里热切换；起不来也把设置留着（界面显示未运行 + 原因）
      await refreshQqChannel()
      // 端口 / token 变了：NapCat 已在跑就热写 OneBot 配置，不用重启 QQ
      void qqNapcat?.syncConfig()
      return { ok: true, view: buildQqSettingsView(db, qqChannel?.status()) }
    }

    /* ---------------- 表情包 / 聊天索引（D96 / PR2） ---------------- */

    /**
     * 导入表情：系统文件选择器多选 → 复制进 library。
     * 单张上限 2MB、只认 png/jpg/gif/webp（池子自己判），失败的计数只回数量，
     * 不把文件名 / 路径写进日志（D96 §6.5）。
     */
    const qqStickerImport = async (): Promise<QqStickerListView | { ok: false; error: string }> => {
      const store = qqStickers
      if (store === null) return { ok: false, error: '表情包还没准备好，稍后再试' }
      const picked = await dialog.showOpenDialog({
        title: '导入表情包',
        buttonLabel: '导入',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      })
      if (picked.canceled || picked.filePaths.length === 0) return buildQqStickerListView(store)
      let failed = 0
      for (const file of picked.filePaths.slice(0, 30)) {
        try {
          const bytes = readFileSync(file)
          const label = basename(file).replace(/\.[^.]+$/u, '').slice(0, 20).trim()
          const added = store.add({ bytes, label: label === '' ? '表情' : label })
          if (!added.ok) failed += 1
        } catch (error) {
          failed += 1
          captureLog('warn', 'qq sticker import failed', { error: String(error) })
        }
      }
      if (failed > 0) captureLog('warn', 'qq sticker import skipped', { failed })
      return buildQqStickerListView(store)
    }
    const qqStickerUpdate = (
      input: unknown
    ): QqStickerListView | { ok: false; error: string } => {
      const store = qqStickers
      if (store === null) return { ok: false, error: '表情包还没准备好' }
      const parsed = parseStickerEdit(input)
      if (parsed === null) return { ok: false, error: '改表情的参数不对' }
      const done = store.update(parsed.id, parsed.patch)
      if (!done.ok) return { ok: false, error: done.error }
      return buildQqStickerListView(store)
    }
    const qqStickerMove = (
      input: unknown,
      layer: 'trash' | 'library'
    ): QqStickerListView | { ok: false; error: string } => {
      const store = qqStickers
      if (store === null) return { ok: false, error: '表情包还没准备好' }
      const id = stickerIdOf(input)
      if (id === null) return { ok: false, error: '参数不对' }
      const done = store.move(id, layer)
      if (!done.ok) return { ok: false, error: done.error }
      return buildQqStickerListView(store)
    }
    const qqStickerRemove = (
      input: unknown
    ): QqStickerListView | { ok: false; error: string } => {
      const store = qqStickers
      if (store === null) return { ok: false, error: '表情包还没准备好' }
      const id = stickerIdOf(input)
      if (id === null) return { ok: false, error: '参数不对' }
      if (!store.remove(id)) return { ok: false, error: '没有这张表情' }
      return buildQqStickerListView(store)
    }
    const qqChatLogClear = (): { ok: boolean; error?: string } => {
      try {
        qqChatLog?.clear()
        return { ok: true }
      } catch (error) {
        captureLog('warn', 'qq chat log clear failed', { error: String(error) })
        return { ok: false, error: '清空失败' }
      }
    }

    /**
     * 按设置表（重新）挂记忆仓定时器（D90）：启动一次、保存设置后再来一次。
     * 读不出设置就当默认值——定时功能不该因为一次数据库抖动就消失。
     */
    const applyMemorySchedule = (): void => {
      try {
        const db = connections.queryDb()
        if (db === null) return
        memoryScheduler.apply(readMemorySchedule(db))
      } catch (error) {
        captureLog('warn', 'memory schedule read failed', { error: String(error) })
      }
    }
    applyMemorySchedule()

    /** 会话历史（同一分支、最近 6 轮）：桌面提问与到点任务共用同一份口径 */
    const conversationHistoryFor = async (
      conversationId: string
    ): Promise<readonly ChainAskTurnContext[]> => {
      // 由新到旧取出该会话（**同一分支**）最近的几轮，翻成「问题 + 上一轮的答复」当上下文。
      // 只给最近 6 轮（载荷层还会再截到 4 轮并重新脱敏），旧记录没有 conversationId 时按单条会话计。
      // 分支（D72）：切到 /mode ask 后不带 chat 的问答，反过来也一样。
      const branch = await activeBranchNow()
      return readAskHistory(askHistoryPath)
        .filter((entry) => entry.conceived !== true)
        .filter((entry) => (entry.conversationId ?? entry.id) === conversationId)
        .filter((entry) => (entry.branch ?? 'default') === branch)
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
    }

    /** 最近一次提问用的会话（到点任务往这里说，没人说过就现开一个） */
    let lastAskConversationId: string | null = null
    /** 有没有一轮用户问答在跑（任务到点先让位；由 ask-ipc 的在途状态回调维护） */
    let askBusy = false

    /**
     * 一次问答：桌面 / QQ / 任务到点共用同一条通道。
     * 任务到点也走这里（而不是另起一套），这样「先接用户、再提任务」只有一处口径。
     */
    const runAskOnce = async (
      question: string,
      context: AskQueryContext
    ): Promise<ChainAskResult> => {
      lastAskConversationId = context.conversationId
        // 历史提交只读查看中：第一句话先从这里分叉成自己的节点（M2）；失败不阻塞提问
        await forkDetachedIfNeeded({
          repo: memoryRepo,
          lineageFile,
          reloadConversations: () => askConversations.reload(),
          log: (level, message, data) => captureLog(level, message, data)
        })
        // 生命闸门（M3/M4；D97）：dead 拒绝；耗尽但还活着、是 persona/chat、还没传承 →
        // 这一问照常问（临终传承轮），问完由 withInheritance 兜底保证女儿出生（不再永久冻结）
        const gate = await lifeGateNow()
        if (gate.kind === 'blocked') {
          return {
            kind: 'error',
            reason: 'life-ended',
            message: gate.text,
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: question.length }
          }
        }
        // 先把日记目录的增量同步进来（节流；失败只记日志，不挡住提问）。
        // **必须在取 queryDb 之前**：同步要开写连接，会把只读连接关掉，
        // 先取再同步会拿到一个已经关闭的句柄。
        syncMemoryIfDue()
        prepareAskUploads(context)
        const db = connections.queryDb()
        // A3 红线：没有库（从未采集）就不建库；时间轴上本来也没东西可找。
        // 但传承照样要收口：这一问没答出来，下一代也得能出生（不锁死）。
        if (!db) {
          return withInheritance(gate, {
            kind: 'no-evidence',
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: question.length }
          })
        }
        const state = await askStateNow()
        const mode = state?.mode ?? fallbackMode
        const life = state?.life
        const momLetter = await momLetterFor(life)
        // 交接回执（D82）：这一问里真的出生了才填；文字由 askOptionsFor 按真名拼好
        const birth: { receipt?: string } = {}
        const onBirth = (receipt: string): void => {
          birth.receipt = receipt
        }
        const result = await askChain(
          askOptionsFor(
            db,
            context,
            mode,
            await askOpeningFor(db, question, context, mode, undefined, life?.bornDay),
            life,
            momLetter,
            state?.unreadLetters,
            onBirth
          ),
          question
        )
        // 记忆落仓不阻塞回答：一天一个提交（M1），失败了只是这次没进仓
        commitMemoryDay()
        return withInheritance(gate, result, birth.receipt)
    }

    disposeAskIpc = registerAskIpc({
      getWindow: () => askWindow,
      ask: runAskOnce,
      // 在途提问信号：任务到点靠它让位（先接用户、再提任务）
      onActiveChange: (active) => {
        askBusy = active
      },
      // 本地命令（M1/M2/M3/M5）：/help /log /new /use /del /backup /compact /mode /tool
      // 桌面与 QQ 共用同一个 command（M5），所以 /use 在 QQ 里切了，桌面这条鱼也跟着切
      command,
      // 模式（D72）：界面启动 / 每条结果后刷新模式条
      mode: () => currentModeState({ repo: memoryRepo, lineageFile }),
      // 「还要继续查吗」→ 恢复暂停的循环（问题用检查点里的原话，续查通道不再传）
      resume: async (resumeId, decision, context) => {
        prepareAskUploads(context)
        const db = connections.queryDb()
        if (!db) {
          return {
            kind: 'no-evidence',
            stats: { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
          }
        }
        const state = await askStateNow()
        const mode = state?.mode ?? fallbackMode
        const life = state?.life
        const momLetter = await momLetterFor(life)
        const gate = await lifeGateNow()
        const result = await askChain(
          {
            ...askOptionsFor(
              db,
              context,
              mode,
              await askOpeningFor(db, '', context, mode, undefined, life?.bornDay),
              life,
              momLetter,
              state?.unreadLetters
            ),
            resume: { id: resumeId, decision }
          },
          ''
        )
        // 续查收尾也算「这一问结束」：生命早就耗尽的话，这里把兜底传承跑掉（D97）
        return withInheritance(gate, result)
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
      record: async (question, result, conversationId, imagePath, attachments) => {
        appendAskHistory(
          askHistoryPath,
          toHistoryEntry(
            question,
            result,
            Date.now(),
            conversationId,
            imagePath,
            attachments,
            await activeBranchNow()
          )
        )
      },
      // 选区问答：历史里的截图路径 → data URL（渲染层读不了文件；只认 ask-shots 下的文件）
      image: (path) => {
        const root = app.getPath('userData')
        return isAskShotPath(root, path) ? readAskShotDataUrl(path) : null
      },
      conversationHistory: conversationHistoryFor,
      history: () => readAskHistory(askHistoryPath),
      clearHistory: async () => {
        // 清空是破坏性操作：先从 git 留一份（失败也照清，只是少了这层保险）
        const committed = await memoryRepo.commit('memory: 清空问答历史前')
        if (committed.reason === 'failed') captureLog('warn', 'memory pre-clear commit failed', {})
        clearAskHistory(askHistoryPath)
        // 问答历史清了，只追加的会话也不能留着旧的（否则下一问会「记得」已删的对话）
        askConversations.clear()
      },
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
      // 记忆仓（D90）：远端绑定 + 推送状态 + 定时。地址写进仓的 git 配置，间隔进设置表；
      // 保存成功后立刻按新间隔重挂定时器（不重启应用）
      memoryRepo: () => {
        const db = connections.queryDb()
        if (db === null) return Promise.resolve({ error: 'db-unavailable' })
        return buildMemoryRepoSettingsView({ db, pushState: () => memoryRepo.pushState() })
      },
      saveMemoryRepo: async (patch) => {
        const writable = connections.ensureWritable().db
        if (writable === null) return { ok: false, error: '数据库暂不可用，设置没有保存' }
        const saved = await applyMemoryRepoPatch(
          { db: writable, setRemote: (url) => memoryRepo.setRemote(url) },
          patch
        )
        if (!saved.ok) return { ok: false, error: saved.message ?? '保存失败' }
        applyMemorySchedule()
        const db = connections.queryDb()
        if (db === null) return { ok: true }
        return {
          ok: true,
          view: await buildMemoryRepoSettingsView({ db, pushState: () => memoryRepo.pushState() })
        }
      },
      pushMemoryRepo: async () => {
        const result = await memoryRepo.push()
        const db = connections.queryDb()
        const view =
          db === null
            ? undefined
            : await buildMemoryRepoSettingsView({ db, pushState: () => memoryRepo.pushState() })
        if (result.ok) return view === undefined ? { ok: true } : { ok: true, view }
        const error =
          result.reason === 'no-remote'
            ? '还没绑定仓库地址'
            : result.reason === 'unavailable'
              ? '记忆仓不可用'
              : '推送失败（网络 / 凭据），细节看日志'
        return view === undefined ? { ok: false, error } : { ok: false, error, view }
      },
      // 设置抽屉「任务」（自调用 v0.2 §12.1）：只读视图 + 暂停 / 继续 / 取消。
      // 运行时还没起来（没采集过 / 没迁到 v11）就如实报不可用，不建库。
      tasksAdmin: () => taskRuntime?.admin() ?? { available: false, total: 0, tasks: [], running: null },
      taskAction: ({ id, action }) => {
        if (taskRuntime === null) {
          return { ok: false, message: '任务库还没起来（重启后再试）。' }
        }
        try {
          const result =
            action === 'cancel'
              ? taskRuntime.port.cancel(id)
              : taskRuntime.port.setState(id, action === 'pause' ? 'paused' : 'active')
          return { ok: result.ok, message: result.message, view: taskRuntime.admin() }
        } catch (error) {
          captureLog('warn', 'task admin action failed', { id, action, error: String(error) })
          return { ok: false, message: '任务库暂时不可用（重启后再试）。' }
        }
      },
      // 抽屉里新建 / 编辑任务：新建一律算共建计划（origin=user，走 Obsidian 计划区同步）；
      // 编辑保留原来源（自主任务不碰用户日记）。语义校验仍由任务端口做。
      taskSave: (input: TaskAdminSaveInput) => {
        if (taskRuntime === null) {
          return { ok: false, message: '任务库还没起来（重启后再试）。' }
        }
        try {
          const yearly =
            input.yearlyMonth == null || input.yearlyDay == null
              ? {}
              : { yearlyMonth: input.yearlyMonth, yearlyDay: input.yearlyDay }
          const outcome =
            input.id === undefined
              ? taskRuntime.port.schedule({
                  instruction: input.instruction,
                  when: input.when,
                  repeat: input.repeat,
                  ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }),
                  ...(input.monthDays === undefined ? {} : { monthDays: input.monthDays }),
                  ...yearly,
                  origin: 'user',
                  delivery: input.delivery,
                  validUntil: input.validUntil
                })
              : taskRuntime.port.update({
                  id: input.id,
                  instruction: input.instruction,
                  when: input.when,
                  repeat: input.repeat,
                  ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }),
                  ...(input.monthDays === undefined ? {} : { monthDays: input.monthDays }),
                  ...yearly,
                  delivery: input.delivery,
                  validUntil: input.validUntil
                })
          return { ok: outcome.ok, message: outcome.message, view: taskRuntime.admin() }
        } catch (error) {
          captureLog('warn', 'task admin save failed', { error: String(error) })
          return { ok: false, message: '任务库暂时不可用（重启后再试）。' }
        }
      },
      // 设置抽屉「小本本」（自调用 v0.2 §7）：四分区查看 / 按编号删除。
      // 只动记忆仓里的 notebook.md，不碰用户 Obsidian 日记。
      notebookAdmin: () => notebookStore.view(),
      notebookRemove: (id) => {
        const result = notebookStore.update({ action: 'remove', id })
        return { ok: result.ok, message: result.message, view: notebookStore.view() }
      },
      notebookUpdate: ({ id, text }) => {
        const result = notebookStore.update({ action: 'revise', id, text })
        return { ok: result.ok, message: result.message, view: notebookStore.view() }
      },
      // 设置抽屉「成长档案」（自调用 v0.2 §8）：四类各自翻页 + 点开一篇看全文。只读。
      growthPage: (kind, page) => growthStore.page(kind, page),
      growthEntry: (key) => growthStore.entry(key),
      // 抽屉顶端那句提示（2026-11-01）：检出分支不是这一代主线时，「今晚不会写」
      growthStatus: async () => {
        const line = await mainlineNow()
        return {
          ok: line.ok,
          branch: line.branch,
          main: line.main,
          isMainline: line.ok && line.main !== null && line.main === line.branch
        }
      },
      // 人格卡（D62）：导入即启用；写卡不碰库，启用卡要写 settings（回答中拒绝开写连接）
      savePersonaCard: (name, text) => {
        const root = app.getPath('userData')
        const saved = savePersonaCard(root, name, text)
        if (!saved.ok) return { ok: false, error: saved.error }
        try {
          const db = connections.ensureWritable().db
          ensureChainSchema(db)
          setSetting(db, 'memory.persona_card', saved.name)
          return { ok: true, view: buildMemorySettingsView(db, { userDataDir: root }) }
        } catch (error) {
          captureLog('warn', 'persona card activate failed', { error: String(error) })
          return { ok: false, error: '卡片已保存，但没能切换过去（数据库暂不可用）' }
        }
      },
      readPersonaCard: (name) => readPersonaCard(app.getPath('userData'), name),
      openPersonaCardDir: () => {
        const dir = personaCardDir(app.getPath('userData'))
        try {
          mkdirSync(dir, { recursive: true })
          void shell.openPath(dir)
          return true
        } catch (error) {
          captureLog('warn', 'persona card dir open failed', { error: String(error) })
          return false
        }
      },
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
      qqSettings: readQqSettings,
      saveQqSettings,
      qqStickers: () => {
        if (qqStickers === null) return { error: 'stickers-unavailable' }
        try {
          return buildQqStickerListView(qqStickers)
        } catch (error) {
          captureLog('warn', 'qq stickers read failed', { error: String(error) })
          return { error: 'stickers-read-failed' }
        }
      },
      qqStickerImport,
      qqStickerUpdate,
      qqStickerTrash: (input) => qqStickerMove(input, 'trash'),
      qqStickerRestore: (input) => qqStickerMove(input, 'library'),
      qqStickerRemove,
      qqChatLogClear,
      qqNapcatStatus: () =>
        qqNapcat?.status() ?? { phase: 'idle', installed: false, autoStart: true, loggedIn: false },
      qqNapcatStart: () => qqNapcat?.start() ?? Promise.resolve({ ok: false, error: 'NapCat 未初始化' }),
      qqNapcatStop: async () => {
        await qqNapcat?.stop()
      },
      qqNapcatInstall: () =>
        qqNapcat?.install() ?? Promise.resolve({ ok: false, error: 'NapCat 未初始化' }),
      qqNapcatChooseDir: async () => {
        const owner = askWindow ?? mainWindow
        const picked =
          owner !== null
            ? await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })
            : await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (picked.canceled || picked.filePaths.length === 0) {
          return { ok: false, error: '没有选择目录' }
        }
        const saved = await qqNapcat?.setShellDir(picked.filePaths[0])
        if (saved === undefined) return { ok: false, error: 'NapCat 未初始化' }
        if (!saved.ok) return { ok: false, error: saved.error ?? '目录不可用' }
        return { ok: true, view: qqNapcat?.status() }
      },
      log: (level, message, data) => captureLog(level, message, data)
    })

    // QQ 通道（D63）：启动时按设置起停（默认关闭 → 不占端口，不产生任何网络行为）
    void refreshQqChannel()

    /**
     * 任务运行时（自调用 v0.2 §9）：任务库独立写连接 + 到点调度器。
     *
     * 到点走 `runAskOnce`（与桌面提问同一条通道）：
     * - 用户正在问 → 让位，2 分钟后再看（先接用户、再提任务）；
     * - 否则跑一轮，结果记进当前会话历史，并通知问记忆窗口刷新（窗口开着就能看到）。
     * 模型自己决定开口 / 延后 / 静默：它拿到的是「到点的事」那条事实，不是逐字文案。
     */
    taskRuntime = createTaskRuntime({
      dbPath: join(app.getPath('userData'), DB_FILE_NAME),
      vaultDir: () => resolveVaultDir(connections.queryDb()),
      backupDir: () => join(app.getPath('userData'), 'diary-backups'),
      // 缺当天笔记就自动建（设置 memory.auto_daily_note，默认开）
      autoCreateNote: () => {
        const db = connections.queryDb()
        return db === null ? true : getSetting(db, 'memory.auto_daily_note') !== '0'
      },
      log: (level, message, data) => captureLog(level, message, data),
      deliver: async (task) => {
        const at = Date.now()
        // 用户优先：他正在说话，这一条等两分钟再来（合流，不并发说两份）
        if (askBusy) return { nextDueAt: at + 2 * 60 * 1000 }
        // 成长档案（2026-11-01 拍板）：只有**主线**写日记 / 周记 / 月末 / 年终。
        // 检出分支不是这一代的主线就跳过这次：不切分支、也不把这一条的日记写进别人的分支；
        // 返回 undefined = 按默认规则结算（每天那条顺延到下一周期，一次性那条这次就算了）。
        if (isGrowthWritingTask(task)) {
          const line = await mainlineNow()
          if (line.ok && line.main !== null && line.main !== line.branch) {
            captureLog('warn', 'growth writing skipped: not mainline', {
              id: task.id,
              branch: line.branch,
              main: line.main
            })
            return undefined
          }
        }
        // 后台交付（成长档案写作）：不开口、不进用户问答历史；只把真实结果留在记忆仓。
        // 前台 / auto 仍然走同一条通道，说完记进历史并通知窗口重画。
        const quiet = task.delivery === 'background'
        const conversationId = lastAskConversationId ?? `c${at.toString(36)}`
        const history = await conversationHistoryFor(conversationId)
        const controller = new AbortController()
        const result = await runAskOnce(task.instruction, {
          conversationId,
          history,
          signal: controller.signal
        })
        if (result.kind === 'error') {
          captureLog('warn', 'task deliver failed', { id: task.id, reason: result.reason })
          // 退避重试，但**不动** next_due_at：重复任务的钟点由用户/规则定，失败不能把它推走
          return { retryIn: 10 * 60 * 1000 }
        }
        if (!quiet) {
          try {
            appendAskHistory(
              askHistoryPath,
              toHistoryEntry(
                task.instruction,
                result,
                Date.now(),
                conversationId,
                undefined,
                undefined,
                await activeBranchNow()
              )
            )
          } catch (error) {
            captureLog('warn', 'task history record failed', { error: String(error) })
          }
          if (askWindow !== null && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:task-said', { conversationId })
          }
        }
        // 前台任务同时推一份到 QQ（2026-11-01 拍板 D93）：窗口没开时手机上也能看到。
        // 后台任务（写日记 / 周记那类）绝不推；通道没开 / 白名单空只记日志，不重试（重试会重复提醒）。
        if (!quiet && qqChannel !== null) {
          void qqChannel
            .push(formatAskResult(result))
            .then((pushed) => {
              if (!pushed.sent) {
                captureLog('warn', 'qq push skipped', {
                  id: task.id,
                  reason: pushed.reason ?? ''
                })
              }
            })
            .catch((error) => {
              captureLog('warn', 'qq push failed', { id: task.id, error: String(error) })
            })
        }
        // 成长档案（自调用 v0.2 §8）：一层写完串下一篇——
        // 日记 →（周日）周记 →（月末）月末总结 →（年末）年终总结；一次只做一件，每步 +2 分钟。
        if (task.id === growthDailyTaskId || isGrowthWritingTask(task)) {
          try {
            const at = Date.now()
            const scheduled =
              taskRuntime?.scheduleNextGrowthWriting({
                weekly: growthStore.hasEntry('weekly', at),
                monthly: growthStore.hasEntry('monthly', at),
                yearly: growthStore.hasEntry('yearly', at)
              }) ?? null
            if (scheduled !== null) {
              captureLog('info', 'growth writing scheduled', { id: scheduled })
            }
          } catch (error) {
            captureLog('warn', 'growth writing schedule failed', { error: String(error) })
          }
        }
        return {}
      }
    })
    taskRuntime.start()
    // 成长档案（§8）：播种「每天写日记」的自主任务（幂等；取消过不复活）
    growthDailyTaskId = taskRuntime.seedGrowthTask()
    if (growthDailyTaskId !== null) {
      captureLog('info', 'growth daily task ready', { id: growthDailyTaskId })
    }

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

