/**
 * 成长档案 · 写作任务（src/memory/agent/growth-tasks.ts）
 *
 * 守的纪律（自调用 v0.2 §8 / §12.3）：
 * 1. 日记是 ta 自己的自主任务（origin=agent / background / daily），默认 23:30，可被改；
 * 2. 播种幂等：同一条说明出现过（哪怕已取消）就不再建，重启不复活；
 * 3. 周记只在周日、这周还没写、今天还没排过时串一条，排在日记之后 2 分钟；
 * 4. 一次只做一件事：周记是一条一次性任务，不会和日记抢同一刻。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type Db } from '../../src/db'
import {
  GROWTH_DAILY_INSTRUCTION,
  GROWTH_WEEKLY_DELAY_MS,
  GROWTH_WEEKLY_INSTRUCTION,
  ensureGrowthDailyTask,
  ensureWeeklyWritingTask,
  isGrowthDailyTask,
  isWeeklyReviewDay,
  nextDailyWritingAt
} from '../../src/memory/agent/growth-tasks'
import { cancelTask, getTaskById, updateTask } from '../../src/memory/agent/tasks'

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
})

describe('周记串在日记之后', () => {
  it('非周日不排', () => {
    expect(ensureWeeklyWritingTask(db, MONDAY, { weeklyWritten: false })).toBeNull()
  })

  it('这周已经写过周记就不排', () => {
    expect(ensureWeeklyWritingTask(db, SUNDAY, { weeklyWritten: true })).toBeNull()
  })

  it('周日 + 没写过：排一条一次性周记，2 分钟后到点', () => {
    const seed = ensureWeeklyWritingTask(db, SUNDAY, { weeklyWritten: false })
    expect(seed).not.toBeNull()
    expect(seed?.task).toMatchObject({
      origin: 'agent',
      delivery: 'background',
      repeat: '',
      instruction: GROWTH_WEEKLY_INSTRUCTION
    })
    expect(seed?.task.next_due_at).toBe(SUNDAY + GROWTH_WEEKLY_DELAY_MS)
  })

  it('同一天重复触发不建第二条；上周那条做完后下周还能再排', () => {
    const first = ensureWeeklyWritingTask(db, SUNDAY, { weeklyWritten: false })
    expect(first).not.toBeNull()
    expect(ensureWeeklyWritingTask(db, SUNDAY + 60_000, { weeklyWritten: false })).toBeNull()
    // 这一条做完（一次性任务）之后，下个周日（2026-11-08）还能再排
    if (first === null) return
    updateTask(db, { id: first.task.id, state: 'completed', now: SUNDAY + 120_000 })
    const nextSunday = at('2026-11-08', '23:35')
    expect(ensureWeeklyWritingTask(db, nextSunday, { weeklyWritten: false })).not.toBeNull()
  })

  it('已有一条活着的周记任务就不再建', () => {
    const first = ensureWeeklyWritingTask(db, SUNDAY, { weeklyWritten: false })
    expect(first).not.toBeNull()
    // 换一天（下周日）但上一条还挂着：不重复建
    const nextSunday = at('2026-11-08', '23:35')
    expect(ensureWeeklyWritingTask(db, nextSunday, { weeklyWritten: false })).toBeNull()
  })
})
