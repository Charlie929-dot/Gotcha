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
  alignFirstOccurrence,
  cancelTask,
  claimTask,
  countActiveTasks,
  createTask,
  dayKeyOf,
  dayWindow,
  describeRepeat,
  describeTask,
  expireTasks,
  formatRepeat,
  getTaskById,
  listDueTasks,
  nextDueTask,
  occurrenceInWindow,
  parseRepeat,
  releaseStaleClaims,
  resolveRepeat,
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

describe('重复规则：解析 / 多选 / 短月', () => {
  it('解析：多选去重升序；认不出的一律当一次性', () => {
    expect(parseRepeat('weekly:5,1,3,3')).toEqual({
      kind: 'weekly',
      weekdays: [1, 3, 5],
      monthDays: [],
      yearlyMonth: null,
      yearlyDay: null
    })
    expect(parseRepeat('monthly:15,1')).toEqual({
      kind: 'monthly',
      weekdays: [],
      monthDays: [1, 15],
      yearlyMonth: null,
      yearlyDay: null
    })
    expect(parseRepeat('weekly:0')).toMatchObject({ kind: '' })
    expect(parseRepeat('monthly:32')).toMatchObject({ kind: '' })
    expect(parseRepeat('hourly')).toMatchObject({ kind: '' })
    expect(
      formatRepeat({ kind: 'weekly', weekdays: [3, 1], monthDays: [], yearlyMonth: null, yearlyDay: null })
    ).toBe('weekly:1,3')
    expect(
      formatRepeat({ kind: 'monthly', weekdays: [], monthDays: [15, 1], yearlyMonth: null, yearlyDay: null })
    ).toBe('monthly:1,15')
  })

  it('没给列表：按第一次到点补出周几 / 日号（新写入不落裸 weekly / monthly）', () => {
    expect(resolveRepeat({ kind: 'weekly', anchor: at('2026-11-04', '09:30') })).toBe('weekly:3')
    expect(resolveRepeat({ kind: 'monthly', anchor: at('2026-11-30', '09:30') })).toBe('monthly:30')
    expect(resolveRepeat({ kind: 'weekly', weekdays: [5, 1] })).toBe('weekly:1,5')
    expect(resolveRepeat({ kind: 'daily', anchor: at('2026-11-04', '09:30') })).toBe('daily')
    expect(resolveRepeat({ kind: 'yearly', anchor: at('2026-11-01', '09:30') })).toBe('yearly:11-01')
    expect(resolveRepeat({ kind: 'weekly' })).toBe('weekly')
  })

  it('yearly：解析 / 持久化 / 跨年推进 / 平年 2-29 钳到 2-28', () => {
    expect(parseRepeat('yearly:11-01')).toEqual({
      kind: 'yearly',
      weekdays: [],
      monthDays: [],
      yearlyMonth: 11,
      yearlyDay: 1
    })
    expect(parseRepeat('yearly:2-29')).toMatchObject({ kind: 'yearly', yearlyMonth: 2, yearlyDay: 29 })
    expect(parseRepeat('yearly:2-30')).toMatchObject({ kind: '' })
    expect(parseRepeat('yearly:13-01')).toMatchObject({ kind: '' })
    expect(
      formatRepeat({
        kind: 'yearly',
        weekdays: [],
        monthDays: [],
        yearlyMonth: 11,
        yearlyDay: 1
      })
    ).toBe('yearly:11-01')
    // 从 2026-11-01 出发，下一次是 2027-11-01（跨年）
    expect(dayKeyOf(advanceOccurrence(at('2026-11-01', '09:30'), 'yearly:11-01'))).toBe('2027-11-01')
    // 平年没有 2-29：钳到 2 月 28；闰年 2028 照常 2-29
    expect(dayKeyOf(advanceOccurrence(at('2026-03-01', '09:30'), 'yearly:02-29'))).toBe('2027-02-28')
    expect(dayKeyOf(advanceOccurrence(at('2027-03-01', '09:30'), 'yearly:02-29'))).toBe('2028-02-29')
  })

  it('yearly 首次到点归一：when 对不上月日就顺延到下一次', () => {
    expect(dayKeyOf(alignFirstOccurrence(at('2026-11-05', '07:00'), 'yearly:11-01') ?? 0)).toBe(
      '2027-11-01'
    )
    expect(alignFirstOccurrence(at('2026-11-01', '07:00'), 'yearly:11-01')).toBe(
      at('2026-11-01', '07:00')
    )
  })

  it('weekly 多选：周一推到周三、周五推到下周一（钟点不变）', () => {
    const mon = at('2026-11-02', '09:30')
    expect(dayKeyOf(advanceOccurrence(mon, 'weekly:1,3,5'))).toBe('2026-11-04')
    const fri = at('2026-11-06', '09:30')
    const next = advanceOccurrence(fri, 'weekly:1,3,5')
    expect(dayKeyOf(next)).toBe('2026-11-09')
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getMinutes()).toBe(30)
  })

  it('monthly 多选：跳过已经过去的几号，短月钳到当月最后一天且日号不漂', () => {
    expect(dayKeyOf(advanceOccurrence(at('2026-11-05', '09:30'), 'monthly:15'))).toBe('2026-11-15')
    expect(dayKeyOf(advanceOccurrence(at('2026-11-16', '09:30'), 'monthly:1,15'))).toBe('2026-12-01')
    // 1 月 31 号 → 2 月没有 31 号，落到 28 号；下一次仍然是 3 月 31 号
    expect(dayKeyOf(advanceOccurrence(at('2027-01-31', '09:30'), 'monthly:31'))).toBe('2027-02-28')
    expect(dayKeyOf(advanceOccurrence(at('2027-02-28', '09:30'), 'monthly:31'))).toBe('2027-03-31')
    // 闰年 2 月 29 号照常
    expect(dayKeyOf(advanceOccurrence(at('2028-01-31', '09:30'), 'monthly:31'))).toBe('2028-02-29')
  })

  it('首次到点归一：when 对不上规则就顺延到下一个所选日（钟点不变）', () => {
    const tue = at('2026-11-03', '09:30')
    const aligned = alignFirstOccurrence(tue, 'weekly:1,3,5') ?? 0
    expect(dayKeyOf(aligned)).toBe('2026-11-04')
    expect(new Date(aligned).getHours()).toBe(9)
    // 已经落在所选日就不动
    expect(alignFirstOccurrence(tue, 'weekly:2')).toBe(tue)
    expect(dayKeyOf(alignFirstOccurrence(at('2026-11-05', '07:00'), 'monthly:15') ?? 0)).toBe(
      '2026-11-15'
    )
    expect(dayKeyOf(alignFirstOccurrence(at('2027-02-10', '07:00'), 'monthly:31') ?? 0)).toBe(
      '2027-02-28'
    )
  })

  it('新建 monthly 任务：落库前就把第一次到点归一到所选日 / 短月最后一天', () => {
    const task = createTask(db, {
      instruction: '每月最后一天对账',
      nextDueAt: at('2027-02-10', '07:00'),
      repeat: 'monthly:31',
      origin: 'agent',
      now: at('2027-02-01', '12:00')
    })
    expect(task.repeat).toBe('monthly:31')
    expect(dayKeyOf(task.next_due_at ?? 0)).toBe('2027-02-28')
  })

  it('结算 weekly 多选：周三跑完推到周五，仍是 active', () => {
    const now = at('2026-11-04', '10:00')
    const task = createTask(db, {
      instruction: '一三五提醒他喝水',
      nextDueAt: at('2026-11-04', '09:30'),
      repeat: 'weekly:1,3,5',
      origin: 'agent',
      now
    })
    const settled = settleTask(db, task.id, {}, now)
    expect(settled?.state).toBe('active')
    expect(dayKeyOf(settled?.next_due_at ?? 0)).toBe('2026-11-06')
  })

  it('day 视图：monthly 任务在 12-15 那天算一次，前一天不算', () => {
    const now = at('2026-11-01', '12:00')
    createTask(db, {
      instruction: '每月 15 号交房租',
      nextDueAt: at('2026-11-15', '20:00'),
      repeat: 'monthly:15',
      origin: 'agent',
      now
    })
    expect(
      searchTasks(db, { view: 'day', day: '2026-12-15', now }).tasks.map((task) => task.instruction)
    ).toContain('每月 15 号交房租')
    expect(searchTasks(db, { view: 'day', day: '2026-12-14', now }).total).toBe(0)
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

  it('抢了租约还没结算的行不再排队首 / 不再进到点列表（否则调度器 0ms 空转）', () => {
    const task = createTask(db, {
      instruction: '跑到一半重启了',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    expect(claimTask(db, task.id, now)?.id).toBe(task.id)
    // 2026-11-02 事故：这条留在队首 → nextDueAt 永远是「已经过去」→ 定时器 0ms → 主进程烧 CPU
    expect(nextDueTask(db)).toBeNull()
    expect(listDueTasks(db, now)).toHaveLength(0)
  })

  it('releaseStaleClaims：只释放「抢了没结算」的；结算过的重复 / 一次性都不动', () => {
    const wedged = createTask(db, {
      instruction: '被重启打断',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    claimTask(db, wedged.id, now)

    const daily = createTask(db, {
      instruction: '每天写日记',
      nextDueAt: at('2026-11-01', '11:00'),
      repeat: 'daily',
      origin: 'agent',
      now
    })
    claimTask(db, daily.id, now)
    settleTask(db, daily.id, {}, now) // 正常结算：下一次推到 11-02

    const once = createTask(db, {
      instruction: '一次性的事',
      nextDueAt: at('2026-11-01', '11:00'),
      origin: 'agent',
      now
    })
    claimTask(db, once.id, now)
    settleTask(db, once.id, {}, now) // 正常结算：completed

    expect(releaseStaleClaims(db, now)).toBe(1)
    expect(getTaskById(db, wedged.id)?.run_key).toBeNull()
    // 释放之后这一次能补跑（失败不丢），但不会把已完成 / 已推进的弄回来
    expect(claimTask(db, wedged.id, now)?.id).toBe(wedged.id)
    expect(getTaskById(db, daily.id)?.next_due_at).toBe(at('2026-11-02', '11:00'))
    expect(getTaskById(db, once.id)?.state).toBe('completed')
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

  it('describeRepeat：多选周几 / 每月几号 / 每年月日；旧裸值按下一次说', () => {
    expect(describeRepeat('weekly:1,3,5')).toBe('每周一、三、五')
    expect(describeRepeat('monthly:1,15')).toBe('每月 1、15 号')
    expect(describeRepeat('yearly:11-01')).toBe('每年 11 月 1 日')
    expect(describeRepeat('weekly', at('2026-11-04', '09:30'))).toBe('每周三')
    expect(describeRepeat('monthly', at('2026-11-15', '09:30'))).toBe('每月 15 号')
    expect(describeRepeat('yearly', at('2026-11-01', '09:30'))).toBe('每年 11 月 1 日')
    expect(describeRepeat('daily')).toBe('每天')
    expect(describeRepeat('')).toBe('')
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

/**
 * 2026-11-02 真机事故：模型在投递过程中 `cancel_task` 成功，投递结束结算又把它写回 active，
 * 第二天重复提醒。结算只能改「还活着」的行。
 */
describe('结算不把已取消的任务掰回来', () => {
  it('执行中被取消：给 nextDueAt 结算后仍是 cancelled', () => {
    const due = at('2026-11-02', '17:40')
    const task = createTask(db, {
      instruction: '放学后去跑步',
      nextDueAt: due,
      repeat: 'daily',
      origin: 'user',
      now: due - 60_000
    })
    expect(claimTask(db, task.id, due)).not.toBeNull()
    cancelTask(db, task.id, due + 1_000)
    settleTask(db, task.id, { nextDueAt: due + 10 * 60_000 }, due + 2_000)
    const row = getTaskById(db, task.id)
    expect(row?.state).toBe('cancelled')
    expect(row?.next_due_at).toBe(due)
  })

  it('执行中被取消：按重复规则推进后仍是 cancelled', () => {
    const due = at('2026-11-02', '17:40')
    const task = createTask(db, {
      instruction: '放学后去跑步',
      nextDueAt: due,
      repeat: 'daily',
      origin: 'user',
      now: due - 60_000
    })
    expect(claimTask(db, task.id, due)).not.toBeNull()
    cancelTask(db, task.id, due + 1_000)
    settleTask(db, task.id, {}, due + 2_000)
    const row = getTaskById(db, task.id)
    expect(row?.state).toBe('cancelled')
    expect(row?.next_due_at).toBe(due)
  })

  it('执行中被取消：一次性任务不会被结算成 completed', () => {
    const due = at('2026-11-02', '17:40')
    const task = createTask(db, {
      instruction: '一次性提醒',
      nextDueAt: due,
      origin: 'user',
      now: due - 60_000
    })
    expect(claimTask(db, task.id, due)).not.toBeNull()
    cancelTask(db, task.id, due + 1_000)
    settleTask(db, task.id, {}, due + 2_000)
    expect(getTaskById(db, task.id)?.state).toBe('cancelled')
  })
})

/**
 * 2026-11-02 真机事故：投递失败时用 `nextDueAt: at + 10min` 重试，把「每天 17:40」
 * 一步一步推成「每天 22:00」。失败只能退避，不能动锚点。
 */
describe('失败退避不动周期任务的锚点', () => {
  it('retryIn：只放开租约，next_due_at 与 state 原样', () => {
    const due = at('2026-11-02', '17:40')
    const task = createTask(db, {
      instruction: '放学后去跑步',
      nextDueAt: due,
      repeat: 'daily',
      origin: 'user',
      now: due - 60_000
    })
    expect(claimTask(db, task.id, due)).not.toBeNull()
    settleTask(db, task.id, { retryIn: 10 * 60_000 }, due + 1_000)
    const row = getTaskById(db, task.id)
    expect(row?.next_due_at).toBe(due)
    expect(row?.state).toBe('active')
    // 租约必须放开，否则同一次 occurrence 再也抢不到、也就永远不重试
    expect(row?.run_key).toBeNull()
    expect(claimTask(db, task.id, due + 11 * 60_000)).not.toBeNull()
  })

  it('retryIn 之后成功：按原锚点推进（17:40 → 次日 17:40，不是 22:00）', () => {
    const due = at('2026-11-02', '17:40')
    const task = createTask(db, {
      instruction: '放学后去跑步',
      nextDueAt: due,
      repeat: 'daily',
      origin: 'user',
      now: due - 60_000
    })
    claimTask(db, task.id, due)
    settleTask(db, task.id, { retryIn: 10 * 60_000 }, due + 1_000)
    claimTask(db, task.id, due + 20 * 60_000)
    settleTask(db, task.id, {}, due + 20 * 60_000)
    const row = getTaskById(db, task.id)
    expect(row?.state).toBe('active')
    expect(row?.next_due_at).toBe(at('2026-11-03', '17:40').valueOf())
  })
})

