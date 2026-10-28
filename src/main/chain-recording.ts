/**
 * 信息链 · 接进应用启动（D42 / D43）
 *
 * 把这几样东西装到一起：**原生事件源**（`native/chain-hook`，加载失败就降级成「不采集」）、
 * **事件触发现抓一帧**（`chain-shot.ts`）、**内容来源**（UIA 优先、OCR 兜底，`chain-content.ts`）、
 * **运行时**（`chain/hook/runtime.ts`）。
 * 生命周期跟采集总开关走（`CaptureController` 的 running / stopping），不单独开一套开关：
 * 隐私红线只有一处（Alt+P / 托盘 / `--capture`），多一个开关就多一种「以为关了其实在记」。
 *
 * 这个文件依赖 Electron 之外的宿主能力（active-win / 屏幕流由调用方注入），
 * 因此可以在 Node 里单测；`index.ts` 只负责传真实的屏幕流、脚本路径与路径。
 */
import { activeWindow } from 'active-win'
import { join } from 'node:path'
import { isBlacklisted as defaultBlacklist, executableName, type WindowBounds } from '../capture/window-meta'
import type { ChainDb } from '../chain/store'
import { ChainRuntime } from '../chain/hook/runtime'
import { createCloudDeriveOutbound } from '../understand/cloud/derive-outbound'
import { loadNativeBinding, nativeCandidates, NativeDesktopSource } from '../chain/hook/native'
import type { DesktopEventSource, SourceInfo } from '../chain/hook/types'
import type { ShotStats, ShotTaker } from '../chain/recorder'
import {
  createChainContentCapture,
  createChainContentReader,
  type ChainContentCapture,
  type ChainContentReader,
  type ChainContentReaderOptions,
  type ChainContentStats
} from './chain-content'
import {
  createChainShotSource,
  type ChainShotFs,
  type ChainShotLog,
  type ChainShotScreen,
  type ChainShotWindow
} from './chain-shot'
import { createChainRetention, type ChainRetention, type ImageEncoder } from './chain-retention'
import {
  createChainEventMirror,
  type ChainEventMirror,
  type ChainEventMirrorStats
} from './chain-events'
import {
  ChainDeriver,
  type DeriveClientResolution,
  type DeriveStats
} from '../chain/derive/runner'
import type { Embedder } from '../understand/embedding/types'

/** 前台窗口（带 pid / hwnd：段身份对齐要用） */
export async function readForegroundWindow(): Promise<ChainShotWindow | null> {
  const win = await activeWindow()
  if (!win) return null
  const bounds: WindowBounds = {
    x: win.bounds.x,
    y: win.bounds.y,
    width: win.bounds.width,
    height: win.bounds.height
  }
  return {
    pid: win.owner.processId,
    hwnd: win.id,
    title: win.title,
    executable: executableName(win.owner.path),
    bounds
  }
}

/* ------------------------------------------------------------------ */
/* 原生事件源                                                          */
/* ------------------------------------------------------------------ */

export interface ChainSourceOptions {
  /** 开发态仓库根（`app.getAppPath()`） */
  repoRoot: string
  /** 打包后的 resources 目录（`process.resourcesPath`），可选 */
  resourcesPath?: string
  exists?: (path: string) => boolean
  load?: (path: string) => unknown
  log?: ChainShotLog
}

/**
 * 加载原生事件源。**加载不出来不抛错**（D41 第 1 条）：返回 null，由上层如实说「没有采集」。
 */
export function loadChainEventSource(options: ChainSourceOptions): DesktopEventSource | null {
  const candidates = nativeCandidates(options.repoRoot, options.resourcesPath)
  const binding = loadNativeBinding({
    candidates,
    exists: options.exists,
    load: options.load
  })
  if (!binding) {
    options.log?.('warn', 'chain hook not loaded: no usable native binding', { candidates })
    return null
  }
  return new NativeDesktopSource(binding)
}

/* ------------------------------------------------------------------ */
/* 内容来源装配（D43）                                                 */
/* ------------------------------------------------------------------ */

export interface ChainContentWiring extends ChainContentReaderOptions {
  /** 同段两次读数的最小间隔（默认 15s；换段后第一次必读） */
  minIntervalMs?: number
  /** 单测注入：整条读取链（绕过真实 PowerShell / OCR） */
  createReader?: () => ChainContentReader
}

/* ------------------------------------------------------------------ */
/* 采集装配                                                            */
/* ------------------------------------------------------------------ */

