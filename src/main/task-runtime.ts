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
  parseRepeat,
  readableTaskTime,
  releaseStaleClaims,
  settleTask,
  type RepeatKind,
  type TaskOutcome,
  type TaskRow
} from '../memory/agent/tasks'
import { createTaskToolPort, type TaskToolPort } from '../memory/agent/task-tools'
import { createTaskScheduler, type TaskScheduler } from '../memory/agent/scheduler'
import { ensureGrowthDailyTask, ensureNextGrowthWriting } from '../memory/agent/growth-tasks'

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
  /** 原始到点时间（编辑表单用）；null = 只记着、不到点叫醒 */
  nextDueAt: number | null
  /** 重复种类与明细（编辑表单用；人话在 `repeat`） */
  repeatKind: RepeatKind
  weekdays: number[]
  monthDays: number[]
  yearlyMonth: number | null
  yearlyDay: number | null
  /** 原始有效期；null = 一直有效 */
  validUntil: number | null
}

/**
 * 设置抽屉里新建 / 编辑一条任务（不是模型工具）：
 * 新建时分给 `origin='user'`（共建计划，走 Obsidian 同步）；编辑保留原来的来源。
 */
export interface TaskAdminSaveInput {
  id?: number
  instruction: string
  when: number | null
  repeat: RepeatKind
  weekdays?: number[]
  monthDays?: number[]
  yearlyMonth?: number | null
  yearlyDay?: number | null
  delivery: 'foreground' | 'background' | 'auto'
  validUntil: number | null
}

/** 设置抽屉「任务」块的视图；不可用 = 任务库还没起来（没采集过 / 没迁到 v11） */
export interface TaskAdminView {
  available: boolean
  /** 活着（active / paused）的总数，可能比 tasks 多（列表截到 50 条） */
  total: number
  tasks: TaskAdminItem[]
  /** 此刻正在跑的那条（单飞：一次只做一件事）；没在跑 = null */
  running: { id: number; instruction: string } | null
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
  /** 立刻打一轮（启动恢复 / 手动触发 / 测试）；单飞，重入直接返回 */
  pump: () => Promise<void>
  /** 库里还有几条活着的任务（设置 / 状态行用） */
  count: () => number
  /** 设置抽屉：活着的任务（active / paused），暂停 / 继续 / 取消都走 port.setState / port.cancel */
  admin: () => TaskAdminView
  /**
   * 播种「每天写日记」的自主任务（自调用 v0.2 §8，幂等）。
   * 任务库不可用 = null；返回任务 id（用户取消过也不会复活）。
   */
  seedGrowthTask: () => number | null
  /**
   * 一层成长档案写完 → 串下一篇（周日周记 / 月末总结 / 年终总结，一次只做一件）。
   * 返回新任务 id；这次不用排 = null。
   */
  scheduleNextGrowthWriting: (progress: {
    weekly: boolean
    monthly: boolean
    yearly: boolean
  }) => number | null
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
  /** 此刻正在跑的那条（单飞；设置抽屉显示「正在做」） */
  let runningTask: TaskRow | null = null
  /**
   * 失败退避（2026-11-02）：任务 id → 什么时候才允许再试。
   * **只在内存里**：不写库，所以重复任务的 `next_due_at` 锚点不会被一次失败推走
   * （真机事故：26 次失败把「每天 17:40」推成 22:00）。重启丢表最多多试一次。
   */
  const retryUntil = new Map<number, number>()

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
      if (next === null || next.next_due_at === null) return null
      const due = next.next_due_at
      const hold = retryUntil.get(next.id)
      if (hold === undefined || hold <= due) return due
      // 队首这条还在退避里：它后面可能有更早到点的（退避结束之前就该叫醒）
      const others = listDueTasks(current, hold, 50).filter(
        (row) => row.id !== next.id && row.next_due_at !== null
      )
      return others.length > 0 ? (others[0].next_due_at as number) : hold
    },
    dueTasks: (at) => {
      const current = handle()
      if (current === null) return []
      // 退避期内的先不给：它们到点了，但要等退避结束再试
      return listDueTasks(current, at).filter((row) => (retryUntil.get(row.id) ?? 0) <= at)
    },
    claim: (id, at) => {
      const current = handle()
      return current === null ? null : claimTask(current, id, at)
    },
    run: async (task) => {
      runningTask = task
      try {
        return await deps.deliver(task)
      } finally {
        runningTask = null
      }
    },
    settle: (id, outcome, at) => {
      const current = handle()
      if (current === null) return
      // 退避时间只进内存：库里的 next_due_at 保持原样（周期任务的锚点不能被重试推走）
      if (outcome.retryIn !== undefined) {
        retryUntil.set(id, at + Math.max(0, outcome.retryIn))
      } else {
        retryUntil.delete(id)
      }
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
      // 上个进程跑一半被打断的那条：租约还在库里，先释放，不然它永远抢不到、
      // 还堵在到点队首让调度器空转（2026-11-02 事故）。
      const current = handle()
      if (current !== null) {
        try {
          const released = releaseStaleClaims(current, now())
          if (released > 0) deps.log('warn', 'task stale claim released', { count: released })
        } catch (error) {
          deps.log('warn', 'task stale claim release failed', { error: String(error) })
        }
      }
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
    pump: () => scheduler.pump(),
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
      if (current === null) return { available: false, total: 0, tasks: [], running: null }
      const at = now()
      const rows = listLiveTasks(current, 50)
      return {
        available: true,
        total: countLiveTasks(current),
        tasks: rows.map((task) => {
          const rule = parseRepeat(task.repeat)
          return {
            id: task.id,
            when: readableTaskTime(task.next_due_at, at),
            repeat: describeRepeat(task.repeat, task.next_due_at),
            origin: task.origin,
            delivery: task.delivery,
            state: task.state === 'paused' ? 'paused' : 'active',
            instruction: task.instruction,
            sync: task.obsidian_state,
            nextDueAt: task.next_due_at,
            repeatKind: rule.kind,
            weekdays: rule.weekdays,
            monthDays: rule.monthDays,
            yearlyMonth: rule.yearlyMonth,
            yearlyDay: rule.yearlyDay,
            validUntil: task.valid_until
          }
        }),
        running:
          runningTask === null
            ? null
            : { id: runningTask.id, instruction: runningTask.instruction }
      }
    },
    seedGrowthTask: () => {
      const current = handle()
      if (current === null) return null
      try {
        return ensureGrowthDailyTask(current, now()).task.id
      } catch (error) {
        deps.log('warn', 'growth task seed failed', { error: String(error) })
        return null
      }
    },
    scheduleNextGrowthWriting: (progress) => {
      const current = handle()
      if (current === null) return null
      try {
        return ensureNextGrowthWriting(current, now(), progress)?.task.id ?? null
      } catch (error) {
        deps.log('warn', 'growth writing schedule failed', { error: String(error) })
        return null
      }
    }
  }
}
