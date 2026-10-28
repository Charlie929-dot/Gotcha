/**
 * 选区截图 · 系统级抓帧（`native/screen-grab`，Windows.Graphics.Capture）
 *
 * 三条纪律（与 `src/chain/hook/native.ts` 同一套）：
 * 1. **加载失败必须降级**：没编译 / Electron 升级 / 被杀软拦 → 返回 null，调用方退回
 *    Chromium 屏幕流（`ScreenCapture.captureDisplay`），不能让点球挂掉；
 * 2. **不信任原生层给的对象**：跨 ABI 边界回来的都是 `unknown`，逐字段校验后才用；
 * 3. **原生层只做管道**：抓哪块屏、失败怎么办，都在主进程这边决定。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const SCREEN_GRAB_MODULE_FILE = 'screen_grab.node'

/** 抓一帧最多等多久：WGC 正常 40–80ms，1.5s 还没帧就是出问题了 */
export const REGION_GRAB_TIMEOUT_MS = 1500

export interface ScreenGrabBinding {
  /** 抓物理像素点 (x, y) 所在显示器的一帧（物理尺寸、JPEG） */
  grabMonitor(x: number, y: number, timeoutMs?: number): unknown
  /** 只建缓存（D3D 设备 + item），不读像素 */
  warmup(x: number, y: number): boolean
  /** 一次 `SetWindowPos(HWND_TOPMOST)`；窗口失效返回 false */
  setTopmost(hwnd: bigint | number): boolean
  version?: string
}

/** 原生层的返回值（已校验） */
export interface GrabbedFrame {
  jpeg: Uint8Array
  width: number
  height: number
  /** 捕获边框是否关掉了（`IsBorderRequired(false)`；Win10 / 被拒为 false） */
  borderSuppressed: boolean
  cursorCaptured: boolean
}

const requireFromHere = createRequire(import.meta.url) as NodeRequire

/**
 * 候选路径：先开发构建（`native/screen-grab/build/Release`），再打包后的 `resources/native`，
 * 与 `chain_hook` 同一套布局。
 */
export function screenGrabCandidates(repoRoot: string, resourcesPath?: string): string[] {
  const candidates = [join(repoRoot, 'native', 'screen-grab', 'build', 'Release', SCREEN_GRAB_MODULE_FILE)]
  if (resourcesPath) candidates.push(join(resourcesPath, 'native', SCREEN_GRAB_MODULE_FILE))
  return candidates
}

export interface LoadScreenGrabOptions {
  candidates: string[]
  exists?: (path: string) => boolean
  load?: (path: string) => unknown
}

/** 加载原生抓帧模块；任何一个候选成功即可，否则返回 null（不抛错） */
export function loadScreenGrab(options: LoadScreenGrabOptions): ScreenGrabBinding | null {
  const exists = options.exists ?? existsSync
  const load = options.load ?? ((path: string) => requireFromHere(path))
  for (const candidate of options.candidates) {
    if (!exists(candidate)) continue
    try {
      const loaded = load(candidate)
      if (isScreenGrabBinding(loaded)) return loaded
    } catch {
      // 加载失败就试下一个候选：可能是给错了运行时（ABI / 平台）
    }
  }
  return null
}

export function isScreenGrabBinding(value: unknown): value is ScreenGrabBinding {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.grabMonitor === 'function' &&
    typeof record.setTopmost === 'function' &&
    typeof record.warmup === 'function'
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 校验原生层回来的帧：尺寸必须是正整数、jpeg 必须是非空 Buffer，否则当没抓到 */
export function parseGrabbedFrame(value: unknown): GrabbedFrame | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const width = record.width
  const height = record.height
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null
  const jpeg = record.jpeg
  if (!(jpeg instanceof Uint8Array) || jpeg.byteLength === 0) return null
  return {
    jpeg,
    width,
    height,
    borderSuppressed: record.borderSuppressed === true,
    cursorCaptured: record.cursorCaptured === true
  }
}

/**
 * 帧尺寸是否就是这块显示器的物理尺寸。
 *
 * `GraphicsCaptureItem` 是按 HMONITOR 取的，正常必然一致；留 2px 是给驱动取整的余量。
 * 不一致就**不用这一帧**（宁可退回屏幕流，也不拿错屏的图去裁剪）。
 */
export function frameMatchesDisplay(
  frame: { width: number; height: number },
  display: { bounds: { width: number; height: number }; scaleFactor: number },
  tolerance = 2
): boolean {
  const expectedWidth = Math.round(display.bounds.width * display.scaleFactor)
  const expectedHeight = Math.round(display.bounds.height * display.scaleFactor)
  if (expectedWidth <= 0 || expectedHeight <= 0) return false
  return (
    Math.abs(frame.width - expectedWidth) <= tolerance &&
    Math.abs(frame.height - expectedHeight) <= tolerance
  )
}

/* ------------------------------------------------------------------ */
/* 进程单例                                                            */
/* ------------------------------------------------------------------ */

let binding: ScreenGrabBinding | null | undefined

/**
 * 启动时调一次：按 `app.getAppPath()` / `process.resourcesPath` 找模块。
 * 返回 null 表示这台机器上没有可用的原生抓手（之后选区会退回屏幕流）。
 */
export function loadScreenGrabOnce(repoRoot: string, resourcesPath?: string): ScreenGrabBinding | null {
  if (binding === undefined) {
    binding = loadScreenGrab({ candidates: screenGrabCandidates(repoRoot, resourcesPath) })
  }
  return binding
}

/** 已加载的模块（没调过 `loadScreenGrabOnce` 或加载失败为 null） */
export function getScreenGrab(): ScreenGrabBinding | null {
  return binding ?? null
}

/** 测试用：重置单例 */
export function resetScreenGrabForTest(): void {
  binding = undefined
}
