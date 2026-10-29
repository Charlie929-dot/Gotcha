/**
 * 个人记忆 · 设置抽屉（日记目录 + 人设）的主进程侧
 *
 * 只做两件事：
 * - `parseMemoryPatch`：把渲染层来的 patch 钳成合法值（目录必须存在、名字 / 口吻 / 红线长度与条数）；
 * - `buildMemorySettingsView` / `applyMemoryPatch`：读写 settings 表并组装界面视图。
 *
 * **同步不在这里**：`syncVault` 要开写连接、补链库表，属于组合根（`main/index.ts`）的副作用，
 * 与「保存即同步」的调用顺序一起放在那里。这样本模块可以只依赖内存库做单测。
 */
import { existsSync, statSync } from 'node:fs'

import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'
import {
  PERSONA_HARD_RED_LINES,
  parseRedLines,
  readPersona,
  resolveVaultDirWithSource,
  savePersona,
  type VaultDirSource
} from '../memory/persona'
import { memoryStats, type MemoryStats } from '../memory/store'

/** 目录路径上限（Windows 长路径也够用；只是防模型 / 手滑贴进来一整段文本） */
export const MEMORY_DIR_MAX_CHARS = 400
/** 人设名字 / 口吻 / 单条红线的上限（与 prompt 长度纪律一致） */
export const MEMORY_NAME_MAX_CHARS = 20
export const MEMORY_TONE_MAX_CHARS = 120
export const MEMORY_REDLINE_MAX_CHARS = 60
/** 用户追加红线最多几条（与 `parseRedLines` 的截断一致；超出不静默丢，直接报错） */
export const MEMORY_REDLINES_MAX = 8

/** 设置抽屉「个人记忆」一段的完整视图（读一次给界面） */
export interface MemorySettingsView {
  /** settings 里存的目录（空串 = 自动找；用户可能填了个当前不存在的目录，这里仍原样回显） */
  vaultDir: string
  /** 实际同步用的目录（环境变量 / 设置 / 自动探测；null = 没有） */
  resolvedDir: string | null
  /** `resolvedDir` 的来源：env / setting / auto / none（界面要如实说明谁在生效） */
  dirSource: VaultDirSource
  personaName: string
  personaTone: string
  /** 用户追加的红线（不含写死的三条） */
  redLines: string[]
  /** 写死的三条（界面只读展示，任何配置都删不掉） */
  hardRedLines: string[]
  stats: MemoryStats
}

export interface MemorySettingsSaveResult {
  ok: boolean
  error?: string
  view?: MemorySettingsView
  /** 保存后立即同步的结果（保存即同步；目录没配 / 同步失败时为 null） */
  sync?: {
    scanned: number
    unchanged: number
    skipped: number
    added: number
    updated: number
    removed: number
    items: number
  } | null
  /** 本次实际同步的目录（给界面显示） */
  syncedDir?: string | null
  /** 设置已保存、但同步失败的原因（不把异常原文当「保存失败」） */
  syncError?: string
}

/** 界面 → 主进程的改动（字段缺省 = 不改） */
export interface MemorySettingsPatch {
  vaultDir?: string
  personaName?: string
  personaTone?: string
  /** 每行一条（界面是多行文本；存库时用 `|` 拼成 person.ts 的格式） */
  redLines?: string[]
}

export type ParseMemoryPatchResult =
  | { ok: true; patch: MemorySettingsPatch }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

/**
 * 校验并归一一次保存。**不做静默修正**：目录不存在 / 名字太长 / 红线超条数都直接报错，
 * 让界面把原因原样显示出来（设置抽屉的既有纪律）。
 */
export function parseMemoryPatch(raw: unknown): ParseMemoryPatchResult {
  if (!isPlainObject(raw)) return { ok: false, error: '参数不合法' }
  const patch: MemorySettingsPatch = {}

  if (raw.vaultDir !== undefined) {
    if (typeof raw.vaultDir !== 'string') return { ok: false, error: '日记目录必须是文本路径' }
    const dir = raw.vaultDir.trim()
    if (dir.length > MEMORY_DIR_MAX_CHARS) {
      return { ok: false, error: `日记目录太长（最多 ${MEMORY_DIR_MAX_CHARS} 字）` }
    }
    if (dir !== '') {
      if (!existsSync(dir)) return { ok: false, error: `日记目录不存在：${dir}` }
      let isDir = false
      try {
        isDir = statSync(dir).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) return { ok: false, error: `这不是一个目录：${dir}` }
    }
    patch.vaultDir = dir
  }

  if (raw.personaName !== undefined) {
    if (typeof raw.personaName !== 'string') return { ok: false, error: '名字必须是文本' }
    const name = raw.personaName.trim()
    if (name.length > MEMORY_NAME_MAX_CHARS) {
      return { ok: false, error: `名字最多 ${MEMORY_NAME_MAX_CHARS} 字` }
    }
    patch.personaName = name
  }

  if (raw.personaTone !== undefined) {
    if (typeof raw.personaTone !== 'string') return { ok: false, error: '口吻必须是文本' }
    const tone = raw.personaTone.trim()
    if (tone.length > MEMORY_TONE_MAX_CHARS) {
      return { ok: false, error: `口吻最多 ${MEMORY_TONE_MAX_CHARS} 字` }
    }
    patch.personaTone = tone
  }

  if (raw.redLines !== undefined) {
    if (!Array.isArray(raw.redLines) || !raw.redLines.every((line) => typeof line === 'string')) {
      return { ok: false, error: '红线必须是文本行（界面每行一条）' }
    }
    const lines: string[] = []
    for (const line of raw.redLines) {
      const text = line.trim()
      if (text === '') continue
      if (text.length > MEMORY_REDLINE_MAX_CHARS) {
        return { ok: false, error: `每条红线最多 ${MEMORY_REDLINE_MAX_CHARS} 字：${text.slice(0, 20)}…` }
      }
      if (!lines.includes(text)) lines.push(text)
    }
    if (lines.length > MEMORY_REDLINES_MAX) {
      return { ok: false, error: `红线最多 ${MEMORY_REDLINES_MAX} 条（现在是 ${lines.length} 条）` }
    }
    patch.redLines = lines
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: '没有要保存的改动' }
  return { ok: true, patch }
}

/** 写入 settings（目录 + 人设）；调用方负责随后同步与日志 */
export function applyMemoryPatch(db: Db, patch: MemorySettingsPatch): void {
  if (patch.vaultDir !== undefined) setSetting(db, 'memory.vault_dir', patch.vaultDir)
  if (
    patch.personaName !== undefined ||
    patch.personaTone !== undefined ||
    patch.redLines !== undefined
  ) {
    savePersona(db, {
      ...(patch.personaName !== undefined ? { name: patch.personaName } : {}),
      ...(patch.personaTone !== undefined ? { tone: patch.personaTone } : {}),
      ...(patch.redLines !== undefined ? { redLines: patch.redLines.join('|') } : {})
    })
  }
}

/** 组装视图：设置里的原值 + 实际生效目录 + 人设 + 统计（全部现读，不缓存） */
export function buildMemorySettingsView(db: Db): MemorySettingsView {
  const resolution = resolveVaultDirWithSource(db)
  const persona = readPersona(db)
  return {
    vaultDir: getSetting(db, 'memory.vault_dir').trim(),
    resolvedDir: resolution.dir,
    dirSource: resolution.source,
    personaName: persona.name,
    personaTone: persona.tone,
    redLines: parseRedLines(getSetting(db, 'memory.persona_redlines')),
    hardRedLines: [...PERSONA_HARD_RED_LINES],
    stats: memoryStats(db)
  }
}
