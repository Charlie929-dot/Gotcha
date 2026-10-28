/**
 * 隐藏采集窗口（配合 Electron 持久屏幕捕获流，m1a-plan §3 Phase 2b）
 *
 * 为什么存在：`desktopCapturer.getSources` 在本机每次约 1.2–2.3s，且同步阻塞主进程 UI
 * 线程（实测见 gotchas.md「屏幕捕获阻塞主线程」）。改为常驻 `getDisplayMedia` 流后，
 * 主进程只在启动时调用一次 getSources 做显示映射，之后每帧只发一个跨进程请求，
 * 抓帧 / 缩放 / 编码全部在隐藏窗口的渲染进程完成，不再卡鼠标与滚动。
 *
 * 2026-10-28 判重前移（性能方案 P0-1）：新增 `probe()`——只画到 90×80、算 dHash 就回，
 * **不 convertToBlob、不传像素**。主进程先 probe 判重，只有「变了」才 grab 真编码。
 * 旧顺序是「先编码 3–7 MB PNG 落盘，再判重」，实测 87% 的帧白编码白写。
 *
 * 本页面只做像素搬运，不读库、不写库、不对外通信。
 */

import { dHash, rgbaToGray } from '../capture/frame-diff'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface GrabRequest {
  crop: Rect
  target: { width: number; height: number }
  /** 主图编码格式：默认 png（旧管线 / OCR）；证据图传 jpeg（采集即编码，q85） */
  format?: 'png' | 'jpeg'
  /** 第二张图：给 OCR 的 2× PNG（只有证据图这条会要，省得主进程重现编码） */
  ocrTarget?: { width: number; height: number }
  diff: { width: number; height: number }
  /** 画之前是否等一个新帧（默认 true；紧跟 probe 的编码传 false，省一次 ~500ms 等待） */
  fresh?: boolean
}

interface GrabResponse {
  /** 主图字节（按 `format` 编码） */
  image: Uint8Array
  /** 第二张：OCR 用的 2× PNG（请求里没给 `ocrTarget` 就没有） */
  ocrPng?: Uint8Array
  /** 90x80 灰度 dHash（16 位十六进制，与 probe 同口径） */
  hash: string
  width: number
  height: number
}

/** 只回指纹的探测请求（不编码、不落盘） */
interface ProbeRequest {
  crop: Rect
  diff: { width: number; height: number }
}

interface ProbeResponse {
  hash: string
  width: number
  height: number
}

declare global {
  interface Window {
    __gotchaCapture: {
      start(): Promise<{ width: number; height: number }>
      grab(request: GrabRequest): Promise<GrabResponse>
      probe(request: ProbeRequest): Promise<ProbeResponse>
      stop(): void
    }
  }
}

let video: HTMLVideoElement | null = null

/**
 * draw 前等一个**新帧**。为什么：`drawImage(video)` 画的是「最近一次提交给合成器」的帧，
 * 流刚建立（首帧还没到）或低帧率下画面静止时，那一帧可能是旧帧——入场图就会闪旧内容
 * （render 层旧帧 Bug）。`requestVideoFrameCallback` 只在新帧提交后触发，等它就是等新帧。
 *
 * 兜底纪律：rVFC 不可用、或 ~500ms 超时（静止画面编码器不发帧）就照旧画——
 * 宁可偶尔旧帧，不可抓帧失败（失败会触发流重建，代价更大）。
 */
async function waitForFreshFrame(el: HTMLVideoElement, timeoutMs = 500): Promise<void> {
  // 老环境（rVFC 未实现）运行时探测：类型上非可选，实际未必有
  if (typeof el.requestVideoFrameCallback !== 'function') return
  await new Promise<void>((resolve) => {
    let settled = false
    let handle: number | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (handle !== undefined) el.cancelVideoFrameCallback?.(handle)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    handle = el.requestVideoFrameCallback(() => finish())
  })
}

function liveTrack(el: HTMLVideoElement): MediaStreamTrack | null {
  const stream = el.srcObject as MediaStream | null
  return stream?.getVideoTracks().find((track) => track.readyState === 'live') ?? null
}

function stop(): void {
  const el = video
  video = null
  if (!el) return
  const stream = el.srcObject as MediaStream | null
  stream?.getTracks().forEach((track) => track.stop())
  el.srcObject = null
}

