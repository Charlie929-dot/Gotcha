/**
 * 临时帧存储（F06）
 *
 * 文件桥模式下每帧 PNG 先写 `userData/tmp/frame-<ts>.png`，OCR 完立即删除。
 * 强退 / 崩溃 / 删除失败会留下残留：下次应用启动时按「受控目录 + 文件名白名单」
 * 清理，只删本应用生成的帧文件，目录里的其它文件一律不动。
 *
 * 2026-10-28 性能方案 P0-4：白名单可配置。`tmp-chain` 里证据图临时帧（`frame-<ts>.jpg`）
 * 与 OCR 中转图（`ocr-<ts>.png`）以前从来没人清（实测 112 个孤立 PNG = 388 MB），
 * 现在启动清理按模式表 + 最小年龄扫它。
 *
 * 不在日志 / 返回值里出现文件路径（路径可能带用户名）：调用方只记数量与错误码。
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface TempCleanupResult {
  removed: number
  failed: number
}

export interface TempCleanupOptions {
  /** 文件名白名单（默认只认 `frame-<ts>.png`） */
  patterns?: readonly RegExp[]
  /**
   * 只删「修改时间早于 now - olderThanMs」的文件（默认 0 = 一律删）。
   * 与另一个进程共用目录时用它留出安全边际。
   */
  olderThanMs?: number
  /** 时钟（单测注入） */
  now?: () => number
}

/** 截图层写盘命名：`frame-${Date.now()}.png`（screen-stream.ts 旧口径） */
export const FRAME_FILE_PATTERN = /^frame-\d+\.png$/

/** 证据图临时帧：`frame-<ts>.png` / `frame-<ts>.jpg`（chain-shot 抓完会 rename 走） */
export const CHAIN_FRAME_FILE_PATTERN = /^frame-\d+\.(?:png|jpg)$/

/** OCR 中转图：`ocr-<ts>.png`（内容车道读完就删，残留同理） */
export const OCR_FILE_PATTERN = /^ocr-\d+\.png$/

/**
 * 清理 temp 目录里上次会话残留的帧文件。
 * 目录不存在 / 不可读时返回 0，不抛错（启动路径不能因清理失败而中断）。
 */
export function cleanStaleFrames(dir: string, options: TempCleanupOptions = {}): TempCleanupResult {  const patterns = options.patterns ?? [FRAME_FILE_PATTERN]
  const olderThanMs = Math.max(0, options.olderThanMs ?? 0)
  const cutoff = (options.now ?? Date.now)() - olderThanMs
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { removed: 0, failed: 0 }
  }
  let removed = 0
  let failed = 0
  for (const name of entries) {
    if (!patterns.some((pattern) => pattern.test(name))) continue
    const path = join(dir, name)
    if (olderThanMs > 0) {
      try {
        if (statSync(path).mtimeMs > cutoff) continue
      } catch {
        // 读不到 mtime（刚被别的进程删掉）就跳过，不算失败
        continue
      }
    }
    try {
      rmSync(path, { force: true })
      removed++
    } catch {
      failed++
    }
  }
  return { removed, failed }
}

/* ------------------------------------------------------------------ */
/* 周期清理（长会话兜底）                                               */
/* ------------------------------------------------------------------ */

export interface TempJanitorTarget {
  dir: string
  patterns: readonly RegExp[]
  /** 只删早于 `now - olderThanMs` 的文件；周期清理必须给正值，别删到在途的帧 */
  olderThanMs: number
}

export interface TempJanitorOptions {
  targets: readonly TempJanitorTarget[]
  /** 扫描间隔（默认 10 分钟） */
  intervalMs?: number
  now?: () => number
  /** 单测注入：默认 setInterval */
  schedule?: (fn: () => void, ms: number) => unknown
  /** 单测注入：默认 clearInterval */
  cancel?: (handle: unknown) => void
  log?: (level: 'info' | 'warn', message: string, data: Record<string, unknown>) => void
}

export interface TempJanitor {
  /** 立即扫一遍（启动时也可直接调） */
  run(): TempCleanupResult
  /** 开始周期扫描；重复调用不会叠加定时器 */
  start(): void
  stop(): void
}

const DEFAULT_JANITOR_INTERVAL_MS = 10 * 60 * 1000

/**
 * 周期清理 temp 目录。
 *
 * 为什么需要：`tmp-chain` 的 OCR 中转图正常在读完后删，但删除会因句柄被占而失败
 * （Windows 上 OCR 子进程还开着），失败后以前只能等下次启动清理——长会话（几天不重启）
 * 就一直涨。这里每 10 分钟按「15 分钟前的残留」扫一遍，把稳态压在一小时以内；
 * 启动清理仍然负责崩溃残留（>1h）。
 */
export function createTempJanitor(options: TempJanitorOptions): TempJanitor {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_JANITOR_INTERVAL_MS)
  const schedule = options.schedule ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const cancel = options.cancel ?? ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>))
  let handle: unknown = null
  let running = false

  const run = (): TempCleanupResult => {
    const total: TempCleanupResult = { removed: 0, failed: 0 }
    for (const target of options.targets) {
      const result = cleanStaleFrames(target.dir, {
        patterns: target.patterns,
        olderThanMs: target.olderThanMs,
        ...(options.now ? { now: options.now } : {})
      })
      total.removed += result.removed
      total.failed += result.failed
    }
    // 没事不写日志：每 10 分钟一条 info 会把 main.log 刷满
    if (total.removed > 0 || total.failed > 0) {
      options.log?.(total.failed > 0 ? 'warn' : 'info', 'temp frames janitor', {
        removed: total.removed,
        failed: total.failed
      })
    }
    return total
  }

  return {
    run,
    start(): void {
      if (running) return
      running = true
      const timer = schedule(() => run(), intervalMs)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        ;(timer as { unref: () => void }).unref()
      }
      handle = timer
    },
    stop(): void {
      if (!running) return
      running = false
      cancel(handle)
      handle = null
    }
  }
}
