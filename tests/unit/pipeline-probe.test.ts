/**
 * 判重前移（性能方案 P0-1）：先 probe 指纹，未变不编码、不落盘。
 *
 * 旧顺序是「captureWindow 先编码 3–7 MB PNG 落盘 → 再比 dHash」，
 * 实测 84–87% 的帧随后被丢弃。这里用注入的 probeWindow / captureWindow 钉住新语义：
 * - 未变帧：只 probe，captureWindow 一次都不调；
 * - 变了才 capture，并且 encode 统计（encode_count / write_bytes / encode_ms）跟着走；
 * - probe 与 capture 之间画面又变回去（指纹回到已提交值）：真帧丢掉，不重复入库；
 * - probe 失败 / 探测期间关闸：不编码、不写库。
 */
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, queryTimeline, type Db } from '../../src/db'
import { CapturePipeline, type CaptureDeps, type CapturedFrame, type FrameProbe } from '../../src/capture/pipeline'
import { dHash } from '../../src/capture/frame-diff'
import type { WindowInfo } from '../../src/capture/window-meta'

const WINDOW: WindowInfo = {
  title: '测试窗口',
  app: 'notepad',
  executable: 'notepad.exe',
  bounds: { x: 0, y: 0, width: 800, height: 600 }
}

const W = 90
const H = 80

function gray(seed: number): Uint8Array {
  const out = new Uint8Array(W * H)
  let state = seed * 7919 + 13
  for (let i = 0; i < out.length; i++) {
    state = (state * 1664525 + 1013904223) % 4294967296
    out[i] = state % 256
  }
  return out
}

function probeOf(seed: number): FrameProbe {
  return { diffHash: dHash(gray(seed), W, H) }
}

function frame(seed: number, bytes = 3_400_000): CapturedFrame {
  return {
    imagePath: `frame-${seed}.png`,
    width: 1280,
    height: 1029,
    diffHash: dHash(gray(seed), W, H),
    bytes
  }
}

interface Harness {
  db: Db
  pipeline: CapturePipeline
  deleted: string[]
  probeWindow: ReturnType<typeof vi.fn>
  captureWindow: ReturnType<typeof vi.fn>
}

function makeHarness(overrides: Partial<CaptureDeps> = {}): Harness {
  const db = openDatabase(':memory:')
  const deleted: string[] = []
  const probeWindow = vi.fn(async () => probeOf(1))
  const captureWindow = vi.fn(async () => frame(1))
  const pipeline = new CapturePipeline({
    db,
    ocr: { recognize: vi.fn(async () => ({ text: '项目计划', ms: 4 })), dispose: vi.fn(async () => {}) },
    now: () => 1_000,
    getActiveWindow: async () => WINDOW,
    probeWindow,
    captureWindow,
    deleteFrame: (imagePath) => deleted.push(imagePath),
    isBlacklisted: () => false,
    ...overrides
  })
  return { db, pipeline, deleted, probeWindow, captureWindow }
}

function eventCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
}

describe('CapturePipeline · 判重前移（probe → 变了才编码）', () => {
  it('未变帧只 probe：captureWindow 不调用、不落盘、不删除任何临时帧', async () => {
    const h = makeHarness()
    try {
      await h.pipeline.tick()
      await h.pipeline.flush()
      expect(eventCount(h.db)).toBe(1)
      expect(h.probeWindow).toHaveBeenCalledTimes(1)
      expect(h.captureWindow).toHaveBeenCalledTimes(1)

      await h.pipeline.tick()
      await h.pipeline.flush()
      // 第二帧内容未变：只探测，没有第二次编码（deleted 里只有首帧 OCR 完的那一次）
      expect(h.probeWindow).toHaveBeenCalledTimes(2)
      expect(h.captureWindow).toHaveBeenCalledTimes(1)
      expect(h.deleted).toEqual(['frame-1.png'])
      expect(h.pipeline.getStats()).toMatchObject({
        frames_total: 2,
        frames_same: 1,
        encode_count: 1,
        write_bytes: 3_400_000
      })
    } finally {
      h.db.close()
    }
  })

  it('内容变化 → 重新编码并入库', async () => {
    let seed = 1
    const h = makeHarness({
      probeWindow: vi.fn(async () => probeOf(seed)),
      captureWindow: vi.fn(async () => frame(seed))
    })
    try {
      await h.pipeline.tick()
      await h.pipeline.flush()
      seed = 2
      await h.pipeline.tick()
      await h.pipeline.flush()

      const rows = queryTimeline(h.db, 0, 10_000)
      expect(rows).toHaveLength(2)
      expect(h.pipeline.getStats()).toMatchObject({ frames_total: 2, frames_same: 0, encode_count: 2 })
    } finally {
      h.db.close()
    }
  })

  it('probe 与编码之间画面又变回旧帧：真帧丢弃，不重复入库', async () => {
    const h = makeHarness()
    try {
      await h.pipeline.tick()
      await h.pipeline.flush()

      // 探针看到的是新画面，真编码拿到的却是旧画面（已提交指纹）
      h.probeWindow.mockResolvedValueOnce(probeOf(2))
      h.captureWindow.mockResolvedValueOnce(frame(1))
      await h.pipeline.tick()
      await h.pipeline.flush()

      expect(eventCount(h.db)).toBe(1)
      // 首帧 OCR 完删一次；这次编码出来的旧画面再删一次
      expect(h.deleted).toEqual(['frame-1.png', 'frame-1.png'])
      expect(h.pipeline.getStats()).toMatchObject({ frames_same: 1, encode_count: 2 })
    } finally {
      h.db.close()
    }
  })

  it('probe 抛错计 capture_errors，不进入编码', async () => {
    const h = makeHarness({
      probeWindow: vi.fn(async () => {
        throw new Error('stream gone')
      })
    })
    try {
      await h.pipeline.tick()
      expect(h.pipeline.getStats().capture_errors).toBe(1)
      expect(h.captureWindow).not.toHaveBeenCalled()
      expect(eventCount(h.db)).toBe(0)
    } finally {
      h.db.close()
    }
  })

  it('探测期间关闸：不编码、不写库', async () => {
    let release!: (value: FrameProbe) => void
    const probeWindow = vi.fn(
      () =>
        new Promise<FrameProbe>((resolve) => {
          release = resolve
        })
    )
    const h = makeHarness({ probeWindow })
    try {
      const ticking = h.pipeline.tick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      h.pipeline.halt()
      release(probeOf(1))
      await ticking

      expect(h.captureWindow).not.toHaveBeenCalled()
      expect(eventCount(h.db)).toBe(0)
    } finally {
      h.db.close()
    }
  })

  it('没有 probeWindow 时保持旧口径（先抓帧再判重）', async () => {
    const captureWindow = vi.fn(async () => frame(1))
    const h = makeHarness({ probeWindow: undefined, captureWindow })
    try {
      await h.pipeline.tick()
      await h.pipeline.flush()
      await h.pipeline.tick()
      await h.pipeline.flush()
      expect(captureWindow).toHaveBeenCalledTimes(2)
      expect(h.pipeline.getStats()).toMatchObject({ frames_total: 2, frames_same: 1, encode_count: 0 })
      // 旧口径未变帧仍然会落盘再删：首帧 OCR 完删一次、第二帧判重后删一次
      expect(h.deleted).toEqual(['frame-1.png', 'frame-1.png'])
    } finally {
      h.db.close()
    }
  })
})
