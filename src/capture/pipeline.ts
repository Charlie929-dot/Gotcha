/**
 * 采集管线（m1a-plan §3 Phase 2c）
 *
 * tick：取前台窗口 → 截窗口区域 → dHash 帧差（未变丢帧）→ 黑名单只记元数据
 *      → 入 OCR 队列 → 异步 worker 识别 → sanitize → insertEvent。
 *
 * 所有外部依赖（时钟/截屏/OCR/删帧/日志）注入，便于合成数据单测。
 */

import type { Db } from '../db'
import { insertEvent } from '../db'
import { sanitize } from '../understand/sanitize'
import { hammingDistance } from './frame-diff'
import type { OcrEngine } from './ocr/engine'
import { OcrQueue, type OcrJob } from './queue'
import type { CaptureStats } from './stats'
import { zeroStats } from './stats'
import type { WindowInfo } from './window-meta'

export interface CapturedFrame {
  imagePath: string
  /** OCR 图宽（≤1280），与帧差指纹的尺寸无关 */
  width: number
  height: number
  /** 由截图层按 90x80 灰度自算的 dHash 指纹（切勿用 width/height 重算） */
  diffHash: bigint
}

export interface PipelineLog {
  level: 'info' | 'warn'
  msg: string
  data?: Record<string, unknown>
}

export interface CaptureDeps {
  db: Db
  ocr: OcrEngine
  now(): number
  getActiveWindow(): Promise<WindowInfo | null>
  captureWindow(bounds: WindowInfo['bounds']): Promise<CapturedFrame | null>
  /** 删除临时帧文件（识别完 / 丢帧时调用） */
  deleteFrame(imagePath: string): void
  isBlacklisted(win: WindowInfo): boolean
  /** capture.save_shots=1 时由调用方落盘 <event_id>.jpg */
  saveShot?(eventId: number, imagePath: string): void
  diffThreshold?: number
  queue?: OcrQueue
  initialStats?: Partial<CaptureStats>
  log?(entry: PipelineLog): void
}

export const DEFAULT_DIFF_THRESHOLD = 8

export class CapturePipeline {
  private readonly queue: OcrQueue
  private readonly stats: CaptureStats = zeroStats()
  private lastHash: bigint | null = null
  private currentDrain: Promise<void> | null = null
  private halted = false

  constructor(private readonly deps: CaptureDeps) {
    this.queue = deps.queue ?? new OcrQueue()
    Object.assign(this.stats, deps.initialStats ?? {})
  }

  getStats(): CaptureStats {
    return { ...this.stats }
  }

  /** 跨午夜换 stats key 时清零当日累计（lastHash 保留，帧差与采集不中断） */
  resetStats(): void {
    Object.assign(this.stats, zeroStats())
  }

  getQueue(): OcrQueue {
    return this.queue
  }

  /**
   * 关闸（同步，微秒级；m1b-plan §4.4）。
   *
   * 之后 tick 不再截帧 / 入队；在途 OCR 结果在 insertEvent 前丢弃；排队任务
   * 一次清空并逐帧删除。stop() 必须先调用它，视觉切换只依赖这一步，不等流释放。
   */
  halt(): void {
    if (this.halted) return
    this.halted = true
    const dropped = this.queue.drainAll()
    this.stats.queue_dropped += dropped.length
    for (const job of dropped) this.discard(job.imagePath)
    if (dropped.length > 0) {
      this.deps.log?.({
        level: 'info',
        msg: 'ocr queue drained after halt',
        data: { queue_dropped: this.stats.queue_dropped }
      })
    }
  }

  isHalted(): boolean {
    return this.halted
  }

