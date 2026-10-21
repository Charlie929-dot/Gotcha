/**
 * 隐藏采集窗口（配合 Electron 持久屏幕捕获流，m1a-plan §3 Phase 2b）
 *
 * 为什么存在：`desktopCapturer.getSources` 在本机每次约 1.2–2.3s，且同步阻塞主进程 UI
 * 线程（实测见 gotchas.md「屏幕捕获阻塞主线程」）。改为常驻 `getDisplayMedia` 流后，
 * 主进程只在启动时调用一次 getSources 做显示映射，之后每帧只发一个跨进程请求，
 * 抓帧 / 缩放 / PNG 编码全部在隐藏窗口的渲染进程完成，不再卡鼠标与滚动。
 *
 * 本页面只做像素搬运，不读库、不写库、不对外通信。
 */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface GrabRequest {
  crop: Rect
  target: { width: number; height: number }
  diff: { width: number; height: number }
}

interface GrabResponse {
  png: Uint8Array
  diff: Uint8Array
  width: number
  height: number
}

declare global {
  interface Window {
    __gotchaCapture: {
      start(): Promise<{ width: number; height: number }>
      grab(request: GrabRequest): Promise<GrabResponse>
      stop(): void
    }
  }
}

let video: HTMLVideoElement | null = null

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

async function grab(request: GrabRequest): Promise<GrabResponse> {
  const el = video
  if (!el || video?.videoWidth === 0 || !liveTrack(el)) {
    throw new Error('屏幕捕获流未就绪')
  }
  const { crop, target, diff } = request
  if (!isFiniteRect(crop) || crop.width <= 0 || crop.height <= 0) {
    throw new RangeError('截取区域非法')
  }
  if (
    !Number.isInteger(target.width) ||
    !Number.isInteger(target.height) ||
    target.width <= 0 ||
    target.height <= 0 ||
    !Number.isInteger(diff.width) ||
    !Number.isInteger(diff.height) ||
    diff.width <= 0 ||
    diff.height <= 0
  ) {
    throw new RangeError('输出尺寸非法')
  }

  const main = draw(el, crop, target.width, target.height)
  const blob = await main.canvas.convertToBlob({ type: 'image/png' })
  const png = new Uint8Array(await blob.arrayBuffer())
  const small = draw(el, crop, diff.width, diff.height)
  const data = small.getImageData(0, 0, diff.width, diff.height).data

  return { png, diff: new Uint8Array(data), width: target.width, height: target.height }
}

window.__gotchaCapture = { start, grab, stop }

export {}
