/**
 * 隐藏采集窗口 · 「draw 前等一个新帧」的回归（QA 补测）
 *
 * 为什么要测：入场图闪旧帧的修法是 `grab()` 里 `await waitForFreshFrame(video)`，
 * 而 renderer 没有任何单测环境（vitest 跑 node，`src/renderer/capture-window.ts`
 * 是模块作用域就摸 `window` 的页面脚本）。这里用最小 DOM / OffscreenCanvas stub
 * 把它拉起来，只验证三件可观察的事：
 * 1) rVFC 可用时，draw 发生在**帧回调之后**（不是之前）；
 * 2) rVFC 一直不回调（静止画面）：~500ms 超时兜底后照样出图；
 * 3) rVFC 不存在：立刻出图，不阻塞；`cancelVideoFrameCallback` 缺席也不抛。
 *
 * stub 只覆盖 `capture-window.ts` 真正用到的 API，不模拟完整浏览器。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

interface GrabRequest {
  crop: { x: number; y: number; width: number; height: number }
  target: { width: number; height: number }
  diff: { width: number; height: number }
  fresh?: boolean
}

interface CaptureApi {
  start(): Promise<{ width: number; height: number }>
  grab(request: GrabRequest): Promise<{ image: Uint8Array; hash: string; width: number; height: number }>
  probe(request: { crop: GrabRequest['crop']; diff: GrabRequest['diff'] }): Promise<{
    hash: string
    width: number
    height: number
  }>
  stop(): void
}

const REQUEST: GrabRequest = {
  crop: { x: 0, y: 0, width: 100, height: 100 },
  target: { width: 20, height: 20 },
  diff: { width: 4, height: 4 }
}

type FrameMode = 'fire' | 'never' | 'missing'

interface Harness {
  capture: CaptureApi
  events: string[]
}

/**
 * 装好 stub 并 import 模块。
 * @param frameMode rVFC 行为：fire=延迟后回调；never=永不回调；missing=环境没有 rVFC
 * @param hasCancel 是否有 cancelVideoFrameCallback
 * @param frameDelayMs fire 模式下帧回调的延迟（用于证明 grab 真的在等）
 */
async function boot(
  frameMode: FrameMode,
  hasCancel = true,
  frameDelayMs = 5
): Promise<Harness> {
  const events: string[] = []

  const track = {
    readyState: 'live',
    stop: () => {},
    addEventListener: () => {}
  }
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track]
  }

  const video: Record<string, unknown> = {
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    videoWidth: 320,
    videoHeight: 200,
    play: async () => {},
    addEventListener: () => {}
  }
  if (frameMode !== 'missing') {
    video.requestVideoFrameCallback = (callback: (now: number, metadata: unknown) => void): number => {
      events.push('rvfc')
      if (frameMode === 'fire') setTimeout(() => callback(0, null), frameDelayMs)
      return 7
    }
  }
  if (hasCancel) {
    video.cancelVideoFrameCallback = (handle: number): void => {
      events.push(`cancel:${handle}`)
    }
  }

  const context = {
    canvas: null as unknown,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    drawImage: (): void => {
      events.push('draw')
    },
    getImageData: (): { data: Uint8ClampedArray } => ({
      data: new Uint8ClampedArray(REQUEST.diff.width * REQUEST.diff.height * 4)
    })
  }
  class FakeOffscreenCanvas {
    width: number
    height: number
    constructor(width: number, height: number) {
      this.width = width
      this.height = height
      context.canvas = this
    }
    getContext(): typeof context {
      return context
    }
    async convertToBlob(): Promise<Blob> {
      events.push('encode')
      return new Blob([new Uint8Array([1, 2, 3])])
    }
  }

  const windowStub: Record<string, unknown> = {}
  Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => video },
    configurable: true,
    writable: true
  })
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getDisplayMedia: async () => stream } },
    configurable: true,
    writable: true
  })
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: FakeOffscreenCanvas,
    configurable: true,
    writable: true
  })

  vi.resetModules()
  await import('../../src/renderer/capture-window')
  const capture = windowStub.__gotchaCapture as unknown as CaptureApi
  return { capture, events }
}

afterEach(() => {
  vi.resetModules()
})

describe('采集窗口 · grab 前等新帧（旧帧 Bug 的修法）', () => {
  it('rVFC 可用：draw 在帧回调之后发生，并在结束时取消未用的回调', async () => {
    const { capture, events } = await boot('fire')
    await capture.start()
    await capture.grab(REQUEST)

    expect(events[0]).toBe('rvfc')
    expect(events).toContain('draw')
    // 帧回调先到、draw 后到
    expect(events.indexOf('rvfc')).toBeLessThan(events.indexOf('draw'))
    // 回调已用完，handle 要被取消（7 是 stub 返回的句柄）
    expect(events).toContain('cancel:7')
  })

  it('rVFC 永不回调（静止画面）：~500ms 超时兜底后照样出图', async () => {
    const { capture, events } = await boot('never')
    await capture.start()

    const startedAt = Date.now()
    const response = await capture.grab(REQUEST)
    const elapsed = Date.now() - startedAt

    expect(events).toContain('draw')
    expect(response.width).toBe(REQUEST.target.width)
    // 兜底超时 500ms：既不会立刻画（那就等于没等），也不会无限等
    expect(elapsed).toBeGreaterThanOrEqual(450)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('rVFC 迟到 120ms：grab 真的等它（耗时 ≥100ms），不是「排完序就算」', async () => {
    const { capture, events } = await boot('fire', true, 120)
    await capture.start()

    const startedAt = Date.now()
    await capture.grab(REQUEST)
    const elapsed = Date.now() - startedAt

    // 若 grab 没有 await waitForFreshFrame，这里会是几毫秒
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(events.indexOf('rvfc')).toBeLessThan(events.indexOf('draw'))
  })

  it('环境没有 rVFC：立刻出图，不阻塞采集', async () => {
    const { capture, events } = await boot('missing')
    await capture.start()

    const startedAt = Date.now()
    await capture.grab(REQUEST)
    const elapsed = Date.now() - startedAt

    expect(events).not.toContain('rvfc')
    expect(events).toContain('draw')
    expect(elapsed).toBeLessThan(200)
  })

  it('没有 cancelVideoFrameCallback：可选调用不抛（超时路径照常完成）', async () => {
    const { capture, events } = await boot('never', false)
    await capture.start()

    // 走到超时兜底分支，finish() 里的 cancelVideoFrameCallback?.() 不该炸
    const response = await capture.grab(REQUEST)
    expect(response.image.length).toBeGreaterThan(0)
    expect(events).toContain('draw')
  })
})

describe('采集窗口 · probe 只回指纹（判重前移 P0-1）', () => {
  it('probe 画 90×80 后只回 hash：不 convertToBlob、不传像素', async () => {
    const { capture, events } = await boot('fire')
    await capture.start()

    const response = await capture.probe({ crop: REQUEST.crop, diff: REQUEST.diff })
    expect(response.hash).toMatch(/^0x[0-9a-f]{16}$/)
    expect(events).toContain('draw')
    expect(events).not.toContain('encode')
  })

  it('grab(fresh=false) 不再等新帧（探针刚刚等过）：不注册 rVFC', async () => {
    const { capture, events } = await boot('fire')
    await capture.start()

    const startedAt = Date.now()
    await capture.grab({ ...REQUEST, fresh: false })
    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(events).not.toContain('rvfc')
    expect(events).toContain('encode')
  })
})
