/**
 * 采集控制器（m1b-plan §3 Phase 0，从 M1a 的 startCapture 拆出）
 *
 * 契约（写死，见方案 §3 Phase 0 / §4.4）：
 * - start() / stop() 返回 Promise<void>，单一 Promise 链串行，同一时刻只允许一个
 *   转换在途；同向重复调用返回同一个在途 Promise。
 * - start() 失败整体回滚：停调度、dispose 屏幕流、释放本次新开的写连接、记错因，
 *   状态回落 paused；不得留下半开的采集窗口。
 * - stop() 完成条件：闸已关（同步）→ 在途 OCR 返回并丢弃 → 队列已空 → stats 落盘
 *   → 屏幕流已释放。视觉切换只依赖第一步 halt()，不等流释放。
 * - status() 返回 paused | starting | running | stopping，供球与托盘渲染。
 *
 * 本文件保持 Electron-free（只依赖注入）：单元测试在 Node 里直接跑状态机与装配回滚。
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DB_FILE_NAME, type Db } from '../db'
import { getNumberSetting } from '../db/settings'
import type { OcrEngine } from '../capture/ocr/engine'
import { CapturePipeline, type CapturedFrame } from '../capture/pipeline'
import { startScheduler, type SchedulerHandle } from '../capture/scheduler'
import { createDailyStatsFlusher, loadStats, statsKey } from '../capture/stats'
import type { WindowBounds, WindowInfo } from '../capture/window-meta'

export type CaptureStatus = 'paused' | 'starting' | 'running' | 'stopping'

export type CaptureLogLevel = 'info' | 'warn' | 'error'

export type CaptureLog = (
  level: CaptureLogLevel,
  msg: string,
  data?: Record<string, unknown>
) => void

const SCHEDULER_INTERVAL_MS = 2_000
const FLUSH_INTERVAL_MS = 60_000

/* ------------------------------------------------------------------ *
 * 连接生命周期
 * ------------------------------------------------------------------ */

export interface CaptureDbConnectionsDeps {
  dbPath: string
  fileExists(path: string): boolean
  openWritable(path: string): Db
  openReadonly(path: string): Db
}

/**
 * 时间线只读连接 / 采集写连接（m1b-plan §6「只读连接与写连接并存」）。
 *
 * 规则：查询时写连接优先，否则惰性只读（库不存在返回 null，不建库，守 A3）；
 * 开启采集前先关只读再开写，禁止双连接与 WAL 句柄残留。
 */
export class CaptureDbConnections {
  private writeDb: Db | null = null
  private readonlyDb: Db | null = null

  constructor(private readonly deps: CaptureDbConnectionsDeps) {}

  queryDb(): Db | null {
    if (this.writeDb) return this.writeDb
    if (this.readonlyDb) return this.readonlyDb
    if (!this.deps.fileExists(this.deps.dbPath)) return null
    this.readonlyDb = this.deps.openReadonly(this.deps.dbPath)
    return this.readonlyDb
  }

  /** 采集开启：先关只读再开写；已开写连接则复用（保持到退出） */
  ensureWritable(): { db: Db; openedThisTime: boolean } {
    if (this.writeDb) return { db: this.writeDb, openedThisTime: false }
    this.closeReadonly()
    this.writeDb = this.deps.openWritable(this.deps.dbPath)
    return { db: this.writeDb, openedThisTime: true }
  }

  /** 启动失败回滚：只关本次新开的写连接；复用中的连接保持不动 */
  releaseWritableIfNew(openedThisTime: boolean): void {
    if (!openedThisTime) return
    this.writeDb?.close()
    this.writeDb = null
  }

  closeAll(): void {
    this.closeReadonly()
    this.writeDb?.close()
    this.writeDb = null
  }

  private closeReadonly(): void {
    this.readonlyDb?.close()
    this.readonlyDb = null
  }
}

/* ------------------------------------------------------------------ *
 * 一次采集会话
 * ------------------------------------------------------------------ */

/** 屏幕捕获流（生产是 ScreenCapture，测试注入假实现） */
export interface CaptureStream {
  start(): Promise<void>
  capture(bounds: WindowBounds, tempDir: string, ts: number): Promise<CapturedFrame>
  dispose(): void
}

