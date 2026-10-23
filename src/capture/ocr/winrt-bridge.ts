/**
 * WinRT OCR 桥（m1a-plan §3 Phase 2a 结论：候选① 长驻 PowerShell 子进程）
 *
 * Node ⇄ powershell.exe（5.1）通过 stdin/stdout 行式 JSON 协议：
 *   启动后脚本先输出 {"ready":true}
 *   请求  {"id":1,"path":"C:\\...\\frame.png"}
 *   响应  {"id":1,"ok":true,"ms":43,"text":"..."} / {"id":1,"ok":false,"error":"..."}
 *
 * 单请求串行；超时/子进程退出都会让等待中的请求失败，由调用方计错误。
 *
 * 状态管理（F07）：
 * - ready 等待有启动超时：脚本不输出 ready 时不会让 recognize / flush 永久挂起；
 * - error / exit / stdin 错误统一拒绝在途请求与 ready 等待、重置状态，下次 recognize
 *   重新拉起子进程（带冷却，避免坏脚本每个采样周期都 spawn 一个进程）；
 * - dispose 会拒绝 pending 请求与 ready 等待并结束子进程（停止采集时用于取消，而非等满超时）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { OcrEngine, OcrResult } from './engine'

export interface WinrtBridgeOptions {
  /** resources/ocr/winrt-ocr.ps1 的绝对路径 */
  scriptPath: string
  powershellPath?: string
  /** 单次识别请求超时（默认 10s） */
  timeoutMs?: number
  /** 等待脚本输出 ready 的超时（默认 15s；PowerShell + WinRT 语言引擎冷启动） */
  startupTimeoutMs?: number
  /** 启动失败 / 崩溃后的重启冷却（默认 5s），避免坏脚本每 tick 拉起新进程 */
  restartCooldownMs?: number
  /** 测试注入：替换 spawn（默认 node:child_process.spawn） */
  spawnImpl?: typeof spawn
}

interface PendingRequest {
  resolve: (result: OcrResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface BridgeMessage {
  ready?: boolean
  id?: number
  ok?: boolean
  ms?: number
  text?: string
  error?: string
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_RESTART_COOLDOWN_MS = 5_000

export class WinrtOcrBridge implements OcrEngine {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private pending = new Map<number, PendingRequest>()
  private seq = 0
  private ready: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private retryAfter = 0
  private closed = false

  constructor(private readonly options: WinrtBridgeOptions) {}

  async recognize(imagePath: string): Promise<OcrResult> {
    await this.ensureReady()
    const child = this.child
    if (!child || child.stdin.destroyed) {
      // ready 后子进程已退出：直接失败，避免往空管道写、白等满请求超时
      throw new Error('OCR 子进程不可用')
    }
    const id = ++this.seq
    const timeoutMs = this.options.timeoutMs ?? 10_000

    return await new Promise<OcrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`OCR 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, path: imagePath })}\n`)
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('OCR 子进程写入失败'))
      }
    })
  }

  async dispose(): Promise<void> {
    this.closed = true
    const error = new Error('OCR 桥已关闭')
    this.failAll(error)
    this.readyReject?.(error)
    const child = this.child
    this.resetChild()
    if (child) {
      child.stdin.end()
      child.kill()
    }
    this.retryAfter = 0
  }

  private ensureReady(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('OCR 桥已关闭'))
    if (this.ready) return this.ready
    const waitMs = this.retryAfter - Date.now()
    if (waitMs > 0) {
      return Promise.reject(new Error(`OCR 子进程启动失败，${Math.ceil(waitMs / 1000)}s 后重试`))
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
      this.failAndReset(child, new Error(`OCR 子进程退出（code=${code ?? 'null'}）`))
    })
    // stdin 写入失败（EPIPE 等）同样按子进程故障处理，避免 unhandled 'error'
    child.stdin.on('error', () => {
      this.failAndReset(child, new Error('OCR 子进程 stdin 错误'))
    })
    // stderr 丢弃：避免 OCR 原文经错误信息落日志
    child.stderr.resume()
    this.reader.on('line', (line) => this.handleLine(line))
  }

  private armStartupTimeout(child: ChildProcessWithoutNullStreams): void {
    this.clearStartupTimer()
    const startupMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.failAndReset(child, new Error(`OCR 子进程启动超时（${startupMs}ms）`))
    }, startupMs)
  }

  private handleLine(line: string): void {
    let message: BridgeMessage
    try {
      message = JSON.parse(line) as BridgeMessage
    } catch {
      return
    }
    if (message.ready) {
      this.clearStartupTimer()
      const resolve = this.readyResolve
      this.readyResolve = null
      this.readyReject = null
      resolve?.()
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) {
      pending.resolve({ text: message.text ?? '', ms: message.ms ?? 0 })
    } else {
      pending.reject(new Error(message.error ?? 'OCR 失败'))
    }
  }

  /** 子进程故障：拒绝 ready 等待与在途请求、重置状态、拉黑冷却后允许下次重拉 */
  private failAndReset(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.closed) return
    // 只处理当前子进程；dispose / 已重置后的迟到事件忽略
    if (child !== this.child) return
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
