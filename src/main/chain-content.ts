/**
 * 信息链 · 内容来源接进采集（D43）
 *
 * 两块：
 * 1. `createChainContentReader`：把 UIA 工作器（`resources/chain/uia-text.ps1` 长驻 PowerShell）、
 *    OCR 兜底（`WinrtOcrBridge`）和取用策略（`chain/content/reader.ts`）装成一条读取链。
 * 2. `createChainContentCapture`：**内容车道**——抓帧提交后异步读文本，按段 15s 节流，串行执行。
 *
 * 为什么内容读取**不放在抓帧队列里**：抓帧冷却 2s、UIA 单次 0.8–4s。放进同一个串行队列，
 * 一次巨树读取会让后面每一张证据都晚到，晚到的帧前台早已切走 → 证据被身份校验丢掉。
 * 证据优先，内容随后：读不回来最多少一段文字，不该反过来拖垮证据。
 *
 * 时刻口径：`captured_at` 用**触发事件**的时刻（和截图一致），不因读取慢而漂。
 */
import { rmSync } from 'node:fs'
import type { ContentPayload } from '../chain/recorder'
import {
  createContentReader,
  type ContentLog,
  type ContentReader,
  type OcrLike
} from '../chain/content/reader'
import { createUiaTextReader } from '../chain/content/uia'
import { PowerShellJsonWorker } from '../chain/content/worker'
import { WinrtOcrBridge } from '../capture/ocr/winrt-bridge'

/** 一张证据截图落定后交给内容车道的形状（来自 `chain-shot.ts` 的 `onShot`） */
export interface ChainContentShot {
  segmentId: number
  eventId: number
  /** 触发事件时刻（也是 `captured_at`） */
  at: number
  /** 段身份对应窗口的句柄 */
  hwnd: number
  executable: string
  /** 这次抓帧落下的证据图（长期保存的那份） */
  framePath: string
  /** 同一次抓帧另出的 2× PNG（只给 OCR；读完删掉，省得 tmp-chain 越积越多） */
  ocrPath?: string
}

export interface ChainContentStats {
  /** 进入车道的读数（不含被节流跳过的） */
  queued: number
  /** 同段 15s 内被节流跳过的 */
  throttled: number
  /** 落成 `chain_content` 行的 */
  inserted: number
  /** 读到了但正文没变（指纹去重，不重复落行） */
  duplicates: number
  /** UIA / OCR 都没拿到 */
  empty: number
  /** 读取或写库抛错 */
  failed: number
}

export interface ChainContentCaptureOptions {
  reader: Pick<ContentReader, 'read'>
  /** 写进库（`chain-recording` 传 `runtime.recordContentFor`）；返回 false 表示去重丢掉 */
  onContent: (segmentId: number, at: number, payload: ContentPayload) => boolean
  /** 同段两次读数的最小间隔（默认 15s；换段后第一次必读） */
  minIntervalMs?: number
  now?: () => number
  log?: ContentLog
}

export interface ChainContentCapture {
  /** 一张证据落定：满足节流就排一条读数（不阻塞抓帧） */
  onShot(shot: ChainContentShot): void
  /** 等在途读数写完（暂停 / 退出前必须 await） */
  drain(): Promise<void>
  /** 不再接收新截图（在途的仍由 drain 等） */
  close(): void
  readonly stats: ChainContentStats
}

const DEFAULT_MIN_INTERVAL_MS = 15_000

