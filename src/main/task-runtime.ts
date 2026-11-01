/**
 * 任务运行时（主进程）：库连接 + 工具端口 + 调度器（自调用 v0.2 §9）
 *
 * 为什么要一条**独立连接**：主进程的只读连接是共享的，`ensureWritable()` 会把它关掉再开写
 * （capture-controller 的既有纪律）。任务工具是在问答循环里被调用的，那时只读连接正被
 * 那次问答用着——从它身上开写会把正在读的句柄关掉。所以任务库自己开一条写连接
 * （SQLite WAL 允许多连接），问答中途记任务也不会打断正在读的那条。
 *
 * 这一层只负责「接起来」：
 * - `port`：四个任务工具的执行体（含 Obsidian 计划区同步）；
 * - `dueHints`：本轮 `<now>` 里要列出的到点任务（合流）；
 * - `scheduler`：睡到最近一条 `next_due_at`，到点交给 `deliver`。
 */

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'

import type { Db } from '../db'
import {
  claimTask,
  countLiveTasks,
  describeRepeat,
  expireTasks,
  listDueTasks,
  listLiveTasks,
  nextDueTask,
  readableTaskTime,
  settleTask,
  type TaskOutcome,
  type TaskRow
} from '../memory/agent/tasks'
import { createTaskToolPort, type TaskToolPort } from '../memory/agent/task-tools'
import { createTaskScheduler, type TaskScheduler } from '../memory/agent/scheduler'

