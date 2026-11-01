/**
 * 成长档案 · 写作任务（src/memory/agent/growth-tasks.ts）
 *
 * 守的纪律（自调用 v0.2 §8 / §12.3）：
 * 1. 日记是 ta 自己的自主任务（origin=agent / background / daily），默认 23:30，可被改；
 * 2. 播种幂等：同一条说明出现过（哪怕已取消）就不再建，重启不复活；
 * 3. 一层写完串下一篇（周日周记 / 月末总结 / 年终总结），排在上一层之后 2 分钟；
 * 4. 一次只做一件事：接力出来的都是各自的一条一次性任务，不会抢同一刻、也不会堆。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type Db } from '../../src/db'
import {
  GROWTH_DAILY_INSTRUCTION,
  GROWTH_LEGACY_INSTRUCTIONS,
  GROWTH_MONTHLY_INSTRUCTION,
  GROWTH_WEEKLY_DELAY_MS,
  GROWTH_WEEKLY_INSTRUCTION,
  GROWTH_YEARLY_INSTRUCTION,
  ensureGrowthDailyTask,
  ensureNextGrowthWriting,
  isGrowthDailyTask,
  isGrowthWritingTask,
  isMonthEndDay,
  isWeeklyReviewDay,
  isYearEndDay,
  nextDailyWritingAt
} from '../../src/memory/agent/growth-tasks'
import { cancelTask, createTask, getTaskById, updateTask } from '../../src/memory/agent/tasks'

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function at(day: string, hhmm = '09:00'): number {
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = hhmm.split(':').map(Number)
  return new Date(year, month - 1, date, hour, minute, 0, 0).getTime()
}

/** 2026-11-01 是周日；10-31 是周六；11-02 是周一 */
const SUNDAY = at('2026-11-01', '23:35')
const MONDAY = at('2026-11-02', '23:35')

describe('写作时刻', () => {
  it('当天 23:30；已经过了就排到明天', () => {
    const before = at('2026-11-01', '10:00')
    expect(new Date(nextDailyWritingAt(before)).getHours()).toBe(23)
    expect(new Date(nextDailyWritingAt(before)).getDate()).toBe(1)
    const after = at('2026-11-01', '23:45')
    expect(new Date(nextDailyWritingAt(after)).getDate()).toBe(2)
  })

  it('周日才算收尾日', () => {
    expect(isWeeklyReviewDay(SUNDAY)).toBe(true)
    expect(isWeeklyReviewDay(MONDAY)).toBe(false)
  })
})