  /** 一次采样（调度器每 2s 调用；上一次未完成时调度器会跳过） */
  async tick(): Promise<void> {
    const now = this.deps.now()

    let window: WindowInfo | null = null
    try {
      window = await this.deps.getActiveWindow()
    } catch {
      window = null
    }
    // 闸已关：不再截帧（stop 后在途 tick 的唯一入口）
    if (this.halted) return
    if (!window) {
      this.stats.capture_errors++
      return
    }

    let frame: CapturedFrame | null = null
    try {
      frame = await this.deps.captureWindow(window.bounds)
    } catch {
      frame = null
    }
    // 截屏期间关闸：帧丢弃，不入队、不写库
    if (this.halted) {
      if (frame) this.discard(frame.imagePath)
      return
    }
    if (!frame) {
      this.stats.capture_errors++
      return
    }

    this.stats.frames_total++
    const hash = frame.diffHash
    const threshold = this.deps.diffThreshold ?? DEFAULT_DIFF_THRESHOLD
    if (this.lastHash !== null && hammingDistance(this.lastHash, hash) <= threshold) {
      this.stats.frames_same++
      this.discard(frame.imagePath)
      return
    }
    this.lastHash = hash

    if (this.deps.isBlacklisted(window)) {
      // 黑名单进程：只记元数据，绝不 OCR（security.md 第 2 层）
      insertEvent(this.deps.db, { ts: now, app: window.app, windowTitle: window.title })
      this.discard(frame.imagePath)
      return
    }

    const job: OcrJob = {
      ts: now,
      app: window.app,
      title: window.title,
      imagePath: frame.imagePath
    }
    if (!this.queue.push(job)) {
      this.stats.queue_dropped++
      this.deps.log?.({
        level: 'warn',
        msg: 'ocr queue full, dropped newest frame',
        data: { queue_dropped: this.stats.queue_dropped }
      })
      this.discard(frame.imagePath)
      return
    }
    void this.drain()
  }

  /** 等队列排空（测试 / 退出前调用） */
  async flush(): Promise<void> {
    while (this.queue.size > 0 || this.currentDrain) {
      await (this.currentDrain ?? this.drain())
    }
  }

  private drain(): Promise<void> {
    if (this.currentDrain) return this.currentDrain
    this.currentDrain = (async () => {
      try {
        let job: OcrJob | undefined
        while ((job = this.queue.take())) {
          await this.process(job)
        }
      } finally {
        this.currentDrain = null
      }
    })()
    return this.currentDrain
  }

  private async process(job: OcrJob): Promise<void> {
    try {
      const result = await this.deps.ocr.recognize(job.imagePath)
      this.stats.ocr_runs++
      // 关闸后返回的结果整帧丢弃：不 sanitize、不写库，统计复用 queue_dropped
      if (this.halted) {
        this.stats.queue_dropped++
        this.deps.log?.({
          level: 'info',
          msg: 'frame dropped after halt',
          data: { ts: job.ts, app: job.app, queue_dropped: this.stats.queue_dropped }
        })
        return
      }
      const sanitized = sanitize(result.text)
      if (sanitized.drop) {
        this.deps.log?.({
          level: 'info',
          msg: 'frame dropped by password rule',
          data: { ts: job.ts, app: job.app }
        })
        return
      }
      const eventId = insertEvent(this.deps.db, {
        ts: job.ts,
        app: job.app,
        windowTitle: job.title,
        ocrText: sanitized.text,
        sensitive: sanitized.sensitive ? 1 : 0
      })
      this.deps.saveShot?.(eventId, job.imagePath)
      this.deps.log?.({
        level: 'info',
        msg: 'event inserted',
        data: {
          event_id: eventId,
          ts: job.ts,
          app: job.app,
          sensitive: sanitized.sensitive ? 1 : 0,
          ocr_ms: result.ms
        }
      })
    } catch (error) {
      this.stats.capture_errors++
      this.deps.log?.({
        level: 'warn',
        msg: 'ocr failed',
        data: { app: job.app, error: String(error) }
      })
    } finally {
      this.discard(job.imagePath)
    }
  }

  private discard(imagePath: string): void {
    try {
      this.deps.deleteFrame(imagePath)
    } catch {
      // 清理失败不阻断采集
    }
  }
}
