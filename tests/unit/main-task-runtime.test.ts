/**
 * 任务运行时（主进程）：不建库 / 表缺就不可用 / 到点交给 deliver / 合流提示
 *
 * 守三条：
 * 1. 库文件不存在时**不建库**（A3：不为没开的功能够建库）；
 * 2. 还没迁到 v11（没有 `mem_tasks`）时这条链路不可用，但进程不崩；
 * 3. 到点执行交给注入的 `deliver`，结算回库里（重复任务推下一次、一次性完成）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../../src/db'
import { createTask, listDueTasks, settleTask, updateTask } from '../../src/memory/agent/tasks'
import { createTaskRuntime, openTaskDb, TASK_MERGE_WINDOW_MS } from '../../src/main/task-runtime'

let root = ''
let dbPath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotcha-task-runtime-'))
  dbPath = join(root, 'memory.db')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 本地时间 → 毫秒 */
function at(day: string, hhmm = '09:00'): number {
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = hhmm.split(':').map(Number)
  return new Date(year, month - 1, date, hour, minute, 0, 0).getTime()
}

describe('openTaskDb', () => {
  it('文件不存在：不建库，返回 null', () => {
    expect(openTaskDb(dbPath)).toBeNull()
    expect(openTaskDb(dbPath)).toBeNull()
  })

  it('库存在但还没迁到 v11（没有 mem_tasks）：返回 null，不抛错', () => {
    const db = openDatabase(dbPath)
    db.exec('DROP TABLE IF EXISTS mem_tasks')
    db.close()
    expect(openTaskDb(dbPath)).toBeNull()
  })

  it('迁到 v11 的库：拿到可用连接', () => {
    openDatabase(dbPath).close()
    const db = openTaskDb(dbPath)
    expect(db).not.toBeNull()
    db?.close()
  })
})

