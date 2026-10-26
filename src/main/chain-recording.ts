/**
 * 信息链 · 接进应用启动（D42）
 *
 * 把三样东西装到一起：**原生事件源**（`native/chain-hook`，加载失败就降级成「不采集」）、
 * **事件触发现抓一帧**（`chain-shot.ts`）、**运行时**（`chain/hook/runtime.ts`）。
 * 生命周期跟采集总开关走（`CaptureController` 的 running / stopping），不单独开一套开关：
 * 隐私红线只有一处（Alt+P / 托盘 / `--capture`），多一个开关就多一种「以为关了其实在记」。
 *
 * 这个文件依赖 Electron 之外的宿主能力（active-win / 屏幕流由调用方注入），
 * 因此可以在 Node 里单测；`index.ts` 只负责传真实的屏幕流与路径。
 */
import { activeWindow } from 'active-win'
import { join } from 'node:path'
import { isBlacklisted as defaultBlacklist, executableName, type WindowBounds } from '../capture/window-meta'
import type { ChainDb } from '../chain/store'
import { ChainRuntime } from '../chain/hook/runtime'
import { loadNativeBinding, nativeCandidates, NativeDesktopSource } from '../chain/hook/native'
import type { DesktopEventSource, SourceInfo } from '../chain/hook/types'
import type { ShotStats, ShotTaker } from '../chain/recorder'
import {
  createChainShotSource,
  type ChainShotFs,
  type ChainShotLog,
  type ChainShotScreen,
  type ChainShotWindow
} from './chain-shot'

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
}

export interface ChainRecordingStatus {
  started: boolean
  source: SourceInfo | null
  openSegmentId: number | null
  shots: ShotStats | null
}

export interface ChainRecordingHandle {
  start(): void
  /** 停源 + 收口开着的段 + 等在途截图落库；重复调用安全 */
  stop(): Promise<void>
  status(): ChainRecordingStatus
}

/**
 * 装配一条「采集真的在跑」的信息链。
 *
 * 注意：`stop()` 是异步的（要等在途截图）。**退出流程必须 await 它**，
 * 否则最后那张截图会丢（`ChainRuntime.stop()` 只负责关源与收口）。
 */
export function createChainRecording(options: ChainRecordingOptions): ChainRecordingHandle {
  const log: ChainShotLog = options.log ?? (() => {})
  const source = options.source
  let runtime: ChainRuntime | null = null
  let stopping: Promise<void> | null = null

  const takeShot: ShotTaker | null = options.screen
    ? createChainShotSource({
        db: options.db,
        shotsDir: join(options.userDataDir, 'chain-shots'),
        tempDir: join(options.userDataDir, 'tmp-chain'),
        screen: options.screen,
        getWindow: options.getWindow ?? readForegroundWindow,
        isBlacklisted: options.isBlacklisted ?? ((executable) => defaultBlacklist(executable)),
        log,
        fs: options.fs
      })
    : null

  const start = (): void => {
    if (runtime) return
    if (!source) {
      log('warn', 'chain recording skipped: no event source')
      return
    }
    const info: SourceInfo = source.sourceInfo ?? { kind: 'fake' }
    const next = new ChainRuntime({
      db: options.db,
      source,
      takeShot: takeShot ?? undefined,
      now: options.now,
      sourceInfo: info
    })
    next.start()
    runtime = next
    log('info', 'chain recording started', {
      source: info.kind,
      detail: info.detail ?? null,
      shots: takeShot !== null
    })
  }

  const stop = (): Promise<void> => {
    if (stopping) return stopping
    const current = runtime
    if (!current) return Promise.resolve()
    runtime = null
    stopping = (async () => {
      current.stop()
      await current.drain()
      const stats = current.stats
      log('info', 'chain recording stopped', {
        openSegmentId: stats.openSegmentId,
        shots: stats.shotStats
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
      const current = runtime
      const shots = current?.stats
      return {
        started: current?.stats.started ?? false,
        source: source?.sourceInfo ?? null,
        openSegmentId: shots?.openSegmentId ?? null,
        shots: shots?.shotStats ?? null
      }
    }
  }
}
