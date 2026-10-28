/**
 * 持久屏幕捕获（m1a-plan §3 Phase 2b）
 *
 * 背景：`desktopCapturer.getSources` 在本机单次 1.2–2.3s，且会同步阻塞主进程 UI 线程，
 * 每 2s 采一次 → 鼠标悬停/滚动被冻结 1–2s（2026-10-21 真机实测，见 gotchas.md）。
 *
 * 方案：一个隐藏窗口常驻 `getDisplayMedia` 屏幕流；主进程只在启动时取一次
 * desktopCapturer 源列表做「显示器 → 源」映射，之后每帧通过 executeJavaScript
 * 让隐藏窗口裁剪 / 放大 / 编码 PNG，结果以二进制回传。主进程只剩写文件与 dHash。
 */

import { BrowserWindow, desktopCapturer, session, screen } from 'electron'
import type { Display } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCaptureFrameRequest } from './display-media'
import { captureTargetSize, type CaptureTargetOptions } from './ocr-scaling'
import {
  computeCaptureGeometry,
  DIFF_HEIGHT,
  DIFF_WIDTH,
  findDisplayForPhysicalPoint,
  type CapturedFrame,
  type CaptureGeometry,
  type DisplayInfo
} from './screen'
import type { WindowBounds } from './window-meta'

interface ScreenSource {
  id: string
  name: string
  displayId: number
}

interface StreamInfo {
  displayId: number
  width: number
  height: number
}

interface GrabResult {
  image: Uint8Array
  ocrPng?: Uint8Array
  /** 90x80 灰度 dHash（16 位十六进制字符串；在渲染端算，主进程不再解像素） */
  hash: string
  width: number
  height: number
}

/** 渲染端「只回指纹」的结果（不编码、不落盘） */
interface ProbeResult {
  hash: string
  width: number
  height: number
}

/** 一组抓帧参数：尺寸口径 + 编码格式 + 是否另出一张 OCR 用 PNG（信息链证据图用） */
export interface CaptureOptions extends CaptureTargetOptions {
  /** 主图格式，默认 png */
  format?: 'png' | 'jpeg'
  /** 同时出一张 2× PNG 给 OCR（证据图这条链路；旧管线不需要） */
  withOcrImage?: boolean
  /**
   * 画之前是否等一个新帧（默认 true）。判重前移后，探针刚刚等过新帧，
   * 紧接着的编码不必再等一次（静止画面下每次等会白耗 ~500ms）。
   */
  fresh?: boolean
}

export interface ScreenCaptureOptions {
  /** electron-vite dev 的 renderer 地址（生产为空，走 htmlPath） */
  devServerUrl?: string
  /** 生产构建下 capture.html 的绝对路径 */
  htmlPath: string
}

const START_TIMEOUT_MS = 20_000
const GRAB_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function expectedDisplaySize(display: DisplayInfo): { width: number; height: number } {
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor)
  }
}

function toDisplayInfo(display: Display): DisplayInfo {
  return { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor }
}

/**
 * 渲染端回传的 dHash（16 位十六进制）。校验失败就抛错——指纹是判重的唯一依据，
 * 宁可这一帧算抓帧失败，也不能拿一个坏指纹去比（会把「变了」误判成「没变」）。
 */
export function parseDiffHash(value: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,16}$/.test(value)) {
    throw new Error('采集窗口返回的帧差指纹非法')
  }
  return BigInt(value)
}

export class ScreenCapture {
  private win: BrowserWindow | null = null
  private sources: ScreenSource[] | null = null
  private pendingSource: ScreenSource | null = null
  private stream: StreamInfo | null = null
  private starting: Promise<StreamInfo> | null = null
  private handlerInstalled = false

  constructor(private readonly options: ScreenCaptureOptions) {}