export interface ChainRecordingOptions {
  db: ChainDb
  /** 原生事件源；null = 没有可用钩子，不采集（连表都不建） */
  source: DesktopEventSource | null
  /** 屏幕流（`ScreenCapture`）；给了才会现抓截图 */
  screen?: ChainShotScreen
  userDataDir: string
  now?: () => number
  log?: ChainShotLog
  /** 黑名单判定（默认与旧管线同一份 `window-meta` 黑名单） */
  isBlacklisted?: (executable: string) => boolean
  /** 前台窗口读取（单测注入；默认 active-win） */
  getWindow?: () => Promise<ChainShotWindow | null>
  /** 文件操作注入点（单测用假的，生产用 fs） */
  fs?: ChainShotFs
  /** 内容来源（D43）；不给就只记事件与截图，不读文本 */
  content?: ChainContentWiring
  /**
   * 保留期分层（D44）。给编码器才会做：开采集时跑一轮（之后每 6h 一轮），
   * 把老证据重编码 / 打进归档容器。不给就完全不动文件（测试 / 假采集路径）。
   */
  retention?: { encode: ImageEncoder }
  /**
   * 派生层（v0.8 / D45）：向量 + 标签 / 双链（受出网确认门与每日预算约束）。
   * 不给就完全不派生；采集与证据照常。
   */
  derive?: {
    resolveClient: () => DeriveClientResolution
    readConsent: () => boolean
    loadEmbedder: () => Promise<Embedder | null>
  }
  /**
   * P0-2 第一阶段：把 `chain_content` 正文镜像成 `events` 行（时间线 / 时刻 / 主题的数据源）。
   * 不给就完全不镜像；采集、证据与检索照常。
   * `enabled` 在**每次起采集**时读一次（改开关后暂停 / 开始即生效，不必重启应用）。
   */
  eventsMirror?: { maxChars?: number; enabled?: () => boolean }
}

export interface ChainRecordingStatus {
  started: boolean
  source: SourceInfo | null
  openSegmentId: number | null
  shots: ShotStats | null
  content: ChainContentStats | null
  /** 派生层统计（没接线时为 null） */
  derive: DeriveStats | null
  /** events 镜像统计（没接线时为 null） */
  events: ChainEventMirrorStats | null
}

export interface ChainRecordingHandle {
  start(): void
  /** 停源 + 收口开着的段 + 等在途截图 / 内容落库；重复调用安全 */
  stop(): Promise<void>
  status(): ChainRecordingStatus
}

/** 内容车道收口的等待上限：退出流程只给信息链 2s，超时就如实记 warn（内容丢几条不阻塞退出） */
const CONTENT_DRAIN_TIMEOUT_MS = 2_000

/** 等 `task` 最多 `ms`；返回是否等到（超时 / 抛错都算没等到），绝不 reject */
function withinDeadline(task: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
    void task.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      }
    )
  })
}

interface ActiveChain {
  runtime: ChainRuntime
  content: ChainContentCapture | null
  /** 保留期扫描（D44）；没给编码器时为 null */
  retention: ChainRetention | null
  /** 派生层（v0.8）；没给配置时为 null */
  derive: ChainDeriver | null
  /** events 镜像（P0-2）；没给配置时为 null */
  mirror: ChainEventMirror | null
  /** 关掉读取链（杀 PowerShell 子进程；在途读数由 `content.drain()` 先等） */
  dispose(): Promise<void>
}