async function start(restart = false): Promise<{ width: number; height: number }> {
  if (restart) stop()
  if (video && liveTrack(video) && video.videoWidth > 0) {
    return { width: video.videoWidth, height: video.videoHeight }
  }
  stop()

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 2, max: 4 } },
    audio: false
  })
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.srcObject = stream
  try {
    await el.play()
    for (let i = 0; i < 40 && (el.videoWidth === 0 || el.videoHeight === 0); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (el.videoWidth === 0 || el.videoHeight === 0) {
      throw new Error('屏幕捕获流未就绪')
    }
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    throw error
  }
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (video === el) stop()
  })
  video = el
  return { width: el.videoWidth, height: el.videoHeight }
}

function isFiniteRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  )
}

function assertRect(rect: Rect): void {
  if (!isFiniteRect(rect) || rect.width <= 0 || rect.height <= 0) {
    throw new RangeError('截取区域非法')
  }
}

function assertSize(size: { width: number; height: number }, label: string): void {
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new RangeError(`${label}非法`)
  }
}

function draw(
  el: HTMLVideoElement,
  crop: Rect,
  width: number,
  height: number
): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2d 不可用')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(el, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height)
  return ctx
}

/**
 * 90×80 灰度 → dHash → 16 位十六进制。probe 与 grab **共用这一份**，
 * 判重口径才不会因为两处画法不同而漂移。
 */
function hashOf(ctx: OffscreenCanvasRenderingContext2D, diff: { width: number; height: number }): string {
  const data = ctx.getImageData(0, 0, diff.width, diff.height).data
  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const gray = rgbaToGray(rgba, diff.width, diff.height)
  return `0x${dHash(gray, diff.width, diff.height).toString(16).padStart(16, '0')}`
}

/** 采集流未就绪时的统一错误（调用方据此触发重建） */
function requireVideo(): HTMLVideoElement {
  const el = video
  if (!el || el.videoWidth === 0 || !liveTrack(el)) {
    throw new Error('屏幕捕获流未就绪')
  }
  return el
}

async function grab(request: GrabRequest): Promise<GrabResponse> {
  const el = requireVideo()
  const { crop, target, diff, format = 'png', ocrTarget, fresh = true } = request
  assertRect(crop)
  assertSize(target, '输出尺寸')
  assertSize(diff, '帧差尺寸')
  if (ocrTarget) assertSize(ocrTarget, 'OCR 输出尺寸')

  // 先等一个新帧再画：见 waitForFreshFrame 的注释（旧帧 Bug 的修法）。
  // 紧跟 probe 的编码传 fresh=false：探针刚刚等过新帧，再等一次只会白耗 500ms。
  if (fresh) await waitForFreshFrame(el)

  const main = draw(el, crop, target.width, target.height)
  const blob = await main.canvas.convertToBlob(
    format === 'jpeg' ? { type: 'image/jpeg', quality: 0.85 } : { type: 'image/png' }
  )
  const image = new Uint8Array(await blob.arrayBuffer())
  const small = draw(el, crop, diff.width, diff.height)
  const hash = hashOf(small, diff)

  let ocrPng: Uint8Array | undefined
  if (ocrTarget) {
    // 证据图这条：同一帧再画一张 2× PNG 给 OCR，主进程只写文件、不做像素工作
    const ocrCanvas = draw(el, crop, ocrTarget.width, ocrTarget.height)
    const ocrBlob = await ocrCanvas.canvas.convertToBlob({ type: 'image/png' })
    ocrPng = new Uint8Array(await ocrBlob.arrayBuffer())
  }

  return {
    image,
    ocrPng,
    hash,
    width: target.width,
    height: target.height
  }
}

/**
 * 只回指纹：画 90×80 → dHash，**不编码、不传图**（判重前移的落点）。
 * 主进程拿它和「已提交 / 在途」的指纹比，未变就不进入 grab。
 */
async function probe(request: ProbeRequest): Promise<ProbeResponse> {
  const el = requireVideo()
  const { crop, diff } = request
  assertRect(crop)
  assertSize(diff, '帧差尺寸')

  // 与 grab 同一条「等新帧」纪律：静止画面 500ms 超时后照旧画（低帧率下没有新帧可等）。
  await waitForFreshFrame(el)
  const small = draw(el, crop, diff.width, diff.height)
  return { hash: hashOf(small, diff), width: diff.width, height: diff.height }
}

window.__gotchaCapture = { start, grab, probe, stop }

export {}
