/**
 * 采集管线（m1a-plan §3 Phase 2c）
 *
 * tick：取前台窗口 → 黑名单（截图前判断，只记元数据）→ 截窗口区域 →
 *      dHash 帧差（按 app+title 分 key：已入库 / 在队的内容丢帧；OCR 失败只对
 *      同帧有限重试）→ 入 OCR 队列 → 异步 worker 识别 → sanitize → insertEvent。
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
  /** 同一窗口同一内容 OCR / 落库连续失败上限；到顶后提交该指纹、停止重试（默认 3） */
  dedupMaxRetries?: number
  /** 去重状态 LRU 上限；标题频繁变化时不无界增长（默认 64） */
  dedupKeyLimit?: number
  log?(entry: PipelineLog): void
}

export const DEFAULT_DIFF_THRESHOLD = 8
/** 同帧连续失败到顶就把指纹当作已提交：不无限重试，内容变化后自然恢复 */
export const DEFAULT_MAX_RETRIES = 3
/** 去重状态最多保留的 app+title 数（LRU） */
export const DEDUP_KEY_LIMIT = 64

interface DedupEntry {
  /** 最近一次「已确认记下」的帧指纹（入库成功 / 黑名单元数据 / 敏感整帧丢弃） */
  committed: bigint | null
  /** 已入队、尚未出结果的帧指纹（FIFO；同一内容不重复排队） */
  queued: bigint[]
  /** 最近一次失败指纹与连续失败次数（跨帧累计会把无关重试算到一帧上） */
  failure: { hash: bigint; attempts: number } | null
}

export class CapturePipeline {
  private readonly queue: OcrQueue
  private readonly stats: CaptureStats = zeroStats()
  private readonly dedup = new Map<string, DedupEntry>()
  private readonly dedupMaxRetries: number
  private readonly dedupKeyLimit: number
  /** 上次记录元数据的黑名单窗口（同窗口连续采样只记一条；切走再回来重新记） */
  private lastBlacklistedKey: string | null = null
  private currentDrain: Promise<void> | null = null
  private halted = false

  constructor(private readonly deps: CaptureDeps) {
    this.queue = deps.queue ?? new OcrQueue()
    this.dedupMaxRetries = deps.dedupMaxRetries ?? DEFAULT_MAX_RETRIES
    this.dedupKeyLimit = deps.dedupKeyLimit ?? DEDUP_KEY_LIMIT
    Object.assign(this.stats, deps.initialStats ?? {})
  }

  getStats(): CaptureStats {
    return { ...this.stats }
  }

  /** 跨午夜换 stats key 时清零当日累计（去重状态保留，帧差与采集不中断） */
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

    if (this.deps.isBlacklisted(window)) {
      // 黑名单在截图前判断：不落 PNG、不写 OCR（security.md 第 2 层；F06）
      this.recordBlacklisted(window, now)
      return
    }
    // 离开黑名单窗口：清掉「上次记录」，切回同一黑名单窗口时重新记一条
    this.lastBlacklistedKey = null

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
    const entry = this.dedupEntry(window.app, window.title)
    if (this.isDuplicate(entry, hash)) {
      this.stats.frames_same++
      this.discard(frame.imagePath)
      return
    }

    const job: OcrJob = {
      ts: now,
      app: window.app,
      title: window.title,
      imagePath: frame.imagePath,
      hash
    }
    if (!this.queue.push(job)) {
      // 未入队就没有「已记录 / 在途」状态：同帧下个 tick 还会再试
      this.stats.queue_dropped++
      this.deps.log?.({
        level: 'warn',
        msg: 'ocr queue full, dropped newest frame',
        data: { queue_dropped: this.stats.queue_dropped }
      })
      this.discard(frame.imagePath)
      return
    }
    entry.queued.push(hash)
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
    const entry = job.hash === undefined ? null : this.dedupEntry(job.app, job.title)
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
        // 整帧丢弃也是一次确定结果：提交指纹，避免同一密码界面每个 tick 重复 OCR
        if (entry && job.hash !== undefined) this.commit(entry, job.hash)
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
      // 只有落库成功才提交指纹；失败时保留旧状态，同帧下个 tick 可重试
      if (entry && job.hash !== undefined) this.commit(entry, job.hash)
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
      if (entry && job.hash !== undefined) this.retryLater(entry, job.hash, job)
      this.deps.log?.({
        level: 'warn',
        msg: 'ocr failed',
        data: { app: job.app, error: String(error) }
      })
    } finally {
      // 出结果即出队；失败时 queued 清空，同帧下个 tick 才会重新入队
      if (entry && job.hash !== undefined) this.dequeue(entry, job.hash)
      this.discard(job.imagePath)
    }
  }

  /** 按 app+title 取去重状态（命中即刷新 LRU；超上限淘汰最旧 key） */
  private dedupEntry(app: string, title: string): DedupEntry {
    const key = `${app}\u0000${title}`
    let entry = this.dedup.get(key)
    if (entry) {
      this.dedup.delete(key)
      this.dedup.set(key, entry)
      return entry
    }
    entry = { committed: null, queued: [], failure: null }
    if (this.dedup.size >= this.dedupKeyLimit) {
      const oldest = this.dedup.keys().next().value
      if (oldest !== undefined) this.dedup.delete(oldest)
    }
    this.dedup.set(key, entry)
    return entry
  }

  /** 黑名单窗口只记元数据：同窗口连续采样不重复写；切走再回来按新聚焦记一条 */
  private recordBlacklisted(window: WindowInfo, now: number): void {
    const key = `${window.app}\u0000${window.title}`
    if (key === this.lastBlacklistedKey) return
    this.lastBlacklistedKey = key
    insertEvent(this.deps.db, { ts: now, app: window.app, windowTitle: window.title })
  }

  /** 与「已提交」或「任一在途帧」相近即视为未变（监听器式去重） */
  private isDuplicate(entry: DedupEntry, hash: bigint): boolean {
    const threshold = this.deps.diffThreshold ?? DEFAULT_DIFF_THRESHOLD
    const same = (seen: bigint) => hammingDistance(seen, hash) <= threshold
    return (entry.committed !== null && same(entry.committed)) || entry.queued.some(same)
  }

  private commit(entry: DedupEntry, hash: bigint): void {
    entry.committed = hash
    entry.failure = null
  }

  private retryLater(entry: DedupEntry, hash: bigint, job: OcrJob): void {
    const attempts = entry.failure?.hash === hash ? entry.failure.attempts + 1 : 1
    if (attempts >= this.dedupMaxRetries) {
      // 同帧连续失败到顶：提交指纹停止重试，避免每个采样周期都白跑一次 OCR。
      // 不是永久放弃该窗口——内容一变（hash 超出阈值）就会重新入队。
      entry.committed = hash
      entry.failure = null
      this.deps.log?.({
        level: 'warn',
        msg: 'ocr retry exhausted, frame marked as seen',
        data: { app: job.app, attempts }
      })
      return
    }
    entry.failure = { hash, attempts }
  }

  private dequeue(entry: DedupEntry, hash: bigint): void {
    const index = entry.queued.indexOf(hash)
    if (index >= 0) entry.queued.splice(index, 1)
  }

  private discard(imagePath: string): void {
    try {
      this.deps.deleteFrame(imagePath)
    } catch (error) {
      // 删除失败可见（计数 + 告警）但不记录路径原文；残留由下次启动的受控清理兜底
      this.stats.temp_delete_failed++
      this.deps.log?.({
        level: 'warn',
        msg: 'temp frame delete failed',
        data: { code: (error as NodeJS.ErrnoException).code ?? 'unknown' }
      })
    }
  }
}
