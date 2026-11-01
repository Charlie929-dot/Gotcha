/**
 * 设置抽屉「记忆仓」一段的主进程侧（D90）
 *
 * 只做三件事：
 * - 读：远端 / 分支 / 未推送条数 / 是否有未提交改动 / 上次推送结果 + 定时间隔；
 * - 校验：界面来的 patch（地址用 `validateRemoteUrl`，间隔用 `parseScheduleMinutes`）；
 * - 写：绑定 origin（写进仓的配置，不另存设置）+ 两个间隔进 settings 表。
 *
 * **git 才是远端的事实源**：设置表里不存地址，免得「界面显示 A、git 里是 B」。
 */
import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'
import {
  MEMORY_SCHEDULE_DEFAULTS,
  parseScheduleMinutes,
  type MemoryScheduleConfig
} from './memory-schedule'
import {
  validateRemoteUrl,
  type MemoryPushState,
  type MemoryRemoteResult
} from './memory-repo'

/** 定时 commit 的间隔（分钟；0 = 关） */
export const MEMORY_COMMIT_MINUTES_KEY = 'memory.commit_minutes'
/** 定时 push 的间隔（分钟；0 = 关） */
export const MEMORY_PUSH_MINUTES_KEY = 'memory.push_minutes'

/** 设置抽屉「记忆仓」一段的完整视图 */
export interface MemoryRepoSettingsView {
  /** 仓能不能用（没有 git / 仓坏了 = false，界面据此禁用按钮） */
  available: boolean
  /** 实际 origin（没配 = null） */
  remote: string | null
  branch: string
  dirty: boolean
  ahead: number | null
  lastPush: { ok: boolean; reason: string | null; at: number } | null
  commitMinutes: number
  pushMinutes: number
}

export interface MemoryRepoPatch {
  remote?: string
  commitMinutes?: number
  pushMinutes?: number
}

export type MemoryRepoPatchResult =
  | { ok: true; value: MemoryRepoPatch }
  | { ok: false; message: string }

/** 从设置表读定时配置（缺省 = 默认值；坏值按默认，不阻塞界面） */
export function readMemorySchedule(db: Db): MemoryScheduleConfig {
  return {
    commitMinutes: parseScheduleMinutes(
      getSetting(db, MEMORY_COMMIT_MINUTES_KEY),
      MEMORY_SCHEDULE_DEFAULTS.commitMinutes
    ),
    pushMinutes: parseScheduleMinutes(
      getSetting(db, MEMORY_PUSH_MINUTES_KEY),
      MEMORY_SCHEDULE_DEFAULTS.pushMinutes
    )
  }
}

/** 把界面来的 patch 钳成合法值；地址不合法直接报错，不静默丢 */
export function parseMemoryRepoPatch(raw: unknown): MemoryRepoPatchResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: '参数不合法' }
  const input = raw as Record<string, unknown>
  const value: MemoryRepoPatch = {}
  if (input.remote !== undefined) {
    if (typeof input.remote !== 'string') return { ok: false, message: '仓库地址必须是文本' }
    const checked = validateRemoteUrl(input.remote)
    if (!checked.ok) {
      return {
        ok: false,
        message:
          checked.reason === 'empty'
            ? '仓库地址不能为空（要解绑请直接用 git 命令删 origin）'
            : '只认 https:// 或 ssh 地址，且不要带账号密码'
      }
    }
    value.remote = checked.url
  }
  if (input.commitMinutes !== undefined) {
    if (typeof input.commitMinutes !== 'number' || !Number.isFinite(input.commitMinutes)) {
      return { ok: false, message: '定时 commit 必须是分钟数' }
    }
    value.commitMinutes = parseScheduleMinutes(
      input.commitMinutes,
      MEMORY_SCHEDULE_DEFAULTS.commitMinutes
    )
  }
  if (input.pushMinutes !== undefined) {
    if (typeof input.pushMinutes !== 'number' || !Number.isFinite(input.pushMinutes)) {
      return { ok: false, message: '定时 push 必须是分钟数' }
    }
    value.pushMinutes = parseScheduleMinutes(
      input.pushMinutes,
      MEMORY_SCHEDULE_DEFAULTS.pushMinutes
    )
  }
  return { ok: true, value }
}

export interface MemoryRepoViewDeps {
  db: Db
  pushState: () => Promise<MemoryPushState>
}

/** 组装界面视图（仓不可用时仍回显配置，只是 available=false） */
export async function buildMemoryRepoSettingsView(
  deps: MemoryRepoViewDeps
): Promise<MemoryRepoSettingsView> {
  const schedule = readMemorySchedule(deps.db)
  let state: MemoryPushState
  try {
    state = await deps.pushState()
  } catch {
    state = { ok: false, reason: 'unavailable' }
  }
  if (!state.ok) {
    return {
      available: false,
      remote: null,
      branch: '',
      dirty: false,
      ahead: null,
      lastPush: null,
      commitMinutes: schedule.commitMinutes,
      pushMinutes: schedule.pushMinutes
    }
  }
  return {
    available: true,
    remote: state.remote,
    branch: state.branch,
    dirty: state.dirty,
    ahead: state.ahead,
    lastPush: state.lastPush,
    commitMinutes: schedule.commitMinutes,
    pushMinutes: schedule.pushMinutes
  }
}

export interface MemoryRepoApplyDeps {
  db: Db
  setRemote: (url: string) => Promise<MemoryRemoteResult>
}

/**
 * 落盘：先绑定远端（失败就不动间隔，省得「地址没绑上但定时器已经在推」），
 * 再把两个间隔写进设置表。返回错误文案给界面。
 */
export async function applyMemoryRepoPatch(
  deps: MemoryRepoApplyDeps,
  raw: unknown
): Promise<{ ok: boolean; message?: string }> {
  const parsed = parseMemoryRepoPatch(raw)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const patch = parsed.value
  if (patch.remote !== undefined) {
    const bound = await deps.setRemote(patch.remote)
    if (!bound.ok) {
      return {
        ok: false,
        message:
          bound.reason === 'failed'
            ? `绑定失败：${bound.detail ?? 'git 报错'}`
            : '绑定失败：记忆仓不可用'
      }
    }
  }
  if (patch.commitMinutes !== undefined) {
    setSetting(deps.db, MEMORY_COMMIT_MINUTES_KEY, String(patch.commitMinutes))
  }
  if (patch.pushMinutes !== undefined) {
    setSetting(deps.db, MEMORY_PUSH_MINUTES_KEY, String(patch.pushMinutes))
  }
  return { ok: true }
}