export function createChainRecording(options: ChainRecordingOptions): ChainRecordingHandle {
  const log: ChainShotLog = options.log ?? (() => {})
  const source = options.source
  let active: ActiveChain | null = null
  let stopping: Promise<void> | null = null
  /** 停掉之后的读数账（`status()` 在暂停后还要能看到刚收口的那一轮） */
  let lastContentStats: ChainContentStats | null = null
  /** 停掉之后的派生账（同样是「刚结束的那一轮」） */
  let lastDeriveStats: DeriveStats | null = null
  /** 停掉之后的镜像账 */
  let lastEventsStats: ChainEventMirrorStats | null = null

  const start = (): void => {
    if (active) return
    if (!source) {
      log('warn', 'chain recording skipped: no event source')
      return
    }
    const info: SourceInfo = source.sourceInfo ?? { kind: 'fake' }

    // 内容车道读回来时按段 id 补写；持有一个可变引用，收口期间仍能写完在途的那几条
    const holder: { runtime: ChainRuntime | null } = { runtime: null }
    let content: ChainContentCapture | null = null
    let contentReader: ChainContentReader | null = null
    if (options.content) {
      contentReader = options.content.createReader?.() ?? createChainContentReader({ ...options.content, log })
      content = createChainContentCapture({
        reader: contentReader,
        now: options.now,
        minIntervalMs: options.content.minIntervalMs,
        log,
        onContent: (segmentId, at, payload) => holder.runtime?.recordContentFor(segmentId, at, payload) ?? false
      })
    }

    const takeShot: ShotTaker | null = options.screen
      ? createChainShotSource({
          db: options.db,
          shotsDir: join(options.userDataDir, 'chain-shots'),
          tempDir: join(options.userDataDir, 'tmp-chain'),
          screen: options.screen,
          getWindow: options.getWindow ?? readForegroundWindow,
          isBlacklisted: options.isBlacklisted ?? ((executable) => defaultBlacklist(executable)),
          // 旁路：证据落定 → 内容车道（节流 / 串行都在车道里，不阻塞抓帧）
          onShot: (committed) => content?.onShot(committed),
          log,
          fs: options.fs
        })
      : null

    // 派生层（v0.8）：向量本地算，抽取受出网确认门 + 每日预算约束；跟采集生命周期走。
    // 载荷组装在核心，脱敏策略由这里（组合根）注入。
    const derive = options.derive
      ? new ChainDeriver({
          db: options.db,
          outbound: createCloudDeriveOutbound(),
          now: options.now,
          log,
          resolveClient: options.derive.resolveClient,
          readConsent: options.derive.readConsent,
          loadEmbedder: options.derive.loadEmbedder
        })
      : null
    // P0-2 第一阶段：内容落行后镜像一条 events（时间线 / 时刻 / 主题的数据源）。
    // 镜像失败只计数，不影响 chain_content 已落库。
    // `enabled` 每次起采集读一次：关掉镜像只要暂停再开始（回滚不用重启应用）。
    const mirrorEnabled = options.eventsMirror?.enabled?.() ?? options.eventsMirror !== undefined
    const mirror =
      options.eventsMirror && mirrorEnabled
        ? createChainEventMirror({
            db: options.db,
            maxChars: options.eventsMirror.maxChars,
            log
          })
        : null
    const runtime = new ChainRuntime({
      db: options.db,
      source,
      takeShot: takeShot ?? undefined,
      now: options.now,
      sourceInfo: info,
      // 派生层叫醒（v0.8）：收口 / 内容写入都只是「叫醒」，判断在派生执行器里
      onSegmentClosed: (segmentId) => derive?.notifySegmentClosed(segmentId),
      onContentWritten: (segmentId) => derive?.notifyContentWritten(segmentId),
      // P0-2：正文真正落行后镜像进 events（去重 / 空文本不会触发）
      onContentInserted: (segmentId, capturedAt, payload) =>
        void mirror?.onContent(segmentId, capturedAt, payload)
    })
    runtime.start()
    holder.runtime = runtime
    derive?.start()
    // 保留期（D44）：跟采集一起开——这时写连接才存在；暂停 / 退出就停表
    const retention = options.retention
      ? createChainRetention({
          db: options.db,
          shotsDir: join(options.userDataDir, 'chain-shots'),
          encode: options.retention.encode,
          now: options.now,
          log
        })
      : null
    retention?.start()
    active = {
      runtime,
      content,
      retention,
      derive,
      mirror,
      dispose: async () => {
        await contentReader?.dispose()
      }
    }
    log('info', 'chain recording started', {
      source: info.kind,
      detail: info.detail ?? null,
      shots: takeShot !== null,
      content: content !== null,
      derive: derive !== null,
      events: mirror !== null
    })
  }

  const stop = (): Promise<void> => {
    if (stopping) return stopping
    const current = active
    if (!current) return Promise.resolve()
    active = null
    stopping = (async () => {
      current.runtime.stop()
      // 派生层先收手：中止在途请求，结果丢弃（下一轮重试），不拖着退出
      current.derive?.stop()
      // 保留期扫描先收手：它只处理老文件，不阻塞退出（在途那几张会自己落定）
      current.retention?.stop()
      // 截图先收口：内容车道读的是这些证据，读完再放手
      await current.runtime.drain()
      if (current.content) {
        current.content.close()
        const drained = await withinDeadline(current.content.drain(), CONTENT_DRAIN_TIMEOUT_MS)
        if (!drained) {
          log('warn', 'chain content drain timed out', { ...current.content.stats })
        }
      }
      await current.dispose()
      lastContentStats = current.content?.stats ?? null
      lastDeriveStats = current.derive?.status() ?? null
      lastEventsStats = current.mirror?.stats ?? null
      const stats = current.runtime.stats
      log('info', 'chain recording stopped', {
        openSegmentId: stats.openSegmentId,
        shots: stats.shotStats,
        // 幽灵前台窗丢了多少次（v0.12）：稳定大于 0 才说明段机判据真的在拦
        phantomDropped: stats.phantomDropped,
        // 被瞬间抢焦点、没停满确认窗就丢掉的闪段（v0.14），同样只做观测
        flashDropped: stats.flashDropped,
        content: current.content?.stats ?? null,
        derive: lastDeriveStats,
        // P0-2：镜像写了几条 / 截断几条 / 因敏感跳了几条
        events: lastEventsStats
      })
    })().finally(() => {
      stopping = null
    })
    return stopping
  }

  return {
    start,
    stop,
    status: () => {
      const current = active
      const shots = current?.runtime.stats
      return {
        started: shots?.started ?? false,
        source: source?.sourceInfo ?? null,
        openSegmentId: shots?.openSegmentId ?? null,
        shots: shots?.shotStats ?? null,
        content: current?.content?.stats ?? lastContentStats,
        derive: current?.derive?.status() ?? lastDeriveStats,
        events: current?.mirror?.stats ?? lastEventsStats
      }
    }
  }
}