export interface CaptureSession {
  /** 当前会话的管线（halt / flush / stats 都在这里） */
  readonly pipeline: CapturePipeline
  /** 停采样调度与每日 stats 定时落盘（halt 之后同步调用） */
  stopTimers(): void
  /** 落盘一次 stats（含跨午夜换 key） */
  flushStats(): void
  /** 释放屏幕流（异步允许；不阻塞视觉切换） */
  disposeScreenStream(): Promise<void>
  /** 关闭 OCR 子进程（会拒绝在途请求） */
  disposeOcr(): Promise<void>
}

export interface CaptureSessionDeps {
  userDataDir: string
  /** electron-vite dev 的 renderer 地址（生产为空，走 captureHtmlPath） */
  devServerUrl?: string
  captureHtmlPath: string
  now(): number
  /** 打开写连接（调用方保证先关只读）；openedThisTime 用于失败回滚 */
  ensureWriteDb(): { db: Db; openedThisTime: boolean }
  /** 释放本次新开的写连接（复用连接不关） */
  releaseWriteDb(openedThisTime: boolean): void
  createScreenStream(): CaptureStream
  createOcr(): OcrEngine
  getActiveWindow(): Promise<WindowInfo | null>
  isBlacklisted(window: WindowInfo): boolean
  /** capture.save_shots=1 时把临时帧另存为 <event_id>.jpg */
  saveShot?(eventId: number, imagePath: string, shotsDir: string): void
  log: CaptureLog
  /** 测试注入：默认 2s 采样调度 */
  createScheduler?(onTick: () => Promise<void>): SchedulerHandle
  /** 测试注入：默认 setInterval */
  setFlushTimer?(fn: () => void, ms: number): unknown
  /** 测试注入：默认 clearInterval */
  clearFlushTimer?(handle: unknown): void
}

/**
 * 装配一次采集会话（db 连接由调用方的 CaptureDbConnections 提供）。
 *
 * 失败路径负责把已建资源清干净（调度器 / 屏幕流 / OCR / 本次新开的写连接），
 * 再抛出给 CaptureController 回落到 paused。
 */
export async function createCaptureSession(deps: CaptureSessionDeps): Promise<CaptureSession> {
  const setFlushTimer =
    deps.setFlushTimer ??
    ((fn: () => void, ms: number): unknown => setInterval(fn, ms) as unknown)
  const clearFlushTimer =
    deps.clearFlushTimer ??
    ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>))
  const createScheduler =
    deps.createScheduler ??
    ((onTick: () => Promise<void>): SchedulerHandle =>
      startScheduler({ intervalMs: SCHEDULER_INTERVAL_MS, now: deps.now, onTick }))

  let openedThisTime = false
  let stream: CaptureStream | null = null
  let ocr: OcrEngine | null = null
  let scheduler: SchedulerHandle | null = null
  let flushTimer: unknown = null
  let flushTimerSet = false

  const stopTimers = (): void => {
    scheduler?.stop()
    scheduler = null
    if (flushTimerSet) {
      clearFlushTimer(flushTimer)
      flushTimerSet = false
    }
  }

  const rollback = async (): Promise<void> => {
    stopTimers()
    stream?.dispose()
    stream = null
    if (ocr) {
      await ocr.dispose().catch(() => {})
      ocr = null
    }
    deps.releaseWriteDb(openedThisTime)
    openedThisTime = false
  }

  try {
    const ensured = deps.ensureWriteDb()
    const db = ensured.db
    openedThisTime = ensured.openedThisTime

    const tempDir = join(deps.userDataDir, 'tmp')
    const shotsDir = join(deps.userDataDir, 'shots')
    mkdirSync(tempDir, { recursive: true })
    const saveShot = deps.saveShot
    const saveShots = saveShot !== undefined && getNumberSetting(db, 'capture.save_shots', 0) === 1
    if (saveShots) mkdirSync(shotsDir, { recursive: true })

    // 屏幕流起不来视为启动失败：不进入「running 但没在采」（§3 Phase 2 契约）
    const screen = deps.createScreenStream()
    stream = screen
    await screen.start()

    const engine = deps.createOcr()
    ocr = engine

    const pipeline = new CapturePipeline({
      db,
      ocr: engine,
      now: deps.now,
      getActiveWindow: deps.getActiveWindow,
      captureWindow: (bounds) => screen.capture(bounds, tempDir, deps.now()),
      deleteFrame: (imagePath) => rmSync(imagePath, { force: true }),
      isBlacklisted: deps.isBlacklisted,
      saveShot:
        saveShots && saveShot
          ? (eventId, imagePath) => saveShot(eventId, imagePath, shotsDir)
          : undefined,
      diffThreshold: getNumberSetting(db, 'capture.diff_threshold', 8),
      initialStats: loadStats(db, statsKey(deps.now())),
      log: (entry) => deps.log(entry.level, entry.msg, entry.data)
    })

    scheduler = createScheduler(() => pipeline.tick())
    const flusher = createDailyStatsFlusher({
      db,
      counter: pipeline,
      now: deps.now,
      key: statsKey(deps.now())
    })
    flushTimer = setFlushTimer(() => flusher.flush(), FLUSH_INTERVAL_MS)
    flushTimerSet = true

    deps.log('info', `started schema=v1 db=${DB_FILE_NAME}`)

    return {
      pipeline,
      stopTimers,
      flushStats: () => flusher.flush(),
      disposeScreenStream: async () => {
        stream?.dispose()
        stream = null
      },
      disposeOcr: async () => {
        const target = ocr
        ocr = null
        await target?.dispose().catch(() => {})
      }
    }
  } catch (error) {
    await rollback()
    deps.log('error', 'capture session create failed', { error: String(error) })
    throw error
  }
}