describe('运行时', () => {
  it('没有库时：不崩、dueHints 为空、count 为 0', () => {
    const runtime = createTaskRuntime({
      dbPath,
      now: () => at('2026-11-01', '12:00'),
      vaultDir: () => null,
      backupDir: () => null,
      deliver: () => undefined,
      log: () => {}
    })
    runtime.start()
    expect(runtime.dueHints()).toEqual([])
    expect(runtime.count()).toBe(0)
    runtime.stop()
  })

  it('到点交给 deliver，结算回库里（一次性任务完成后不再出现）', async () => {
    const due = at('2026-11-01', '12:00')
    const seed = openDatabase(dbPath)
    const task = createTask(seed, {
      instruction: '问他吃没吃饭',
      nextDueAt: due,
      origin: 'agent',
      now: due - 60_000
    })
    expect(listDueTasks(seed, due)).toHaveLength(1)
    seed.close()

    const delivered: number[] = []
    const timers: { fn: () => void; ms: number }[] = []
    const runtime = createTaskRuntime({
      dbPath,
      now: () => due,
      vaultDir: () => null,
      backupDir: () => null,
      deliver: (row) => {
        delivered.push(row.id)
        return {} // 按默认结算：一次性任务 → completed
      },
      log: () => {},
      setTimer: (fn, ms) => {
        const handle = { fn, ms }
        timers.push(handle)
        return handle
      },
      clearTimer: () => undefined
    })
    runtime.start()
    // 已经过点：第一次叫醒的延迟是 0
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(0)
    timers[0].fn()
    // pump 是异步的（要 await deliver）：给一个 tick 让它跑完
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(delivered).toEqual([task.id])

    const after = openTaskDb(dbPath)
    expect(after).not.toBeNull()
    expect(listDueTasks(after!, due)).toHaveLength(0)
    const row = after!.prepare('SELECT state, last_run_at FROM mem_tasks WHERE id = ?').get(task.id) as
      | { state: string; last_run_at: number | null }
      | undefined
    expect(row?.state).toBe('completed')
    expect(row?.last_run_at).toBe(due)
    after?.close()
    runtime.stop()
  })

  it('停止后库连接关掉：admin 报不可用', () => {
    openDatabase(dbPath).close()
    const runtime = createTaskRuntime({
      dbPath,
      now: () => at('2026-11-01', '12:00'),
      vaultDir: () => null,
      backupDir: () => null,
      deliver: () => undefined,
      log: () => {},
      setTimer: () => null,
      clearTimer: () => undefined
    })
    expect(runtime.admin().available).toBe(true)
    runtime.stop()
    expect(runtime.admin()).toEqual({ available: false, total: 0, tasks: [], running: null })
  })

  it('admin：列出 active + paused（active 在前），取消 / 完成的不列', () => {
    const nowAt = at('2026-11-01', '12:00')
    const db = openDatabase(dbPath)
    const active = createTask(db, {
      instruction: '写周报',
      nextDueAt: at('2026-11-01', '13:00'),
      origin: 'user',
      now: nowAt
    })
    const paused = createTask(db, {
      instruction: '问他吃没吃饭',
      nextDueAt: at('2026-11-01', '12:30'),
      origin: 'agent',
      now: nowAt
    })
    updateTask(db, { id: paused.id, state: 'paused', now: nowAt })
    const done = createTask(db, {
      instruction: '已经做完的',
      nextDueAt: at('2026-11-01', '12:10'),
      origin: 'agent',
      now: nowAt
    })
    updateTask(db, { id: done.id, state: 'completed', now: nowAt })
    db.close()

    const runtime = createTaskRuntime({
      dbPath,
      now: () => nowAt,
      vaultDir: () => null,
      backupDir: () => null,
      deliver: () => undefined,
      log: () => {},
      setTimer: () => null,
      clearTimer: () => undefined
    })
    const view = runtime.admin()
    expect(view.available).toBe(true)
    expect(view.total).toBe(2)
    expect(view.tasks.map((task) => task.id)).toEqual([active.id, paused.id])
    expect(view.tasks.map((task) => task.state)).toEqual(['active', 'paused'])
    expect(view.tasks[0].when).toContain('13:00')
    expect(view.tasks[0].origin).toBe('user')
    expect(view.tasks[1].instruction).toBe('问他吃没吃饭')
    runtime.stop()
  })

  it('合流窗口：10 分钟内到点的进 dueHints（人话时间 + 来源）', () => {
    const nowAt = at('2026-11-01', '12:00')
    const db = openDatabase(dbPath)
    createTask(db, {
      instruction: '问他吃没吃饭',
      nextDueAt: nowAt + 5 * 60 * 1000,
      origin: 'agent',
      now: nowAt
    })
    db.close()

    const runtime = createTaskRuntime({
      dbPath,
      now: () => nowAt,
      vaultDir: () => null,
      backupDir: () => null,
      deliver: () => undefined,
      log: () => {},
      setTimer: () => null,
      clearTimer: () => undefined
    })
    const hints = runtime.dueHints()
    expect(hints).toHaveLength(1)
    expect(hints[0].instruction).toBe('问他吃没吃饭')
    expect(hints[0].origin).toBe('agent')
    expect(hints[0].when).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/u)
    expect(TASK_MERGE_WINDOW_MS).toBe(10 * 60 * 1000)
    runtime.stop()
  })

  it('stop 之后库连接关掉，不再读', () => {
    openDatabase(dbPath).close()
    const runtime = createTaskRuntime({
      dbPath,
      now: () => at('2026-11-01', '12:00'),
      vaultDir: () => null,
      backupDir: () => null,
      deliver: () => undefined,
      log: () => {},
      setTimer: () => null,
      clearTimer: () => undefined
    })
    runtime.start()
    expect(runtime.count()).toBe(0)
    runtime.stop()
    expect(runtime.dueHints()).toEqual([])
  })

  it('成长档案：播种「每天写日记」（幂等），周日串周记（这周写过就不排）', () => {
    openDatabase(dbPath).close()
    const sunday = at('2026-11-01', '23:35')
    const runtime = createTaskRuntime({
      dbPath,
      now: () => sunday,
      vaultDir: () => null,
      backupDir: () => null,
      deliver: () => undefined,
      log: () => {},
      setTimer: () => null,
      clearTimer: () => undefined
    })
    const first = runtime.seedGrowthTask()
    expect(first).not.toBeNull()
    expect(runtime.seedGrowthTask()).toBe(first)
    const view = runtime.admin()
    const daily = view.tasks.find((task) => task.id === first)
    expect(daily).toMatchObject({ origin: 'agent', delivery: 'background', repeat: '每天' })

    // 周日 + 这周没写：排一条周记；再问一次不重复
    const weekly = runtime.scheduleWeeklyWriting({ weeklyWritten: false })
    expect(weekly).not.toBeNull()
    expect(runtime.scheduleWeeklyWriting({ weeklyWritten: false })).toBeNull()
    expect(runtime.scheduleWeeklyWriting({ weeklyWritten: true })).toBeNull()
    runtime.stop()
  })

  it('正在做：跑任务期间 admin().running 指向那一条，结束后清空', async () => {
    const nowAt = at('2026-11-01', '12:00')
    const db = openDatabase(dbPath)
    const task = createTask(db, {
      instruction: '写周报',
      nextDueAt: nowAt,
      origin: 'agent',
      now: nowAt
    })
    db.close()

    let seen: { id: number; instruction: string } | null = null
    const runtime = createTaskRuntime({
      dbPath,
      now: () => nowAt,
      vaultDir: () => null,
      backupDir: () => null,
      deliver: () => {
        seen = runtime.admin().running
        return {}
      },
      log: () => {},
      setTimer: () => null,
      clearTimer: () => undefined
    })
    runtime.start()
    await runtime.pump()
    expect(seen).toEqual({ id: task.id, instruction: '写周报' })
    expect(runtime.admin().running).toBeNull()
    runtime.stop()
  })
})
