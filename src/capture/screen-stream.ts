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
import { dHash, rgbaToGray } from './frame-diff'
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
  diff: Uint8Array
  width: number
  height: number
}

/** 一组抓帧参数：尺寸口径 + 编码格式 + 是否另出一张 OCR 用 PNG（信息链证据图用） */
export interface CaptureOptions extends CaptureTargetOptions {
  /** 主图格式，默认 png */
  format?: 'png' | 'jpeg'
  /** 同时出一张 2× PNG 给 OCR（证据图这条链路；旧管线不需要） */
  withOcrImage?: boolean
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
   * - `withOcrImage`：同一帧再出一张 2× PNG 给 OCR（UIA 文本不足时兜底用，卡内删除）。
   */
  async capture(
    bounds: WindowBounds,
    tempDir: string,
    ts: number,
    options: CaptureOptions = {}
  ): Promise<CapturedFrame> {
    const display = this.displayFor(bounds)
    const target: CaptureTargetOptions = { upscale: options.upscale, maxWidth: options.maxWidth }
    let info = await this.ensureStream(display)
    let geometry = computeCaptureGeometry(bounds, display, info, undefined, target)
    let result: GrabResult
    try {
      result = await this.grab(geometry, options)
    } catch {
      // 流可能已结束（锁屏 / 显示切换）：丢弃流状态后重建一次
      this.stream = null
      info = await this.ensureStream(display)
      geometry = computeCaptureGeometry(bounds, display, info, undefined, target)
      result = await this.grab(geometry, options)
    }

    const ext = options.format === 'jpeg' ? 'jpg' : 'png'
    const imagePath = join(tempDir, `frame-${ts}.${ext}`)
    writeFileSync(imagePath, Buffer.from(result.image))

    let ocrPath: string | undefined
    if (result.ocrPng) {
      ocrPath = join(tempDir, `ocr-${ts}.png`)
      writeFileSync(ocrPath, Buffer.from(result.ocrPng))
    }

    const gray = rgbaToGray(new Uint8Array(result.diff), DIFF_WIDTH, DIFF_HEIGHT)
    const diffHash = dHash(gray, DIFF_WIDTH, DIFF_HEIGHT)
    return { imagePath, width: result.width, height: result.height, diffHash, ocrPath }
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
      diff: { width: DIFF_WIDTH, height: DIFF_HEIGHT }
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