/* ------------------------------------------------------------------ *
 * 控制器状态机
 * ------------------------------------------------------------------ */

export interface CaptureControllerDeps {
  createSession(): Promise<CaptureSession>
  log?: CaptureLog
  /** 状态切换回调（Phase 2 球 / 托盘订阅；stop 时在 halt 之后同步触发） */
  onStatusChange?(status: CaptureStatus): void
}

export class CaptureController {
  private statusValue: CaptureStatus = 'paused'
  private session: CaptureSession | null = null
  private chain: Promise<void> = Promise.resolve()
  private inFlight: { kind: 'start' | 'stop'; promise: Promise<void> } | null = null

  constructor(private readonly deps: CaptureControllerDeps) {}

  status(): CaptureStatus {
    return this.statusValue
  }

  start(): Promise<void> {
    if (this.inFlight?.kind === 'start') return this.inFlight.promise
    return this.enqueue('start')
  }

  stop(): Promise<void> {
    if (this.inFlight?.kind === 'stop') return this.inFlight.promise
    return this.enqueue('stop')
  }

  toggle(): Promise<void> {
    return this.statusValue === 'running' || this.statusValue === 'starting'
      ? this.stop()
      : this.start()
  }

  private enqueue(kind: 'start' | 'stop'): Promise<void> {
    const run = this.chain.then(() => (kind === 'start' ? this.doStart() : this.doStop()))
    // 链本身永不 reject，失败只传给调用方，不让后续转换被跳过
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    this.inFlight = { kind, promise: run }
    const clear = (): void => {
      if (this.inFlight?.promise === run) this.inFlight = null
    }
    run.then(clear, clear)
    return run
  }

  private setStatus(status: CaptureStatus): void {
    this.statusValue = status
    this.deps.onStatusChange?.(status)
  }

  private async doStart(): Promise<void> {
    if (this.statusValue === 'running') return
    this.setStatus('starting')
    try {
      const session = await this.deps.createSession()
      this.session = session
      this.setStatus('running')
      this.deps.log?.('info', 'capture started')
    } catch (error) {
      this.session = null
      this.setStatus('paused')
      this.deps.log?.('error', 'capture start failed', { error: String(error) })
      throw error
    }
  }

  private async doStop(): Promise<void> {
    if (this.statusValue === 'paused') return
    const session = this.session
    this.session = null
    if (!session) {
      this.setStatus('paused')
      return
    }

    session.pipeline.halt() // ① 同步关闸（清队列、删帧）
    this.setStatus('stopping') // ② 闸已关，视觉可立即切暂停；不等后续释放
    session.stopTimers() // ③

    const errors: unknown[] = []
    const attempt = async (task: () => void | Promise<void>): Promise<void> => {
      try {
        await task()
      } catch (error) {
        errors.push(error)
      }
    }

    // ④ 屏幕流释放与在途 OCR 收尾并行；视觉已切，不阻塞。
    // 先取消 OCR 再 flush：子进程启动挂起 / 无响应时 dispose 会拒绝在途 recognize，
    // flush 不会无限等着一个永远不返回的 OCR（F07）。
    const streamDisposal = attempt(() => session.disposeScreenStream())
    await attempt(() => session.disposeOcr())
    await attempt(() => session.pipeline.flush())
    await attempt(() => session.flushStats())
    await streamDisposal

    this.setStatus('paused')
    if (errors.length > 0) {
      this.deps.log?.('error', 'capture stop cleanup failed', {
        errors: errors.map((error) => String(error))
      })
    }
  }
}