  async start(): Promise<void> {
    this.installDisplayMediaHandler()
    const win = new BrowserWindow({
      show: false,
      width: 240,
      height: 180,
      title: 'Gotcha 采集',
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: true
      }
    })
    this.win = win
    if (this.options.devServerUrl) {
      await win.loadURL(`${this.options.devServerUrl}/capture.html`)
    } else {
      await win.loadFile(this.options.htmlPath)
    }
    await this.ensureStream(toDisplayInfo(screen.getPrimaryDisplay()))
  }

  /**
   * 抓当前前台窗口区域；失败抛错由管线计 capture_errors。
   *
   * `options` 决定三件事（默认全走旧口径，旧管线行为不变）：
   * - 尺寸：不传 = OCR 的 2× / 封顶 3840；证据图传 `{ upscale: 1, maxWidth: 1920 }`；
   * - 格式：默认 PNG；证据图传 `format: 'jpeg'`——采集即编码，主进程只写字节、不解码不重编码；
   * - `withOcrImage`：同一帧再出一张 2× PNG 给 OCR（UIA 文本不足时兜底用，卡内删除）；
   * - `fresh`：画之前是否等新帧（默认等；判重前移后，紧跟探针的编码传 false）。
   */
  async capture(
    bounds: WindowBounds,
    tempDir: string,
    ts: number,
    options: CaptureOptions = {}
  ): Promise<CapturedFrame> {
    const target: CaptureTargetOptions = { upscale: options.upscale, maxWidth: options.maxWidth }
    const result = await this.withStream(bounds, target, (geometry) => this.grab(geometry, options))

    const ext = options.format === 'jpeg' ? 'jpg' : 'png'
    const imagePath = join(tempDir, `frame-${ts}.${ext}`)
    writeFileSync(imagePath, Buffer.from(result.image))

    let ocrPath: string | undefined
    if (result.ocrPng) {
      ocrPath = join(tempDir, `ocr-${ts}.png`)
      writeFileSync(ocrPath, Buffer.from(result.ocrPng))
    }

    return {
      imagePath,
      width: result.width,
      height: result.height,
      diffHash: parseDiffHash(result.hash),
      bytes: result.image.byteLength + (result.ocrPng?.byteLength ?? 0),
      ocrPath
    }
  }

  /**
   * 只探测「这一帧变了没有」：画到 90x80 灰度、算 dHash 回主进程，**不编码、不落盘**。
   *
   * 判重前移（性能方案 P0-1）：每 2 s 的 tick 先调它，未变帧连 PNG 都不产生；
   * 只有变了才 `capture()` 真编码。`crop` 与 `capture()` 完全同一套几何计算，
   * 指纹口径（90x80 + 同一份 dHash）也一致，所以不会「探测说变了、编码后又说没变」。
   */
  async probe(bounds: WindowBounds): Promise<{ diffHash: bigint }> {
    const diff = { width: DIFF_WIDTH, height: DIFF_HEIGHT }
    const result = await this.withStream(bounds, {}, (geometry) =>
      this.callRenderer<ProbeResult>(
        `window.__gotchaCapture.probe(${JSON.stringify({ crop: geometry.crop, diff })})`,
        GRAB_TIMEOUT_MS
      )
    )
    return { diffHash: parseDiffHash(result.hash) }
  }

  /**
   * 同一套「流可能已结束（锁屏 / 显示切换）→ 重建一次」的重试逻辑：
   * probe 与 capture 共用，免得两处几何计算 / 重建口径漂移。
   */
  private async withStream<T>(
    bounds: WindowBounds,
    target: CaptureTargetOptions,
    run: (geometry: CaptureGeometry) => Promise<T>
  ): Promise<T> {
    const display = this.displayFor(bounds)
    let info = await this.ensureStream(display)
    let geometry = computeCaptureGeometry(bounds, display, info, undefined, target)
    try {
      return await run(geometry)
    } catch {
      this.stream = null
      info = await this.ensureStream(display)
      geometry = computeCaptureGeometry(bounds, display, info, undefined, target)
      return await run(geometry)
    }
  }

  dispose(): void {
    const win = this.win
    this.win = null
    this.stream = null
    this.starting = null
    this.pendingSource = null
    if (win && !win.isDestroyed()) win.destroy()
    if (this.handlerInstalled) {
      session.defaultSession.setDisplayMediaRequestHandler(null)
      this.handlerInstalled = false
    }
  }

  private displayFor(bounds: WindowBounds): DisplayInfo {
    const displays = screen.getAllDisplays().map(toDisplayInfo)
    const primary = toDisplayInfo(screen.getPrimaryDisplay())
    return findDisplayForPhysicalPoint(displays, primary, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2
    })
  }

  private installDisplayMediaHandler(): void {
    if (this.handlerInstalled) return
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        // 只接受采集窗口自己的主 frame（F08）：defaultSession 是共享的，
        // 仅凭 pendingSource 放行等于假设「只有采集窗口会请求录屏」
        const win = this.win
        const captureFrame = win && !win.isDestroyed() ? win.webContents.mainFrame : null
        if (!isCaptureFrameRequest(request, captureFrame)) {
          callback(null)
          return
        }
        const source = this.pendingSource
        if (source) {
          callback({ video: { id: source.id, name: source.name } })
          return
        }
        callback(null)
      },
      { useSystemPicker: false }
    )
    this.handlerInstalled = true
  }

  private async listSources(): Promise<ScreenSource[]> {
    if (this.sources) return this.sources
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    })
    this.sources = sources.map((source) => ({
      id: source.id,
      name: source.name,
      displayId: Number(source.display_id)
    }))
    return this.sources
  }

  private async sourceForDisplay(displayId: number): Promise<ScreenSource | null> {
    let sources = await this.listSources()
    let source = sources.find((item) => item.displayId === displayId)
    if (!source) {
      // 新插拔/分辨率变更后 display_id 可能变化，刷新一次
      this.sources = null
      sources = await this.listSources()
      source = sources.find((item) => item.displayId === displayId)
    }
    return source ?? sources[0] ?? null
  }

  private async ensureStream(display: DisplayInfo): Promise<StreamInfo> {
    if (this.stream?.displayId === display.id) return this.stream
    if (this.starting) {
      const inFlight = await this.starting
      if (inFlight.displayId === display.id) return inFlight
    }
    const run = this.startStream(display)
    this.starting = run
    try {
      const info = await run
      this.stream = info
      return info
    } finally {
      if (this.starting === run) this.starting = null
    }
  }

  private async startStream(display: DisplayInfo): Promise<StreamInfo> {
    const source = await this.sourceForDisplay(display.id)
    if (!source) throw new Error('没有可用的屏幕捕获源')
    this.pendingSource = source
    try {
      const size = await this.callRenderer<{ width: number; height: number }>(
        'window.__gotchaCapture.start(true)',
        START_TIMEOUT_MS
      )
      const expected = expectedDisplaySize(display)
      // Chromium 偶发把流缩到别的分辨率；按比例换算即可，不因此判失败
      return {
        displayId: display.id,
        width: size.width > 0 ? size.width : expected.width,
        height: size.height > 0 ? size.height : expected.height
      }
    } finally {
      this.pendingSource = null
    }
  }

  private async grab(geometry: CaptureGeometry, options: CaptureOptions = {}): Promise<GrabResult> {
    // OCR 那张按旧口径（2×）单独算：证据图本身不放大，OCR 仍要 2× 的字号
    const ocrTarget = options.withOcrImage
      ? captureTargetSize(geometry.crop.width, geometry.crop.height)
      : undefined
    const payload = JSON.stringify({
      crop: geometry.crop,
      target: geometry.target,
      format: options.format ?? 'png',
      ocrTarget,
      diff: { width: DIFF_WIDTH, height: DIFF_HEIGHT },
      // 判重前移后，探针刚刚等过新帧：紧跟的编码不必再等一次（默认 true，证据图口径不变）
      fresh: options.fresh !== false
    })
    return await this.callRenderer<GrabResult>(
      `window.__gotchaCapture.grab(${payload})`,
      GRAB_TIMEOUT_MS
    )
  }

  private async callRenderer<T>(expression: string, timeoutMs: number): Promise<T> {
    const win = this.win
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error('采集窗口不可用')
    }
    return await withTimeout(
      win.webContents.executeJavaScript(expression, true) as Promise<T>,
      timeoutMs,
      `采集窗口响应超时（${timeoutMs}ms）`
    )
  }
}
