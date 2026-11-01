/**
 * 任务记忆（mem_tasks）：四种视图 / 重复推进 / 执行租约 / 过期不补发
 *
 * 这组用例守的是自调用方案 v0.2 §5 的几条硬约定：
 * - `due` 是派生的，不写进状态机；
 * - 重复任务执行后**仍是 active**，只把下一次推到未来（不补已经过去的若干次）；
 * - `run_key` 保证同一次 occurrence 重启后也不重复；
 * - `valid_until` 过了就收成 completed，不让它永远排在队首空转；
 * - 截断要说出来（`truncated`），不能把局部当全部。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type Db } from '../../src/db'
import {
  advanceOccurrence,
  cancelTask,
  claimTask,
  countActiveTasks,
  createTask,
  dayKeyOf,
  dayWindow,
  describeTask,
  expireTasks,
  getTaskById,
  listDueTasks,
  nextDueTask,
  occurrenceInWindow,
  searchTasks,
  settleTask,
  updateTask
} from '../../src/memory/agent/tasks'

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

/** 本地时间 → 毫秒（用例里不写字面量时间戳，换时区也不飘） */
function at(day: string, hhmm = '09:00'): number {
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = hhmm.split(':').map(Number)
  return new Date(year, month - 1, date, hour, minute, 0, 0).getTime()
}

describe('建表与基本字段', () => {
  it('新建一条：默认 active / delivery=auto / 没有 run_key', () => {
    const task = createTask(db, {
      instruction: '  问他面试结果  ',
      nextDueAt: at('2026-11-02', '09:30'),
      origin: 'agent',
      now: at('2026-11-01', '10:00')
    })
    expect(task.instruction).toBe('问他面试结果')
    expect(task.state).toBe('active')
    expect(task.delivery).toBe('auto')
    expect(task.repeat).toBe('')
    expect(task.run_key).toBeNull()
    expect(task.obsidian_state).toBe('')
    expect(countActiveTasks(db)).toBe(1)
  })

  it('空说明直接拒（不落一条没有内容的任务）', () => {
    expect(() =>
      createTask(db, { instruction: '   ', nextDueAt: null, origin: 'agent' })
    ).toThrow()
  })

  it('来源 / 重复 / 交付传了怪值就落回默认，不写坏枚举', () => {
    const task = createTask(db, {
      instruction: '看看他睡了没',
      nextDueAt: at('2026-11-01', '23:00'),
      origin: 'nonsense' as never,
      repeat: 'hourly' as never,
      delivery: 'loud' as never
    })
    expect(task.origin).toBe('agent')
    expect(task.repeat).toBe('')
    expect(task.delivery).toBe('auto')
  })
})

describe('时间换算', () => {
  it('dayWindow 只认合法的本地日期（2026-02-30 不算）', () => {
    const window = dayWindow('2026-11-01')
    expect(window).not.toBeNull()
    expect(dayKeyOf(window!.from)).toBe('2026-11-01')
    expect(window!.to - window!.from).toBe(24 * 60 * 60 * 1000)
    expect(dayWindow('2026-02-30')).toBeNull()
    expect(dayWindow('2026-11-1')).toBeNull()
  })

  it('重复推进按日历走（跨月不靠 86400000）', () => {
    const oct31 = at('2026-10-31', '09:30')
    const next = advanceOccurrence(oct31, 'daily')
    expect(dayKeyOf(next)).toBe('2026-11-01')
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getMinutes()).toBe(30)
  })
})

