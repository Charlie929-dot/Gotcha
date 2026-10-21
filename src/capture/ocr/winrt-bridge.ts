/**
 * WinRT OCR 桥（m1a-plan §3 Phase 2a 结论：候选① 长驻 PowerShell 子进程）
 *
 * Node ⇄ powershell.exe（5.1）通过 stdin/stdout 行式 JSON 协议：
 *   启动后脚本先输出 {"ready":true}
 *   请求  {"id":1,"path":"C:\\...\\frame.png"}
 *   响应  {"id":1,"ok":true,"ms":43,"text":"..."} / {"id":1,"ok":false,"error":"..."}
 *
 * 单请求串行；超时/子进程退出都会让等待中的请求失败，由调用方计错误。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { OcrEngine, OcrResult } from './engine'

export interface WinrtBridgeOptions {
  /** resources/ocr/winrt-ocr.ps1 的绝对路径 */
  scriptPath: string
  powershellPath?: string
  timeoutMs?: number
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

export class WinrtOcrBridge implements OcrEngine {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private pending = new Map<number, PendingRequest>()
  private seq = 0
  private ready: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null

  constructor(private readonly options: WinrtBridgeOptions) {}

  async recognize(imagePath: string): Promise<OcrResult> {
    await this.ensureReady()
    const id = ++this.seq
    const timeoutMs = this.options.timeoutMs ?? 10_000

    return await new Promise<OcrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`OCR 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin.write(`${JSON.stringify({ id, path: imagePath })}\n`)
    })
  }

  async dispose(): Promise<void> {
    this.failAll(new Error('OCR 桥已关闭'))
    this.reader?.close()
    this.reader = null
    const child = this.child
    this.child = null
    if (child) {
      child.stdin.end()
      child.kill()
    }
    this.ready = null
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.spawnChild()
    })
    return this.ready
  }

  private spawnChild(): void {
    const powershell = this.options.powershellPath ?? 'powershell.exe'
    const child = spawn(
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
    )
    this.child = child
    this.reader = createInterface({ input: child.stdout })

    const fail = (error: Error): void => {
      this.failAll(error)
      this.readyReject?.(error)
    }
    child.on('error', fail)
    child.on('exit', (code) => {
      this.child = null
      this.failAll(new Error(`OCR 子进程退出（code=${code ?? 'null'}）`))
    })
    // stderr 丢弃：避免 OCR 原文经错误信息落日志
    child.stderr.resume()
    this.reader.on('line', (line) => this.handleLine(line))
  }

  private handleLine(line: string): void {
    let message: BridgeMessage
    try {
      message = JSON.parse(line) as BridgeMessage
    } catch {
      return
    }
    if (message.ready) {
      this.readyResolve?.()
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

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
