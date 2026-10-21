import { describe, expect, it, vi } from 'vitest'
import { openDatabase, queryTimeline, type Db } from '../../src/db'
import {
  CapturePipeline,
  type CaptureDeps,
  type CapturedFrame
} from '../../src/capture/pipeline'
import { OcrQueue } from '../../src/capture/queue'
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

/** 确定性噪声帧（不同 seed 内容不同） */
function gray(seed: number): Uint8Array {
  const out = new Uint8Array(W * H)
  let state = seed * 7919 + 13
  for (let i = 0; i < out.length; i++) {
    state = (state * 1664525 + 1013904223) % 4294967296
    out[i] = state % 256
  }
  return out
}

/** 与真实截图层一致：OCR 图尺寸（1280x1029）与帧差灰度尺寸（90x80）不同 */
function frame(seed: number): CapturedFrame {
  return {
    imagePath: `frame-${seed}.png`,
    width: 1280,
    height: 1029,
    diffHash: dHash(gray(seed), W, H)
  }
}

interface Harness {
  db: Db
  pipeline: CapturePipeline
  deleted: string[]
  ocr: { recognize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
}

function makeHarness(
  overrides: Partial<CaptureDeps> = {},
  ocrText: (path: string) => string = () => '项目计划'
): Harness {
  const db = openDatabase(':memory:')
  const deleted: string[] = []
  const ocr = {
    recognize: vi.fn(async (imagePath: string) => ({ text: ocrText(imagePath), ms: 4 })),
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

describe('CapturePipeline · 管线语义', () => {
  it('首帧入库；内容未变（dHash 同）丢帧且不重复入库', async () => {
    const { db, pipeline, deleted } = makeHarness()
    try {
      await pipeline.tick()
      await pipeline.flush()
      expect(eventCount(db)).toBe(1)
      expect(pipeline.getStats()).toMatchObject({ frames_total: 1, ocr_runs: 1, frames_same: 0 })

      await pipeline.tick()
      await pipeline.flush()
      expect(eventCount(db)).toBe(1)
      expect(pipeline.getStats()).toMatchObject({ frames_total: 2, frames_same: 1 })
      expect(deleted).toEqual(['frame-1.png', 'frame-1.png'])
    } finally {
      db.close()
    }
  })

  it('内容变化 → 再次 OCR；命中敏感规则时 sensitive=1 且原文保留（D10）', async () => {
    // 回归：帧差指纹必须来自 90x80 灰度，与 OCR 图尺寸（1280x1029）无关；
    // 旧实现用 OCR 尺寸重算 dHash，导致所有帧被判「未变」，两帧只入 1 条
    let current = 1
    const { db, pipeline } = makeHarness(
      { captureWindow: async () => frame(current) },
      (path) => (path === 'frame-2.png' ? '电话 13800138000' : '项目计划')
    )
    try {
      await pipeline.tick()
      await pipeline.flush()
      current = 2
      await pipeline.tick()
      await pipeline.flush()

      const rows = queryTimeline(db, 0, 10_000)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ ocr_text: '项目计划', sensitive: 0 })
      expect(rows[1]).toMatchObject({ ocr_text: '电话 13800138000', sensitive: 1 })
    } finally {
      db.close()
    }
  })

  it('密码特征词 → 整帧丢弃，不入库', async () => {
    const { db, pipeline } = makeHarness({}, () => '请输入密码')
    try {
      await pipeline.tick()
      await pipeline.flush()
      expect(eventCount(db)).toBe(0)
      expect(pipeline.getStats().ocr_runs).toBe(1)
    } finally {
      db.close()
    }
  })

  it('黑名单窗口只记元数据，绝不过 OCR', async () => {
    const { db, pipeline, ocr } = makeHarness({ isBlacklisted: () => true })
    try {
      await pipeline.tick()
      await pipeline.flush()
      expect(ocr.recognize).not.toHaveBeenCalled()
      const [row] = queryTimeline(db, 0, 10_000)
      expect(row).toMatchObject({ app: 'notepad', ocr_text: null, sensitive: 0 })
    } finally {
      db.close()
    }
  })

  it('截图失败计 capture_errors，不中断后续 tick', async () => {
    let fail = true
    const { db, pipeline } = makeHarness({
      captureWindow: async () => {
        if (fail) throw new Error('desktopCapturer failed')
        return frame(1)
      }
    })
    try {
      await pipeline.tick()
      expect(pipeline.getStats().capture_errors).toBe(1)

      fail = false
      await pipeline.tick()
      await pipeline.flush()
      expect(eventCount(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('初始统计（当日累计）可延续', async () => {
    const { db, pipeline } = makeHarness({
      initialStats: { frames_total: 4, ocr_runs: 2, frames_same: 1 }
    })
    try {
      await pipeline.tick()
      await pipeline.flush()
      expect(pipeline.getStats()).toMatchObject({
        frames_total: 5,
        ocr_runs: 3,
        frames_same: 1
      })
    } finally {
      db.close()
    }
  })

  it('队列满丢最新并计 queue_dropped', async () => {
    const { db, pipeline, deleted, ocr } = makeHarness({ queue: new OcrQueue(0) })
    try {
      await pipeline.tick()
      await pipeline.flush()
      expect(ocr.recognize).not.toHaveBeenCalled()
      expect(pipeline.getStats().queue_dropped).toBe(1)
      expect(eventCount(db)).toBe(0)
      expect(deleted).toContain('frame-1.png')
    } finally {
      db.close()
    }
  })

  it('OCR 执行异常计 capture_errors 并清理帧文件', async () => {
    const { db, pipeline, deleted } = makeHarness({
      ocr: {
        recognize: vi.fn(async () => {
          throw new Error('boom')
        }),
        dispose: vi.fn(async () => {})
      }
    })
    try {
      await pipeline.tick()
      await pipeline.flush()
      expect(pipeline.getStats().capture_errors).toBe(1)
      expect(eventCount(db)).toBe(0)
      expect(deleted).toContain('frame-1.png')
    } finally {
      db.close()
    }
  })
})