describe('四种视图', () => {
  const now = at('2026-11-01', '12:00')

  beforeEach(() => {
    // 一条今天已过点、还没处理
    createTask(db, {
      instruction: '查他有没有在做周报',
      nextDueAt: at('2026-11-01', '09:00'),
      origin: 'agent',
      now
    })
    // 一条每天重复（今早那次已经过去）
    createTask(db, {
      instruction: '提醒他喝水',
      nextDueAt: at('2026-11-01', '08:00'),
      repeat: 'daily',
      origin: 'agent',
      now
    })
    // 一条明天的一次性共建计划
    createTask(db, {
      instruction: '一起去买猫粮',
      nextDueAt: at('2026-11-02', '19:00'),
      origin: 'user',
      now
    })
    // 一条取消的（默认视图里不该出现）
    const cancelled = createTask(db, {
      instruction: '这条不算',
      nextDueAt: at('2026-11-03', '10:00'),
      origin: 'agent',
      now
    })
    cancelTask(db, cancelled.id, now)
  })

  it('pending：只有活动任务，按到点时间升序', () => {
    const result = searchTasks(db, { view: 'pending', now })
    expect(result.tasks.map((task) => task.instruction)).toEqual([
      '提醒他喝水',
      '查他有没有在做周报',
      '一起去买猫粮'
    ])
    expect(result.total).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('day：重复任务按日历算出当天那次，`occurrence_at` 就是今天那个点', () => {
    const result = searchTasks(db, { view: 'day', day: '2026-11-01', now })
    const names = result.tasks.map((task) => task.instruction)
    expect(names).toEqual(['提醒他喝水', '查他有没有在做周报'])
    const water = result.tasks[0]
    expect(dayKeyOf(water.occurrence_at ?? 0)).toBe('2026-11-01')
    expect(new Date(water.occurrence_at ?? 0).getHours()).toBe(8)
  })

  it('day：明天的重复任务也会被算出来（锚点在昨天不影响）', () => {
    const result = searchTasks(db, { view: 'day', day: '2026-11-02', now })
    expect(result.tasks.map((task) => task.instruction)).toContain('提醒他喝水')
  })

  it('day：日期不合法直接报错，不猜', () => {
    expect(() => searchTasks(db, { view: 'day', day: '2026-13-01', now })).toThrow()
    expect(() => searchTasks(db, { view: 'day', now })).toThrow()
  })

  it('upcoming：只给从现在往后的，已过点的那条不在里面', () => {
    const result = searchTasks(db, { view: 'upcoming', now })
    expect(result.tasks.map((task) => task.instruction)).toEqual(['一起去买猫粮'])
  })

  it('about：按事项关键词匹配，取消的不出现', () => {
    const hit = searchTasks(db, { view: 'about', query: '周报', now })
    expect(hit.tasks.map((task) => task.instruction)).toEqual(['查他有没有在做周报'])
    expect(searchTasks(db, { view: 'about', query: '这条不算', now }).total).toBe(0)
    expect(() => searchTasks(db, { view: 'about', now })).toThrow()
  })

  it('about：% 和 _ 当普通字符（不让模型用通配符扫全表）', () => {
    createTask(db, {
      instruction: '100% 完成',
      nextDueAt: at('2026-11-05', '10:00'),
      origin: 'agent',
      now
    })
    const result = searchTasks(db, { view: 'about', query: '%', now })
    expect(result.total).toBe(1)
    expect(result.tasks[0].instruction).toBe('100% 完成')
  })

  it('截断要说出来：total 是全量，truncated 标记出来', () => {
    const result = searchTasks(db, { view: 'pending', now, limit: 2 })
    expect(result.tasks).toHaveLength(2)
    expect(result.total).toBe(3)
    expect(result.truncated).toBe(true)
  })
})

describe('调度：最近到点 / 到点列表 / 租约', () => {
  const now = at('2026-11-01', '12:00')

  it('没有活动任务时 nextDueTask 返回 null（调度器据此不留定时器）', () => {
    expect(nextDueTask(db)).toBeNull()
  })

  it('nextDueTask 取最早的一条', () => {
    createTask(db, { instruction: '晚一点', nextDueAt: at('2026-11-01', '15:00'), origin: 'agent', now })
    createTask(db, { instruction: '早一点', nextDueAt: at('2026-11-01', '13:00'), origin: 'agent', now })
    expect(nextDueTask(db)?.instruction).toBe('早一点')
  })

  it('只记着、不到点叫醒的任务（next_due_at 为空）不进队列', () => {
    createTask(db, { instruction: '只是记着', nextDueAt: null, origin: 'agent', now })
    expect(nextDueTask(db)).toBeNull()
    expect(listDueTasks(db, now)).toHaveLength(0)
    expect(searchTasks(db, { view: 'pending', now }).total).toBe(1)
  })

  it('listDueTasks 跳过过了 valid_until 的（过期不补发）', () => {
    const task = createTask(db, {
      instruction: '强时效的事',
      nextDueAt: at('2026-11-01', '09:00'),
      validUntil: at('2026-11-01', '10:00'),
      origin: 'agent',
      now
    })
    expect(listDueTasks(db, now)).toHaveLength(0)
    expect(expireTasks(db, now)).toBe(1)
    expect(getTaskById(db, task.id)?.state).toBe('completed')
    expect(nextDueTask(db)).toBeNull()
  })

  it('claimTask：同一次 occurrence 只抢到一次（重启也不会重跑）', () => {
    const task = createTask(db, {
      instruction: '到点关心他',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    expect(claimTask(db, task.id, now)?.id).toBe(task.id)
    expect(claimTask(db, task.id, now)).toBeNull()
    expect(claimTask(db, task.id, now + 60_000)).toBeNull()
  })

  it('claimTask：改了时间就是新的一次 occurrence，可以再抢', () => {
    const task = createTask(db, {
      instruction: '到点关心他',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    claimTask(db, task.id, now)
    updateTask(db, { id: task.id, nextDueAt: at('2026-11-01', '13:00'), now })
    expect(claimTask(db, task.id, now)).not.toBeNull()
  })

  it('claimTask：取消之后抢不到', () => {
    const task = createTask(db, {
      instruction: '取消掉了',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    cancelTask(db, task.id, now)
    expect(claimTask(db, task.id, now)).toBeNull()
  })
})

describe('结算：重复推进 / 延后 / 完成', () => {
  const now = at('2026-11-01', '12:00')

  it('一次性任务跑完就是 completed，并记下 last_run_at', () => {
    const task = createTask(db, {
      instruction: '一次性',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    const settled = settleTask(db, task.id, {}, now)
    expect(settled?.state).toBe('completed')
    expect(settled?.last_run_at).toBe(now)
  })

  it('重复任务跑完仍是 active，next_due_at 推到未来（过去的几次不补）', () => {
    const task = createTask(db, {
      instruction: '每天提醒',
      nextDueAt: at('2026-10-30', '09:00'),
      repeat: 'daily',
      origin: 'agent',
      now
    })
    const settled = settleTask(db, task.id, {}, now)
    expect(settled?.state).toBe('active')
    expect(settled?.next_due_at).not.toBeNull()
    expect((settled?.next_due_at ?? 0) > now).toBe(true)
    expect(dayKeyOf(settled?.next_due_at ?? 0)).toBe('2026-11-02')
  })

  it('延后：给了 nextDueAt 就保持 active 并改到那个时间', () => {
    const task = createTask(db, {
      instruction: '待会儿再说',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    const settled = settleTask(db, task.id, { nextDueAt: at('2026-11-01', '14:00') }, now)
    expect(settled?.state).toBe('active')
    expect(settled?.next_due_at).toBe(at('2026-11-01', '14:00'))
  })

  it('静默收尾：明确给 state 就照办', () => {
    const task = createTask(db, {
      instruction: '用户已经自己说了，不用我问',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    expect(settleTask(db, task.id, { state: 'completed' }, now)?.state).toBe('completed')
  })

  it('没有到点时间的任务跑完直接完成（不会永远挂在队列里）', () => {
    const task = createTask(db, { instruction: '只是记着', nextDueAt: null, origin: 'agent', now })
    expect(settleTask(db, task.id, {}, now)?.state).toBe('completed')
  })
})

describe('人话描述', () => {
  it('description 带上来源 / 重复 / 同步状态', () => {
    const now = at('2026-11-01', '12:00')
    const task = createTask(db, {
      instruction: '写周报',
      nextDueAt: at('2026-11-02', '09:30'),
      repeat: 'weekly',
      origin: 'user',
      now
    })
    updateTask(db, { id: task.id, obsidianState: 'failed', obsidianNote: '没有 # Tracking 段', now })
    const line = describeTask(getTaskById(db, task.id)!, now)
    expect(line).toContain('#')
    expect(line).toContain('每周')
    expect(line).toContain('共建')
    expect(line).toContain('Obsidian 未同步')
  })
})

describe('窗口判定', () => {
  it('occurrenceInWindow：一次性只看落没落在窗口里', () => {
    const task = createTask(db, {
      instruction: '一次性',
      nextDueAt: at('2026-11-02', '09:00'),
      origin: 'agent',
      now: at('2026-11-01', '12:00')
    })
    expect(occurrenceInWindow(task, at('2026-11-02', '00:00'), at('2026-11-03', '00:00'))).not.toBeNull()
    expect(occurrenceInWindow(task, at('2026-11-01', '00:00'), at('2026-11-02', '00:00'))).toBeNull()
  })
})