describe('日记任务播种', () => {
  it('建一条 agent / background / daily 的任务，排在最近一个 23:30', () => {
    const now = at('2026-11-01', '10:00')
    const seed = ensureGrowthDailyTask(db, now)
    expect(seed.created).toBe(true)
    expect(seed.task).toMatchObject({
      origin: 'agent',
      delivery: 'background',
      repeat: 'daily',
      state: 'active',
      instruction: GROWTH_DAILY_INSTRUCTION
    })
    expect(new Date(seed.task.next_due_at ?? 0).getHours()).toBe(23)
    expect(isGrowthDailyTask(seed.task)).toBe(true)
  })

  it('再播一次不新建（同一条返回）', () => {
    const first = ensureGrowthDailyTask(db, MONDAY)
    const second = ensureGrowthDailyTask(db, MONDAY + 1000)
    expect(second.created).toBe(false)
    expect(second.task.id).toBe(first.task.id)
  })

  it('用户取消过就不复活（任何状态都算播过）', () => {
    const seed = ensureGrowthDailyTask(db, MONDAY)
    cancelTask(db, seed.task.id, MONDAY + 1000)
    const again = ensureGrowthDailyTask(db, MONDAY + 2000)
    expect(again.created).toBe(false)
    expect(getTaskById(db, seed.task.id)?.state).toBe('cancelled')
  })

  it('任务名就是「写日记」，不长篇说明', () => {
    const seed = ensureGrowthDailyTask(db, MONDAY)
    expect(seed.task.instruction).toBe('写日记')
    expect(GROWTH_DAILY_INSTRUCTION).toBe('写日记')
    expect(GROWTH_WEEKLY_INSTRUCTION).toBe('写周记')
  })

  it('旧版长说明原地改名，不新建第二条', () => {
    const legacy = createTask(db, {
      instruction: GROWTH_LEGACY_INSTRUCTIONS[0] as string,
      nextDueAt: MONDAY,
      repeat: 'daily',
      origin: 'agent',
      delivery: 'background',
      now: MONDAY
    })
    const seed = ensureGrowthDailyTask(db, MONDAY + 1000)
    expect(seed.created).toBe(false)
    expect(seed.task.id).toBe(legacy.id)
    expect(seed.task.instruction).toBe('写日记')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mem_tasks`).get()).toEqual({ n: 1 })
  })
})

describe('收尾日', () => {
  it('月末：28 / 29 / 30 / 31 天都认（闰年 2-29）', () => {
    expect(isMonthEndDay(at('2026-11-30', '23:35'))).toBe(true)
    expect(isMonthEndDay(at('2026-11-29', '23:35'))).toBe(false)
    expect(isMonthEndDay(at('2026-02-28', '23:35'))).toBe(true)
    expect(isMonthEndDay(at('2028-02-29', '23:35'))).toBe(true)
    expect(isMonthEndDay(at('2028-02-28', '23:35'))).toBe(false)
    expect(isMonthEndDay(at('2026-04-30', '23:35'))).toBe(true)
    expect(isMonthEndDay(at('2026-04-29', '23:35'))).toBe(false)
    expect(isMonthEndDay(at('2026-12-31', '23:35'))).toBe(true)
  })

  it('年末只有 12-31', () => {
    expect(isYearEndDay(at('2026-12-31', '23:35'))).toBe(true)
    expect(isYearEndDay(at('2026-12-30', '23:35'))).toBe(false)
    expect(isYearEndDay(at('2026-11-30', '23:35'))).toBe(false)
  })
})

/** 一层都还没写 */
const NOTHING = { weekly: false, monthly: false, yearly: false }

describe('接力：一层写完串下一篇', () => {
  it('普通日子（非周日 / 非月末）：一层都不排', () => {
    expect(ensureNextGrowthWriting(db, MONDAY, NOTHING)).toBeNull()
  })

  it('周日 + 这周没写：排一条一次性周记，2 分钟后到点', () => {
    const seed = ensureNextGrowthWriting(db, SUNDAY, NOTHING)
    expect(seed).not.toBeNull()
    expect(seed?.task).toMatchObject({
      origin: 'agent',
      delivery: 'background',
      repeat: '',
      instruction: GROWTH_WEEKLY_INSTRUCTION
    })
    expect(seed?.task.next_due_at).toBe(SUNDAY + GROWTH_WEEKLY_DELAY_MS)
  })

  it('这周已经写过周记就不排', () => {
    expect(ensureNextGrowthWriting(db, SUNDAY, { ...NOTHING, weekly: true })).toBeNull()
  })

  it('月末 + 没写过：排月末总结；已经写过就不排', () => {
    const monthEnd = at('2026-11-30', '23:35')
    const seed = ensureNextGrowthWriting(db, monthEnd, NOTHING)
    expect(seed?.task).toMatchObject({
      instruction: GROWTH_MONTHLY_INSTRUCTION,
      repeat: '',
      delivery: 'background'
    })
    expect(seed?.task.next_due_at).toBe(monthEnd + GROWTH_WEEKLY_DELAY_MS)
    expect(ensureNextGrowthWriting(db, monthEnd, { ...NOTHING, monthly: true })).toBeNull()
  })

  it('12-31（非周日）：月末总结在前，写完了才排年终总结', () => {
    const yearEnd = at('2026-12-31', '23:35')
    const monthly = ensureNextGrowthWriting(db, yearEnd, NOTHING)
    expect(monthly?.task.instruction).toBe(GROWTH_MONTHLY_INSTRUCTION)
    // 月末总结还挂着：年终总结不插队
    expect(ensureNextGrowthWriting(db, yearEnd, NOTHING)).toBeNull()
    // 月末总结写完了：轮到年终总结
    if (monthly === null) return
    updateTask(db, { id: monthly.task.id, state: 'completed', now: yearEnd + 60_000 })
    const yearly = ensureNextGrowthWriting(db, yearEnd + 120_000, {
      ...NOTHING,
      monthly: true
    })
    expect(yearly?.task.instruction).toBe(GROWTH_YEARLY_INSTRUCTION)
    // 都写完了：不排
    expect(
      ensureNextGrowthWriting(db, yearEnd + 180_000, { weekly: true, monthly: true, yearly: true })
    ).toBeNull()
  })

  it('周日恰好是月末（2026-05-31）：周记在前，再月末总结，最后年终不掺和', () => {
    const sundayMonthEnd = at('2026-05-31', '23:35')
    expect(isWeeklyReviewDay(sundayMonthEnd)).toBe(true)
    expect(isMonthEndDay(sundayMonthEnd)).toBe(true)
    expect(isYearEndDay(sundayMonthEnd)).toBe(false)
    const weekly = ensureNextGrowthWriting(db, sundayMonthEnd, NOTHING)
    expect(weekly?.task.instruction).toBe(GROWTH_WEEKLY_INSTRUCTION)
    if (weekly === null) return
    updateTask(db, { id: weekly.task.id, state: 'completed', now: sundayMonthEnd + 60_000 })
    const monthly = ensureNextGrowthWriting(db, sundayMonthEnd + 120_000, {
      ...NOTHING,
      weekly: true
    })
    expect(monthly?.task.instruction).toBe(GROWTH_MONTHLY_INSTRUCTION)
  })

  it('这一层今天试过（写失败也算）：跳过它，不把后面的层堵死', () => {
    const yearEnd = at('2026-12-31', '23:35')
    // 月末总结今天排过、已经跑完（没写成）
    const monthly = createTask(db, {
      instruction: GROWTH_MONTHLY_INSTRUCTION,
      nextDueAt: yearEnd,
      repeat: '',
      origin: 'agent',
      delivery: 'background',
      now: yearEnd
    })
    updateTask(db, { id: monthly.id, state: 'completed', now: yearEnd + 1000 })
    const yearly = ensureNextGrowthWriting(db, yearEnd + 60_000, NOTHING)
    expect(yearly?.task.instruction).toBe(GROWTH_YEARLY_INSTRUCTION)
  })

  it('同一天重复触发不建第二条；下个周期还能再排', () => {
    const first = ensureNextGrowthWriting(db, SUNDAY, NOTHING)
    expect(first).not.toBeNull()
    expect(ensureNextGrowthWriting(db, SUNDAY + 60_000, NOTHING)).toBeNull()
    if (first === null) return
    updateTask(db, { id: first.task.id, state: 'completed', now: SUNDAY + 120_000 })
    const nextSunday = at('2026-11-08', '23:35')
    expect(ensureNextGrowthWriting(db, nextSunday, NOTHING)).not.toBeNull()
  })

  it('旧版周记长说明也会改名；改完那条还活着，就不再排新的', () => {
    const legacy = createTask(db, {
      instruction: GROWTH_LEGACY_INSTRUCTIONS[1] as string,
      nextDueAt: SUNDAY + GROWTH_WEEKLY_DELAY_MS,
      repeat: '',
      origin: 'agent',
      delivery: 'background',
      now: SUNDAY
    })
    expect(ensureNextGrowthWriting(db, SUNDAY, NOTHING)).toBeNull()
    expect(getTaskById(db, legacy.id)?.instruction).toBe('写周记')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mem_tasks`).get()).toEqual({ n: 1 })
  })
})

describe('哪些任务算写作任务', () => {
  it('四种名字都算（交付回来要接力）；不相干的不算', () => {
    const task = (instruction: string): Parameters<typeof isGrowthWritingTask>[0] =>
      ({ instruction }) as Parameters<typeof isGrowthWritingTask>[0]
    for (const name of [
      GROWTH_DAILY_INSTRUCTION,
      GROWTH_WEEKLY_INSTRUCTION,
      GROWTH_MONTHLY_INSTRUCTION,
      GROWTH_YEARLY_INSTRUCTION
    ]) {
      expect(isGrowthWritingTask(task(name))).toBe(true)
    }
    expect(isGrowthWritingTask(task('提醒他去晚点名'))).toBe(false)
    expect(isGrowthDailyTask(task(GROWTH_MONTHLY_INSTRUCTION))).toBe(false)
  })
})