export function createChainContentCapture(options: ChainContentCaptureOptions): ChainContentCapture {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  const log = options.log
  const stats: ChainContentStats = {
    queued: 0,
    throttled: 0,
    inserted: 0,
    duplicates: 0,
    empty: 0,
    failed: 0
  }
  /** 读数串行车道：UIA 工作器一次只服务一个请求，顺序也才和事件顺序一致 */
  let lane: Promise<void> = Promise.resolve()
  let closed = false
  let lastSegmentId: number | null = null
  let lastReadAt = 0

  /**
   * OCR 中转图是临时文件（2× PNG，单张 2–7 MB）：**读到、被节流、车道已关**都要删。
   * 以前只在读完之后删，被节流的帧（同段 15 s 内的第二张起，约占抓帧的 38%）永远没人读，
   * 文件就留在 tmp-chain 里——实测 1.5 h 攒了 94 个 / 213 MB，折合 ~200 MB/h。
   * 删不掉（句柄被 OCR 子进程占着）就留给启动清理，不抛错。
   */
  const discardOcr = (path: string | undefined): void => {
    if (!path) return
    try {
      rmSync(path, { force: true })
    } catch {
      // 删不掉就留给启动清理
    }
  }

  const run = async (shot: ChainContentShot): Promise<void> => {
    try {
      const payload = await options.reader.read({
        hwnd: shot.hwnd,
        executable: shot.executable,
        // OCR 读 2× 的那张（字认得出）；没有就用证据图本身
        framePath: shot.ocrPath ?? shot.framePath
      })
      if (!payload) {
        stats.empty += 1
        return
      }
      if (options.onContent(shot.segmentId, shot.at, payload)) {
        stats.inserted += 1
      } else {
        stats.duplicates += 1
      }
    } catch (error) {
      stats.failed += 1
      log?.('warn', 'chain content failed', {
        segmentId: shot.segmentId,
        eventId: shot.eventId,
        error: String(error)
      })
    } finally {
      // OCR 副图是临时文件：读完（成功 / 失败 / 空）都清掉，别让 tmp-chain 长胖
      discardOcr(shot.ocrPath)
    }
  }

  return {
    onShot(shot: ChainContentShot): void {
      if (closed) {
        discardOcr(shot.ocrPath)
        return
      }
      const at = now()
      // 节流按「尝试读取」的时刻算：读失败也占一个窗口，免得坏窗口每张图都重试一遍
      if (shot.segmentId === lastSegmentId && at - lastReadAt < minIntervalMs) {
        stats.throttled += 1
        // 这张不会有人读了：OCR 中转图必须当场删，否则按抓帧频率堆在 tmp-chain 里
        discardOcr(shot.ocrPath)
        return
      }
      lastSegmentId = shot.segmentId
      lastReadAt = at
      stats.queued += 1
      lane = lane.then(() => run(shot))
    },
    async drain(): Promise<void> {
      let current = lane
      for (;;) {
        await current
        if (current === lane) return
        current = lane
      }
    },
    close(): void {
      closed = true
    },
    stats
  }
}

/* ------------------------------------------------------------------ */
/* 读取链装配                                                          */
/* ------------------------------------------------------------------ */

export interface ChainContentReaderOptions {
  /** UIA 工作器脚本（`resources/chain/uia-text.ps1`）；不给就不读 UIA */
  uiaScript?: string
  /** OCR 兜底脚本（`resources/ocr/winrt-ocr.ps1`）；不给就没有兜底 */
  ocrScript?: string
  /** UIA 单次读取超时（默认 3s；探针实测中位 0.8–1.4s，浏览器 2–4s） */
  uiaTimeoutMs?: number
  /** UIA 文本少于这么多字符就转 OCR（默认 200） */
  minUiaChars?: number
  /** 单条内容字符上限（默认 100k） */
  maxChars?: number
  log?: ContentLog
  /** 单测注入：OCR 引擎（默认 WinRT 桥） */
  createOcr?: () => OcrLike
  /** 单测注入：UIA 工作器（默认 PowerShellJsonWorker） */
  createWorker?: (scriptPath: string) => PowerShellJsonWorker
}

export interface ChainContentReader {
  read(input: Parameters<ContentReader['read']>[0]): Promise<ContentPayload | null>
  dispose(): Promise<void>
}

export function createChainContentReader(options: ChainContentReaderOptions): ChainContentReader {
  const log: ContentLog | undefined = options.log
  const uiaScript = options.uiaScript
  const ocrScript = options.ocrScript
  const worker: PowerShellJsonWorker | null = uiaScript
    ? (options.createWorker ??
        ((scriptPath) =>
          new PowerShellJsonWorker({
            scriptPath,
            requestTimeoutMs: options.uiaTimeoutMs ?? 3_000,
            log
          })))(uiaScript)
    : null
  const uia = worker ? createUiaTextReader({ worker, maxChars: options.maxChars }) : null
  const ocr: OcrLike | null = ocrScript
    ? (options.createOcr ?? (() => new WinrtOcrBridge({ scriptPath: ocrScript })))()
    : null
  const reader = createContentReader({
    uia,
    ocr,
    minUiaChars: options.minUiaChars,
    maxChars: options.maxChars,
    log
  })

  return {
    read: (input) => reader.read(input),
    async dispose(): Promise<void> {
      await worker?.dispose()
      await ocr?.dispose?.()
    }
  }
}
