/**
 * 任务记忆 · 四个工具的执行体（自调用方案 v0.2 §4、§6）
 *
 * 这一层把「意图」变成**可执行、可回执、可查看**的东西：
 *
 * - `schedule`：写 `mem_tasks`；共建计划（`origin='user'`）再**由代码**追加到用户
 *   Obsidian 当天笔记的 `# Tracking` 计划区，并把真实同步状态写回任务行；
 * - `search`：四种视图（pending / day / upcoming / about），带 `total` 与 `truncated`；
 * - `update` / `cancel`：改任务行，并把共建计划在 Obsidian 的那一行原地改 / 删。
 *
 * 三条硬规矩：
 *
 * 1. **回执只认记录**：文案由落库后的行 + 同步结果拼出来，不是模型自己说的；
 * 2. **失败不粉饰**：Obsidian 同步失败时明确说「计划记下了，但没同步上」，
 *    不会出现「已完整同步」这种话；
 * 3. **模型碰不到用户日记**：唯一写的地方是 `# Tracking` 计划区，且只追加 / 改 / 删
 *    同步器自己写的那几行（`memory/write.ts` 的 `appendPlan` / `updatePlanLine` / `removePlanLine`）。
 */

import type { Db } from '../../db'
import {
  cancelTask,
  createTask,
  dayKeyOf,
  describeRepeat,
  getTaskById,
  readableTaskTime,
  searchTasks,
  updateTask,
  type TaskRow
} from './tasks'
import {
  DiaryWriteError,
  appendPlan,
  removePlanLine,
  updatePlanLine
} from '../write'

/** 工具结果里的任务视图（与 `chain/agent/payload.ts` 的 `RedactableTaskView` 同形） */
export interface TaskToolView {
  id: number
  when: string
  repeat: string
  origin: string
  delivery: string
  state: string
  instruction: string
  sync?: string
}

export interface TaskToolMutation {
  ok: boolean
  message: string
  task: TaskToolView | null
}

export interface TaskToolSearch {
  tasks: readonly TaskToolView[]
  total: number
  truncated: boolean
}

