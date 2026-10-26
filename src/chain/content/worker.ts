/**
 * 信息链 · PowerShell 行式 JSON 长驻工作器（UIA 文本来源的地基，D43）
 *
 * 与 `src/capture/ocr/winrt-bridge.ts` 同构（启动输出 `{"ready":true}`，之后一行一请求一行一响应），
 * 但多一条这里必须有的纪律：**请求超时要把子进程杀掉**。
 * UIA 在巨树 / 卡死的窗口上可能永久挂住（探针实测 firefox 2–4s，个别窗口 10s 不完）；
 * 只拒绝在途请求而不杀进程，卡住的子进程会让后续每次请求都排队等死（看起来像「内容来源整体坏掉」）。
 *
 * 其它状态管理照旧：启动超时、子进程崩溃立即拒绝在途请求、重启冷却（避免每个采样周期都 spawn）、
 * dispose 结束子进程。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

export type WorkerLog = (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void

export interface PowerShellJsonWorkerOptions {
  /** 长驻脚本的绝对路径（如 `resources/chain/uia-text.ps1`） */
  scriptPath: string
  powershellPath?: string
  /** 单次请求超时（默认 5s）；超时即杀子进程并进入重启冷却 */
  requestTimeoutMs?: number
  /** 等待脚本输出 ready 的超时（默认 15s） */
  startupTimeoutMs?: number
  /** 启动失败 / 崩溃 / 超时后的重启冷却（默认 5s） */
  restartCooldownMs?: number
  /** 测试注入：替换 spawn */
  spawnImpl?: typeof spawn
  log?: WorkerLog
}

interface PendingRequest {
  resolve: (message: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_RESTART_COOLDOWN_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

export class PowerShellJsonWorker {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private seq = 0
  private ready: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private retryAfter = 0
  private closed = false

  constructor(private readonly options: PowerShellJsonWorkerOptions) {}

  /**
   * 发一条请求，返回整条响应（`ok` 由调用方解释）。
   * 请求是串行的：同一个工作器同时只应该有一个在途请求（调用方负责排队）。
   */
  async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('子进程工作器已关闭')
    await this.ensureReady()
    const child = this.child
    if (!child || child.stdin.destroyed) throw new Error('子进程不可用')
    const id = ++this.seq
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时的子进程可能已经卡死：拒绝在途请求 + 杀掉它，冷却后下次重拉
        this.failAndReset(child, new Error(`子进程请求超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('子进程写入失败'))
        this.failAndReset(child, new Error('子进程 stdin 错误'))
      }
    })
  }

  async dispose(): Promise<void> {
    this.closed = true
    const error = new Error('子进程工作器已关闭')
    this.failAll(error)
    this.readyReject?.(error)
    const child = this.child
    this.resetChild()
    if (child) {
      try {
        child.stdin.end()
      } catch {
        // stdin 可能已经断了
      }
      try {
        child.kill()
      } catch {
        // 子进程可能已退出
      }
    }
  }

  /* ---------------------------------------------------------------- */

  private ensureReady(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('子进程工作器已关闭'))
    if (this.ready) return this.ready
    const waitMs = this.retryAfter - Date.now()
    if (waitMs > 0) {
      return Promise.reject(new Error(`子进程启动失败，${Math.ceil(waitMs / 1000)}s 后重试`))
    }
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.spawnChild()
    })
    return this.ready
  }

  private spawnChild(): void {
    const spawnImpl = this.options.spawnImpl ?? spawn
    const powershell = this.options.powershellPath ?? 'powershell.exe'
    const child = spawnImpl(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.options.scriptPath
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    ) as ChildProcessWithoutNullStreams
    this.child = child
    this.reader = createInterface({ input: child.stdout })
    this.armStartupTimeout(child)

    child.on('error', (error) => {
      this.failAndReset(child, error instanceof Error ? error : new Error(String(error)))
    })
    child.on('exit', (code) => {
      this.failAndReset(child, new Error(`子进程退出（code=${code ?? 'null'}）`))
    })
    child.stdin.on('error', () => {
      this.failAndReset(child, new Error('子进程 stdin 错误'))
    })
    // stderr 丢弃：避免文本内容经错误信息落日志
    child.stderr.resume()
    this.reader.on('line', (line) => this.handleLine(line))
  }

  private armStartupTimeout(child: ChildProcessWithoutNullStreams): void {
    this.clearStartupTimer()
    const startupMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.failAndReset(child, new Error(`子进程启动超时（${startupMs}ms）`))
    }, startupMs)
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.options.log?.('warn', 'worker: unparsable line', { length: line.length })
      return
    }
    if (message?.['ready'] === true) {
      this.clearStartupTimer()
      const resolve = this.readyResolve
      this.readyResolve = null
      this.readyReject = null
      resolve?.()
      return
    }
    const id = message?.['id']
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(message)
  }

  /** 子进程故障 / 超时：拒绝在途请求、重置状态、冷却后允许重拉 */
  private failAndReset(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.closed) return
    if (child !== this.child) return
    this.options.log?.('warn', 'worker: reset', { error: error.message })
    this.failAll(error)
    this.readyReject?.(error)
    this.resetChild()
    this.retryAfter = Date.now() + (this.options.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS)
    try {
      child.kill()
    } catch {
      // 子进程可能已退出
    }
  }

  private resetChild(): void {
    this.clearStartupTimer()
    this.reader?.close()
    this.reader = null
    this.child = null
    this.ready = null
    this.readyResolve = null
    this.readyReject = null
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