export interface TaskRuntimeDeps {
  /** 库文件路径（`userData/memory.db`）；文件不存在 = 还没采集过，运行时不建库 */
  dbPath: string
  now?: () => number
  /** 用户 Obsidian 日记目录（共建计划往 `# Tracking` 写）；null = 没配 */
  vaultDir: () => string | null
  /** 写入前备份目录；null = 不备份 */
  backupDir: () => string | null
  /** 缺当天笔记时要不要自动建（读设置 `memory.auto_daily_note`）；不传 = 建 */
  autoCreateNote?: () => boolean
  /**
   * 到点执行：跑一轮、真的开口（由组合根注入问记忆通道）。
   * 返回 `TaskOutcome` 决定这一条怎么结算（默认定时规则）。
   */
  deliver: (task: TaskRow) => Promise<TaskOutcome | undefined> | TaskOutcome | undefined
  log: (level: 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
  /** 一秒级的定时器（测试注入）；默认 setTimeout */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** 设置抽屉「任务」块里的一条（已算好人话时间 / 来源 / 同步状态） */
export interface TaskAdminItem {
  id: number
  when: string
  repeat: string
  origin: 'user' | 'agent' | 'system'
  delivery: 'foreground' | 'background' | 'auto'
  state: 'active' | 'paused'
  instruction: string
  /** 共建计划的 Obsidian 同步状态；空 = 不需要同步 */
  sync: string
}

/** 设置抽屉「任务」块的视图；不可用 = 任务库还没起来（没采集过 / 没迁到 v11） */
export interface TaskAdminView {
  available: boolean
  /** 活着（active / paused）的总数，可能比 tasks 多（列表截到 50 条） */
  total: number
  tasks: TaskAdminItem[]
}

export interface TaskRuntime {
  /** 四个任务工具的执行端口（注入问记忆循环） */
  port: TaskToolPort
  /** 本轮 `<now>` 里要列出的到点 / 临近任务 */
  dueHints: () => readonly {
    id: number
    when: string
    instruction: string
    origin: string
  }[]
  start: () => void
  stop: () => void
  reschedule: () => void
  busy: () => boolean
  /** 库里还有几条活着的任务（设置 / 状态行用） */
  count: () => number
  /** 设置抽屉：活着的任务（active / paused），暂停 / 继续 / 取消都走 port.setState / port.cancel */
  admin: () => TaskAdminView
}

/** 合流窗口：到点前多久就把它列进 `<now>`（与既有 10 分钟窗口同口径） */
export const TASK_MERGE_WINDOW_MS = 10 * 60 * 1000

/**
 * 打开任务库的独立写连接。两条红线（沿用采集的 A3 与迁移口径）：
 *
 * 1. **文件不存在就不建库**：`new Database()` 会凭空造一个空文件，等于「为了看一眼就建库」；
 * 2. **表不存在（还没迁到 v11）就当没有**：`mem_tasks` 缺失时查询会抛 `no such table`，
 *    调度器启动就会把主进程带崩——宁可这条链路不可用，也不让启动失败。
 */
export function openTaskDb(
  dbPath: string,
  exists: (path: string) => boolean = existsSync
): Db | null {
  if (!exists(dbPath)) return null
  try {
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mem_tasks'`)
      .get() as { name: string } | undefined
    if (table === undefined) {
      db.close()
      return null
    }
    return db
  } catch {
    return null
  }
}

export function createTaskRuntime(deps: TaskRuntimeDeps): TaskRuntime {
  const now = deps.now ?? ((): number => Date.now())
  let db: Db | null = null
  let closed = false
  /** 打不开的冷却：不让每次提问都去 existsSync + 开一次库（30 秒后再试） */
  let unavailableUntil = 0

  const handle = (): Db | null => {
    if (closed) return null
    if (db === null) {
      if (now() < unavailableUntil) return null
      db = openTaskDb(deps.dbPath)
      if (db === null) unavailableUntil = now() + 30_000
    }
    return db
  }

  const port = createTaskToolPort({
    db: handle,
    now,
    vaultDir: deps.vaultDir,
    backupDir: deps.backupDir,
    ...(deps.autoCreateNote ? { autoCreateNote: deps.autoCreateNote } : {}),
    onChanged: () => scheduler.reschedule(),
    log: deps.log
  })

  const scheduler: TaskScheduler = createTaskScheduler({
    now,
    nextDueAt: () => {
      const current = handle()
      if (current === null) return null
      const next = nextDueTask(current)
      return next?.next_due_at ?? null
    },
    dueTasks: (at) => {
      const current = handle()
      return current === null ? [] : listDueTasks(current, at)
    },
    claim: (id, at) => {
      const current = handle()
      return current === null ? null : claimTask(current, id, at)
    },
    run: (task) => deps.deliver(task),
    settle: (id, outcome, at) => {
      const current = handle()
      if (current === null) return
      settleTask(current, id, outcome, at)
    },
    expire: (at) => {
      const current = handle()
      if (current !== null) expireTasks(current, at)
    },
    onError: (error) => deps.log('error', 'task run failed', { error: String(error) }),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {})
  })

  return {
    port,
    dueHints: () => {
      const current = handle()
      if (current === null) return []
      const at = now()
      return listDueTasks(current, at + TASK_MERGE_WINDOW_MS, 5).map((task) => ({
        id: task.id,
        when: readableTaskTime(task.next_due_at, at),
        instruction: task.instruction,
        origin: task.origin
      }))
    },
    start: () => {
      scheduler.start()
      // 上次没同步上的共建计划再试一遍（比如那天还没有笔记：现在能自动建了）
      try {
        const result = port.resyncPlans()
        if (result.attempted > 0) {
          deps.log('warn', 'task plan resync', result)
        }
      } catch (error) {
        deps.log('warn', 'task plan resync failed', { error: String(error) })
      }
    },
    stop: () => {
      scheduler.stop()
      closed = true
      if (db !== null) {
        try {
          db.close()
        } catch {
          // 关不掉就算了：进程要退出了
        }
        db = null
      }
    },
    reschedule: () => scheduler.reschedule(),
    busy: () => scheduler.busy(),
    count: () => {
      const current = handle()
      if (current === null) return 0
      const row = current
        .prepare(`SELECT COUNT(*) AS n FROM mem_tasks WHERE state = 'active'`)
        .get() as { n: number }
      return row.n
    },
    admin: () => {
      const current = handle()
      if (current === null) return { available: false, total: 0, tasks: [] }
      const at = now()
      const rows = listLiveTasks(current, 50)
      return {
        available: true,
        total: countLiveTasks(current),
        tasks: rows.map((task) => ({
          id: task.id,
          when: readableTaskTime(task.next_due_at, at),
          repeat: describeRepeat(task.repeat),
          origin: task.origin,
          delivery: task.delivery,
          state: task.state === 'paused' ? 'paused' : 'active',
          instruction: task.instruction,
          sync: task.obsidian_state
        }))
      }
    }
  }
}