export interface TaskToolDepsOptions {
  /** 每次现取（主进程会关只读连接开写连接，缓存句柄会失效） */
  db: () => Db | null
  now?: () => number
  /** 用户 Obsidian 日记目录；没有 = 计划只留在任务表里，如实标「待同步」 */
  vaultDir?: () => string | null
  /** 写入前备份目录（`userData/diary-backups`）；不传就不备份（只给测试） */
  backupDir?: () => string | null
  /** 任务行变化后回调（主进程用它重算调度器） */
  onChanged?: () => void
  /** 计划同步失败时记日志（可选） */
  log?: (level: 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

export interface TaskToolPort {
  schedule(input: {
    instruction: string
    when: number | null
    repeat: '' | 'daily' | 'weekly'
    origin: 'user' | 'agent' | 'system'
    delivery: 'foreground' | 'background' | 'auto'
    validUntil: number | null
  }): TaskToolMutation
  search(input: {
    view: 'pending' | 'day' | 'upcoming' | 'about'
    day?: string
    query?: string
    limit?: number
  }): TaskToolSearch
  update(input: {
    id: number
    instruction?: string
    when?: number | null
    repeat?: '' | 'daily' | 'weekly'
    delivery?: 'foreground' | 'background' | 'auto'
    validUntil?: number | null
    state?: 'active' | 'paused' | 'completed' | 'cancelled'
  }): TaskToolMutation
  cancel(id: number): TaskToolMutation
}

/** 共建计划同步状态 */
type PlanSync = { state: 'synced' | 'pending' | 'failed' | 'removed'; path: string | null; note: string | null }

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 到点时间的 `HH:mm`（写进 Obsidian 计划行的时间戳） */
export function taskClock(task: TaskRow): string | null {
  if (task.next_due_at === null) return null
  const date = new Date(task.next_due_at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function viewOf(task: TaskRow, now: number): TaskToolView {
  return {
    id: task.id,
    when: readableTaskTime(task.next_due_at, now),
    repeat: describeRepeat(task.repeat),
    origin: task.origin,
    delivery: task.delivery,
    state: task.state,
    instruction: task.instruction,
    ...(task.obsidian_state === '' ? {} : { sync: task.obsidian_state })
  }
}

function syncLabel(sync: PlanSync): string {
  if (sync.state === 'synced') {
    return sync.path === null ? '已写进 Obsidian 的计划区' : `已写进 Obsidian 计划区（${sync.path}）`
  }
  if (sync.state === 'removed') return 'Obsidian 计划区里那一行也删掉了'
  if (sync.state === 'pending') return `Obsidian 待同步${sync.note === null ? '' : `（${sync.note}）`}`
  return `Obsidian 没同步上${sync.note === null ? '' : `（${sync.note}）`}`
}

function failureMessage(error: unknown): string {
  if (error instanceof DiaryWriteError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把一条共建计划追加到 Obsidian 计划区。
 * 没有具体到点时间 / 没配置日记目录 → `pending`（不假装同步成功）。
 */
function syncPlanCreate(task: TaskRow, options: TaskToolDepsOptions): PlanSync {
  const vaultDir = options.vaultDir?.() ?? null
  if (task.origin !== 'user') return { state: 'pending', path: null, note: null }
  if (vaultDir === null || vaultDir.trim() === '') {
    return { state: 'pending', path: null, note: '没配日记目录' }
  }
  if (task.next_due_at === null) return { state: 'pending', path: null, note: '没有具体时间' }
  const clock = taskClock(task)
  if (clock === null) return { state: 'pending', path: null, note: '没有具体时间' }
  const dayKey = dayKeyOf(task.next_due_at)
  try {
    appendPlan({
      dayKey,
      vaultDir,
      ...(options.backupDir?.() ? { backupDir: options.backupDir()! } : {}),
      text: task.instruction,
      time: clock
    })
    return { state: 'synced', path: dayKey, note: null }
  } catch (error) {
    const note = failureMessage(error)
    options.log?.('warn', 'task plan sync failed', { id: task.id, note })
    return { state: 'failed', path: dayKey, note }
  }
}

/** 改 / 删共建计划在 Obsidian 的那一行；找不到（用户自己删了）也算成功 */
function syncPlanEdit(
  before: TaskRow,
  kind: 'update' | 'remove',
  after: TaskRow | null,
  options: TaskToolDepsOptions
): PlanSync {
  const vaultDir = options.vaultDir?.() ?? null
  if (before.origin !== 'user') return { state: 'pending', path: null, note: null }
  if (before.obsidian_state !== 'synced' || before.next_due_at === null) {
    // 之前就没同步上：update 就再试一次「新建」，不要假装改成功了
    return after === null
      ? { state: 'pending', path: null, note: '之前就没同步上，没有可删的行' }
      : syncPlanCreate(after, options)
  }
  if (vaultDir === null || vaultDir.trim() === '') {
    return { state: 'pending', path: null, note: '没配日记目录' }
  }
  const oldDay = before.obsidian_path ?? dayKeyOf(before.next_due_at)
  const oldClock = taskClock(before)
  const needle = oldClock === null ? before.instruction : `${oldClock} ${before.instruction}`
  const backupDir = options.backupDir?.() ?? null
  const context = { dayKey: oldDay, vaultDir, ...(backupDir ? { backupDir } : {}) }

  // 同一天改时间 / 改事项：原地改那一行（勾选状态与位置都保留）
  if (kind === 'update' && after !== null && after.next_due_at !== null) {
    const newDay = dayKeyOf(after.next_due_at)
    const newClock = taskClock(after)
    if (newDay === oldDay && newClock !== null) {
      try {
        updatePlanLine({ ...context, match: needle, text: after.instruction, time: newClock })
        return { state: 'synced', path: oldDay, note: null }
      } catch (error) {
        if (!(error instanceof DiaryWriteError && error.code === 'line-not-found')) {
          const note = failureMessage(error)
          options.log?.('warn', 'task plan update failed', { id: before.id, note })
          return { state: 'failed', path: oldDay, note }
        }
        // 那一行被用户删了：落到下面走「追加新行」
      }
    }
  }

  try {
    removePlanLine({ ...context, match: needle })
  } catch (error) {
    if (error instanceof DiaryWriteError && error.code === 'line-not-found') {
      // 用户手动删过那一行：目的已经达到
    } else if (kind === 'remove') {
      const note = failureMessage(error)
      options.log?.('warn', 'task plan remove failed', { id: before.id, note })
      return { state: 'failed', path: oldDay, note }
    }
  }
  if (kind === 'remove' || after === null) return { state: 'removed', path: oldDay, note: null }
  return syncPlanCreate(after, options)
}

/** 落库后把同步状态写回任务行（回执与列表都看这一份） */
function applySync(db: Db, task: TaskRow, sync: PlanSync, now: number): TaskRow {
  if (task.origin !== 'user') return task
  const updated = updateTask(db, {
    id: task.id,
    obsidianState: sync.state,
    obsidianPath: sync.path,
    obsidianNote: sync.note,
    now
  })
  return updated ?? task
}

function requireDb(options: TaskToolDepsOptions): Db {
  const db = options.db()
  if (db === null) throw new Error('任务库不可用')
  return db
}

/**
 * 建一个任务工具端口。不依赖 Electron：库、钟、日记目录都由调用方注入，
 * 单测里可以用 `openDatabase(':memory:')` + 临时目录跑完整的「记下 → 同步 → 取消」。
 */
export function createTaskToolPort(options: TaskToolDepsOptions): TaskToolPort {
  return {
    schedule(input) {
      const now = options.now?.() ?? Date.now()
      const db = requireDb(options)
      const task = createTask(db, {
        instruction: input.instruction,
        nextDueAt: input.when,
        repeat: input.repeat,
        origin: input.origin,
        delivery: input.delivery,
        validUntil: input.validUntil,
        now
      })
      const sync = input.origin === 'user' ? syncPlanCreate(task, options) : null
      const stored = sync === null ? task : applySync(db, task, sync, now)
      options.onChanged?.()
      const when = readableTaskTime(stored.next_due_at, now)
      const repeat = describeRepeat(stored.repeat)
      const tail = sync === null ? '' : ` · ${syncLabel(sync)}`
      const headline =
        input.origin === 'user'
          ? `记下了共建计划 #${stored.id}：${when}${repeat === '' ? '' : `（${repeat}）`} ${stored.instruction}`
          : `记下了 #${stored.id}：${when}${repeat === '' ? '' : `（${repeat}）`} ${stored.instruction}`
      return {
        ok: true,
        message: `${headline}${tail}`,
        task: viewOf(stored, now)
      }
    },
    search(input) {
      const now = options.now?.() ?? Date.now()
      const db = requireDb(options)
      const result = searchTasks(db, {
        view: input.view,
        now,
        ...(input.day === undefined ? {} : { day: input.day }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      })
      return {
        tasks: result.tasks.map((task) => ({
          ...viewOf(task, now),
          ...(task.occurrence_at === undefined
            ? {}
            : { when: readableTaskTime(task.occurrence_at, now) })
        })),
        total: result.total,
        truncated: result.truncated
      }
    },
    update(input) {
      const now = options.now?.() ?? Date.now()
      const db = requireDb(options)
      const before = getTaskById(db, input.id)
      if (before === null) {
        return { ok: false, message: `没有 #${input.id} 这条任务（search_tasks 看看有哪些）`, task: null }
      }
      const after = updateTask(db, {
        id: input.id,
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        ...(input.when === undefined ? {} : { nextDueAt: input.when }),
        ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
        ...(input.state === undefined ? {} : { state: input.state }),
        now
      })
      if (after === null) {
        return { ok: false, message: `没改成 #${input.id}`, task: null }
      }
      const sync = before.origin === 'user' ? syncPlanEdit(before, 'update', after, options) : null
      const stored = sync === null ? after : applySync(db, after, sync, now)
      options.onChanged?.()
      const tail = sync === null ? '' : ` · ${syncLabel(sync)}`
      return {
        ok: true,
        message: `改好了 #${stored.id}：${readableTaskTime(stored.next_due_at, now)} ${stored.instruction}${tail}`,
        task: viewOf(stored, now)
      }
    },
    cancel(id) {
      const now = options.now?.() ?? Date.now()
      const db = requireDb(options)
      const before = getTaskById(db, id)
      if (before === null) {
        return { ok: false, message: `没有 #${id} 这条任务（search_tasks 看看有哪些）`, task: null }
      }
      const cancelled = cancelTask(db, id, now)
      if (cancelled === null) {
        return { ok: false, message: `没取消成 #${id}`, task: null }
      }
      const sync = before.origin === 'user' ? syncPlanEdit(before, 'remove', null, options) : null
      const stored = sync === null ? cancelled : applySync(db, cancelled, sync, now)
      options.onChanged?.()
      const tail = sync === null ? '' : ` · ${syncLabel(sync)}`
      return {
        ok: true,
        message: `取消了 #${stored.id}：${stored.instruction}${tail}`,
        task: viewOf(stored, now)
      }
    }
  }
}
