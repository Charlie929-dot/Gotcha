/**
 * P0-2 第二步：旧管线降级为「仅元数据」。
 *
 * 打开 `metadataOnly` 后 tick 只取前台窗口、写一条 app/title 事件：
 * 不 probe、不截帧、不 OCR、不落盘。同一 app+title 连续采样只记一条；
 * 标题变化就是新的一条（时间线上的粒度来源）。正文由信息链双写（见 chain-events.test.ts）。
 */
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, queryTimeline, type Db } from '../../src/db'
import { CapturePipeline, type CaptureDeps, type CapturedFrame } from '../../src/capture/pipeline'
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
    diffHash: dHash(gray(seed), W, H),
    bytes: 3_400_000
  }
}

interface Harness {
  db: Db
  pipeline: CapturePipeline
  probeWindow: ReturnType<typeof vi.fn>
  captureWindow: ReturnType<typeof vi.fn>
  ocr: { recognize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
}

function makeHarness(overrides: Partial<CaptureDeps> = {}): Harness {
  const db = openDatabase(':memory:')
  const probeWindow = vi.fn(async () => ({ diffHash: dHash(gray(1), W, H) }))
  const captureWindow = vi.fn(async () => frame(1))
  const ocr = {
    recognize: vi.fn(async () => ({ text: '项目计划', ms: 4 })),
    dispose: vi.fn(async () => {})
  }
  const pipeline = new CapturePipeline({
    db,
    ocr,
    now: () => 1_000,
    getActiveWindow: async () => WINDOW,
    metadataOnly: true,
    probeWindow,
    captureWindow,
    deleteFrame: vi.fn(),
    isBlacklisted: () => false,
    ...overrides
  })
  return { db, pipeline, probeWindow, captureWindow, ocr }
}

describe('CapturePipeline · 仅元数据模式（P0-2）', () => {
  it('不 probe、不截帧、不 OCR：只写一条 app/title 元数据', async () => {
    const h = makeHarness()
    try {
      await h.pipeline.tick()
      await h.pipeline.flush()

      expect(h.probeWindow).not.toHaveBeenCalled()
      expect(h.captureWindow).not.toHaveBeenCalled()
      expect(h.ocr.recognize).not.toHaveBeenCalled()

      const rows = queryTimeline(h.db, 0, 10_000)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        ts: 1_000,
        app: 'notepad',
        window_title: '测试窗口',
        ocr_text: null,
        shot_path: null,
        sensitive: 0
      })
      expect(h.pipeline.getStats()).toMatchObject({
        frames_total: 0,
        frames_same: 0,
        ocr_runs: 0,
        metadata_events: 1
      })
    } finally {
      h.db.close()
    }
  })

  it('同一窗口连续采样只记一条；标题变化才新增', async () => {
    let window: WindowInfo = { ...WINDOW }
    const h = makeHarness({ getActiveWindow: async () => window })
    try {
      await h.pipeline.tick()
      await h.pipeline.tick()
      expect(queryTimeline(h.db, 0, 10_000)).toHaveLength(1)

      window = { ...WINDOW, title: '测试窗口 · 第二章' }
      await h.pipeline.tick()
      const rows = queryTimeline(h.db, 0, 10_000)
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.window_title)).toEqual(['测试窗口', '测试窗口 · 第二章'])
      expect(h.pipeline.getStats().metadata_events).toBe(2)
    } finally {
      h.db.close()
    }
  })

  it('切到黑名单窗口也只记元数据，且仍然不截帧 / 不 OCR', async () => {
    let window: WindowInfo = { ...WINDOW, app: 'KeePass', executable: 'keepass.exe' }
    const h = makeHarness({
      getActiveWindow: async () => window,
      isBlacklisted: () => true
    })
    try {
      await h.pipeline.tick()
      window = { ...WINDOW, app: 'KeePass', title: '另一个保险库' }
      await h.pipeline.tick()

      expect(h.captureWindow).not.toHaveBeenCalled()
      expect(h.ocr.recognize).not.toHaveBeenCalled()
      const rows = queryTimeline(h.db, 0, 10_000)
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.ocr_text === null)).toBe(true)
    } finally {
      h.db.close()
    }
  })

  it('当前台窗口读不到时只计 capture_errors，不写事件', async () => {
    const h = makeHarness({ getActiveWindow: async () => null })
    try {
      await h.pipeline.tick()
      expect(h.pipeline.getStats()).toMatchObject({ capture_errors: 1, metadata_events: 0 })
      expect(queryTimeline(h.db, 0, 10_000)).toHaveLength(0)
    } finally {
      h.db.close()
    }
  })

  it('关闸之后不再写元数据', async () => {
    const h = makeHarness()
    try {
      h.pipeline.halt()
      await h.pipeline.tick()
      expect(queryTimeline(h.db, 0, 10_000)).toHaveLength(0)
      expect(h.pipeline.getStats().metadata_events).toBe(0)
    } finally {
      h.db.close()
    }
  })
})
