import { describe, expect, it, vi } from 'vitest'
import { openDatabase, queryTimeline, type Db } from '../../src/db'
import { CapturePipeline, type CaptureDeps, type CapturedFrame } from '../../src/capture/pipeline'
import type { OcrResult } from '../../src/capture/ocr/engine'
import type { OcrJob } from '../../src/capture/queue'
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

function frame(seed: number): CapturedFrame {
  return {
    imagePath: `frame-${seed}.png`,
    width: 1280,
    height: 1029,
    diffHash: dHash(gray(seed), W, H)
  }
}

function job(n: number): OcrJob {
  return { ts: n, app: 'notepad', title: `t${n}`, imagePath: `frame-${n}.png` }
}

interface Harness {
  db: Db
  pipeline: CapturePipeline
  deleted: string[]
  ocr: { recognize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
}

function makeHarness(overrides: Partial<CaptureDeps> = {}): Harness {
  const db = openDatabase(':memory:')
  const deleted: string[] = []
  const ocr = {
    recognize: vi.fn(async () => ({ text: '项目计划', ms: 4 })),
    dispose: vi.fn(async () => {})
  }
  const pipeline = new CapturePipeline({
    db,
    ocr,
    now: () => 1_000,
    getActiveWindow: async () => WINDOW,
    captureWindow: async () => frame(1),
    deleteFrame: (imagePath) => deleted.push(imagePath),
    isBlacklisted: () => false,
    ...overrides
  })
  return { db, pipeline, deleted, ocr }
}

function eventCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('CapturePipeline · halt 闸', () => {
  it('halt 清空排队任务、逐帧删除并计 queue_dropped（幂等）', () => {
    const { db, pipeline, deleted } = makeHarness()
    try {
      const queue = pipeline.getQueue()
      for (const entry of [job(1), job(2), job(3)]) queue.push(entry)

      pipeline.halt()

      expect(pipeline.isHalted()).toBe(true)
      expect(queue.size).toBe(0)
      expect(pipeline.getStats().queue_dropped).toBe(3)
      expect(deleted).toEqual(['frame-1.png', 'frame-2.png', 'frame-3.png'])

      pipeline.halt()
      expect(pipeline.getStats().queue_dropped).toBe(3)
      expect(deleted).toHaveLength(3)
    } finally {
      db.close()
    }
  })

  it('stop 时 OCR 在途：结果返回后丢弃，不写库、删帧；flush 等在途结束', async () => {
    let resolveOcr!: (result: OcrResult) => void
    const recognize = vi.fn(
      () =>
        new Promise<OcrResult>((resolve) => {
          resolveOcr = resolve
        })
    )
    const { db, pipeline, deleted } = makeHarness({ ocr: { recognize, dispose: vi.fn() } })
    try {
      await pipeline.tick()
      expect(recognize).toHaveBeenCalledTimes(1)

      pipeline.halt()
      let flushed = false
      const flush = pipeline.flush().then(() => {
        flushed = true
      })
      await nextTask()
      expect(flushed).toBe(false)

      resolveOcr({ text: '机密内容', ms: 8 })
      await flush

      expect(eventCount(db)).toBe(0)
      expect(deleted).toContain('frame-1.png')
      expect(pipeline.getStats()).toMatchObject({ ocr_runs: 1, queue_dropped: 1 })
    } finally {
      db.close()
    }
  })

  it('halt 之后 tick 不再截帧、不写库', async () => {
    const captureWindow = vi.fn(async () => frame(1))
    const { db, pipeline } = makeHarness({ captureWindow })
    try {
      pipeline.halt()
      await pipeline.tick()

      expect(captureWindow).not.toHaveBeenCalled()
      expect(eventCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('截屏期间关闸：帧被删除且不入队、不 OCR', async () => {
    let resolveFrame!: (value: CapturedFrame) => void
    const captureWindow = vi.fn(
      () =>
        new Promise<CapturedFrame>((resolve) => {
          resolveFrame = resolve
        })
    )
    const { db, pipeline, deleted, ocr } = makeHarness({ captureWindow })
    try {
      const ticking = pipeline.tick()
      await nextTask()
      expect(captureWindow).toHaveBeenCalledTimes(1)

      pipeline.halt()
      resolveFrame(frame(1))
      await ticking

      expect(deleted).toContain('frame-1.png')
      expect(pipeline.getQueue().size).toBe(0)
      expect(ocr.recognize).not.toHaveBeenCalled()
      expect(eventCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('黑名单窗口：截屏前判断，取证窗口期间关闸也不写元数据事件', async () => {
    let release!: (value: WindowInfo | null) => void
    const getActiveWindow = vi.fn(
      () =>
        new Promise<WindowInfo | null>((resolve) => {
          release = resolve
        })
    )
    const captureWindow = vi.fn(async () => frame(1))
    const { db, pipeline } = makeHarness({ getActiveWindow, captureWindow, isBlacklisted: () => true })
    try {
      const ticking = pipeline.tick()
      await nextTask()
      pipeline.halt()
      release(WINDOW)
      await ticking

      expect(captureWindow).not.toHaveBeenCalled()
      expect(eventCount(db)).toBe(0)
      expect(pipeline.getQueue().size).toBe(0)
    } finally {
      db.close()
    }
  })
})
