/**
 * 信息链 · 运行时（把事件源、段机、记录器接成一条链）
 *
 * 这是「采集真的跑起来」的唯一入口：`start()` 建表 + 崩溃收尾 + 订阅原始事件 + 起心跳；
 * `stop()` 反向收口（把手势、开着的段都交代清楚），随后 `await drain()` 等在途截图落库。
 * **它不接 UI、不写设置**，接进 `src/main/` 的是 `main/chain-recording.ts`。
 *
 * 心跳必须存在：段机判空闲（60s 无输入）与打字停顿（3s）都靠 `tick` 推进，
 * 没有事件的时候没人喂，它就不会知道人已经走了。
 */
import type { ChainDb } from '../store'
import { ensureChainSchema } from '../schema'
import { finalizeAbandonedSegments } from '../store'
import { ChainSegmenter, type ChainAction, type ChainInput, type SegmenterOptions } from '../segmenter'
import { ChainRecorder, type ContentPayload, type RecorderOutcome, type ShotTaker, type ShotStats } from '../recorder'
import { DesktopEventAdapter, type AdapterOptions } from './adapter'
import type { DesktopEventSource, RawDesktopEvent, SourceInfo } from './types'

export interface ChainRuntimeOptions {
  db: ChainDb
  source: DesktopEventSource
  /** 采图回调；不给就只记事件（不落截图）。可以返回 Promise（真实抓帧是异步的） */
  takeShot?: ShotTaker
  now?: () => number
  /** 心跳间隔，默认 1s；与适配层的 tickIntervalMs 对齐 */
  pulseMs?: number
  /** 是否自己起心跳定时器；测试里关掉、手动调 `pulse()` */
  autoPulse?: boolean
  adapterOptions?: Partial<AdapterOptions>
  segmenterOptions?: Partial<SegmenterOptions>
  sourceInfo?: SourceInfo
  /** 段收口后通知（派生层叫醒；v0.8） */
  onSegmentClosed?: (segmentId: number) => void
  /** 内容写入后通知（派生层叫醒；v0.8） */
  onContentWritten?: (segmentId: number) => void
}

export interface ChainRuntimeStats {
  started: boolean
  openSegmentId: number | null
  idle: boolean
  lastOutcome: RecorderOutcome | null
  shotStats: ShotStats
}

export class ChainRuntime {
  private readonly db: ChainDb
  private readonly source: DesktopEventSource
  private readonly now: () => number
  private readonly pulseMs: number
  private readonly autoPulse: boolean
  private readonly adapter: DesktopEventAdapter
  private readonly segmenter: ChainSegmenter
  private readonly recorder: ChainRecorder
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastOutcome: RecorderOutcome | null = null

  readonly sourceInfo: SourceInfo

  constructor(options: ChainRuntimeOptions) {
    this.db = options.db
    this.source = options.source
    this.now = options.now ?? (() => Date.now())
    this.pulseMs = options.pulseMs ?? 1_000
    this.autoPulse = options.autoPulse ?? true
    this.adapter = new DesktopEventAdapter(options.source, { now: this.now, ...options.adapterOptions })
    this.segmenter = new ChainSegmenter(options.segmenterOptions)
    this.recorder = new ChainRecorder({
      db: options.db,
      now: this.now,
      takeShot: options.takeShot,
      onSegmentClosed: options.onSegmentClosed,
      onContentWritten: options.onContentWritten
    })
    this.sourceInfo = options.sourceInfo ?? { kind: 'fake' }
  }

  start(): void {
    if (this.running) return
    ensureChainSchema(this.db)
    // 上次异常退出留下的开段先收口，否则开新段会撞「已有开着的段」
    finalizeAbandonedSegments(this.db)
    this.source.start((event) => this.onEvent(event))
    if (this.autoPulse) {
      this.timer = setInterval(() => this.pulse(), this.pulseMs)
      // 别让心跳拖着进程不退出（Electron 主进程里同理）
      this.timer.unref?.()
    }
    this.running = true
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.running) return
    this.running = false
    this.source.stop()
    // 收口：先交出手势，再让段机把它开着的段收掉
    this.feedInputs(this.adapter.flush())
    this.record(this.segmenter.flush(this.now()))
  }

  /** 心跳：不传时间就是现在（测试可注入） */
  pulse(now: number = this.now()): void {
    this.feedInputs(this.adapter.pulse(now))
  }

  /**
   * 等所有在途采图落定。`stop()` 是同步的（关源、收口段），
   * 退出前要记得 `await drain()`，否则最后那张截图会丢。
   */
  drain(): Promise<void> {
    return this.recorder.drain()
  }

  /**
   * 内容车道读回来时补写（v0.6）：按段 id 写回，段可能已经收口。
   * 内容读取比抓帧慢，所以它不能等「当前开着的段」——那可能已经是下一扇窗了。
   */
  recordContentFor(segmentId: number, capturedAt: number, payload: ContentPayload): boolean {
    return this.recorder.recordContentFor(segmentId, capturedAt, payload)
  }

  get stats(): ChainRuntimeStats {
    return {
      started: this.running,
      openSegmentId: this.recorder.currentSegmentId,
      idle: this.segmenter.isIdle,
      lastOutcome: this.lastOutcome,
      shotStats: this.recorder.shotStats
    }
  }

  /* ---------------------------------------------------------------- */

  private onEvent(event: RawDesktopEvent): void {
    this.feedInputs(this.adapter.handle(event))
  }

  /** 段机输入 → 段机动作 → 落库 */
  private feedInputs(inputs: readonly ChainInput[]): void {
    for (const input of inputs) this.record(this.segmenter.feed(input))
  }

  private record(actions: readonly ChainAction[]): void {
    this.lastOutcome = this.recorder.apply(actions)
  }
}
