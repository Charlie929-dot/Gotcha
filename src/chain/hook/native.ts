/**
 * 信息链 · 原生事件源（N-API addon 的加载与适配）
 *
 * 三条纪律（D41）：
 * 1. **加载失败必须降级**：`try require` 失败（没编译、Electron 升级、被 AV 拦）不能把应用带崩，
 *    返回 null，由上层决定「无采集」还是「换备用源」，并把当前源的实际情况写进状态。
 * 2. **不信任原生层给的对象**：跨 ABI 边界传回来的都是 `unknown`，逐字段校验后才当 `RawDesktopEvent`，
 *    不合格的直接丢——宁可少一条事件，也不让脏数据进证据链。
 * 3. **原生层只做管道**：这里只做「形状校验 + 字段改名」，不做任何采集策略。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DesktopEventSource, RawDesktopEvent, SourceInfo } from './types'

export const NATIVE_MODULE_FILE = 'chain_hook.node'

/** 原生模块导出的最小形状 */
export interface NativeBinding {
  start(callback: (event: unknown) => void): void
  stop(): void
  lastInputTickMs(): number
  version?: string
}

const requireFromHere = createRequire(import.meta.url) as NodeRequire

/**
 * 候选路径：先开发构建（仓库内 `native/chain-hook/build/Release`），
 * 再打包后的 `resources/native`。存在性检查与 require 都可注入，便于单测。
 */
export function nativeCandidates(repoRoot: string, resourcesPath?: string): string[] {
  const candidates = [join(repoRoot, 'native', 'chain-hook', 'build', 'Release', NATIVE_MODULE_FILE)]
  if (resourcesPath) candidates.push(join(resourcesPath, 'native', NATIVE_MODULE_FILE))
  return candidates
}

export interface LoadOptions {
  candidates: string[]
  exists?: (path: string) => boolean
  load?: (path: string) => unknown
}

/** 加载原生模块；任何一个候选加载成功即可，否则返回 null（不抛错） */
export function loadNativeBinding(options: LoadOptions): NativeBinding | null {
  const exists = options.exists ?? existsSync
  const load = options.load ?? ((path: string) => requireFromHere(path))
  for (const candidate of options.candidates) {
    if (!exists(candidate)) continue
    try {
      const loaded = load(candidate)
      if (isNativeBinding(loaded)) return loaded
    } catch {
      // 加载失败就试下一个候选：可能是给错了运行时（ABI / 平台）
    }
  }
  return null
}

export function isNativeBinding(value: unknown): value is NativeBinding {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.start === 'function' &&
    typeof record.stop === 'function' &&
    typeof record.lastInputTickMs === 'function'
  )
}

/* ------------------------------------------------------------------ */
/* 形状校验                                                            */
/* ------------------------------------------------------------------ */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 原生对象 → `RawDesktopEvent`。任何一处不合格就返回 null（丢弃这条），
 * 不做「猜一个默认值」的修补。
 */
export function normalizeRawEvent(raw: unknown): RawDesktopEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const type = value.type
  if (!isFiniteNumber(value.ts)) return null
  const ts = value.ts

  if (type === 'foreground') {
    if (!isFiniteNumber(value.pid) || !isFiniteNumber(value.hwnd)) return null
    const exe = asString(value.exe)
    if (exe === null) return null
    const event: Extract<RawDesktopEvent, { type: 'foreground' }> = {
      type: 'foreground',
      ts,
      pid: value.pid,
      hwnd: value.hwnd,
      exe,
      title: asString(value.title) ?? '',
      app: asString(value.app) || null
    }
    // 窗口事实（v0.12）：报了就必须合格，不合格整条丢掉；没报就留空（段机按「未知」放行）
    if (value.visible !== undefined) {
      if (typeof value.visible !== 'boolean') return null
      event.visible = value.visible
    }
    if (value.minimized !== undefined) {
      if (typeof value.minimized !== 'boolean') return null
      event.minimized = value.minimized
    }
    if (value.onScreenArea !== undefined) {
      if (!isFiniteNumber(value.onScreenArea) || value.onScreenArea < 0) return null
      event.onScreenArea = value.onScreenArea
    }
    if (value.className !== undefined) {
      const className = asString(value.className)
      if (className === null) return null
      event.className = className
    }
    return event
  }

  if (type === 'move') {
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null
    return { type: 'move', ts, x: value.x, y: value.y }
  }

  if (type === 'click') {
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null
    const button = value.button
    if (button !== 'left' && button !== 'right' && button !== 'middle') return null
    return { type: 'click', ts, x: value.x, y: value.y, button }
  }

  if (type === 'wheel') {
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.delta)) return null
    return { type: 'wheel', ts, x: value.x, y: value.y, delta: value.delta }
  }

  return null
}

/* ------------------------------------------------------------------ */
/* 事件源                                                              */
/* ------------------------------------------------------------------ */

export class NativeDesktopSource implements DesktopEventSource {
  private readonly binding: NativeBinding
  readonly sourceInfo: SourceInfo

  constructor(binding: NativeBinding) {
    this.binding = binding
    this.sourceInfo = {
      kind: 'native',
      detail: binding.version ? `chain_hook ${binding.version}` : 'chain_hook'
    }
  }

  start(onEvent: (event: RawDesktopEvent) => void): void {
    this.binding.start((raw) => {
      const event = normalizeRawEvent(raw)
      // 不合格的原生事件直接丢：不进证据链，也不报错刷屏
      if (event) onEvent(event)
    })
  }

  stop(): void {
    this.binding.stop()
  }

  lastInputTickMs(): number {
    return this.binding.lastInputTickMs()
  }
}
