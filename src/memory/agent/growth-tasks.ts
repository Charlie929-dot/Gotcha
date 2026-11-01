/**
 * 成长档案 · 写作任务（自调用 v0.2 §8 / §12.3，2026-11-01）
 *
 * 写作不是系统 cron，而是 **ta 自己的自主任务**（`origin='agent'`、`delivery='background'`）：
 *
 * - 每天一条「写日记」——默认排到 23:30，但它在 `mem_tasks` 里，
 *   ta 可以 `update_task` 改时间 / `cancel_task` 取消，用户也可以在设置抽屉里暂停；
 * - 一层写完，串下一篇（一次只做一件事，每步 `now + 2 分钟`）：
 *   日记 →（周日）周记 →（月末）月末总结 →（年末）年终总结。
 *   所以 12-31 那晚会依次做完：日记 → 月末总结 → 年终总结（若当天恰好是周日，周记排在月末之前）。
 *
 * 播种是**幂等**的：同一条说明只要在库里出现过（任何状态）就不再建——
 * 用户取消过就不会因为重启又冒出来。
 */

import type { Db } from '../../db'

import { createTask, type TaskRow } from './tasks'

/**
 * 写作任务的名字（2026-11-01 拍板：名字就写「写日记」/「写周记」，不长篇说明；
 * 写什么、怎么写由 ta 自己定，工具描述只讲格式）。
 * 它同时是「播种过没有」的稳定标识，改字要一起改。
 */
export const GROWTH_DAILY_INSTRUCTION = '写日记'

/** 周记写作任务的名字 */
export const GROWTH_WEEKLY_INSTRUCTION = '写周记'

/** 月末总结写作任务的名字（2026-11-01 拍板；月末最后一天日记写完后串） */
export const GROWTH_MONTHLY_INSTRUCTION = '写月末总结'

/** 年终总结写作任务的名字（2026-11-01 拍板；12-31 依次串在月末总结之后） */
export const GROWTH_YEARLY_INSTRUCTION = '写年终总结'

/**
 * 旧版长说明（2026-11-01 上半天用过）：启动时原地改名成短名，
 * 不新建第二条——已经播种过的机器不会因为改名多出一条写作任务。
 */
const LEGACY_DAILY_INSTRUCTION =
  '写今天的日记：整理今天真实发生的事、你自己的感受和还没想完的事，用 write_growth（kind=daily）落笔。只写真实发生的，没有内容就不写；写完如果这周还没写周记，就把周记排到几分钟后（schedule_task）。时间不合适就自己改（update_task）。这是你自己的事，不用跟他说。'
const LEGACY_WEEKLY_INSTRUCTION =
  '写这一周的周记：整理这一周真实发生的事、相处里的变化和有证据的自我认识，用 write_growth（kind=weekly）落笔。不重复堆砌每天的流水；没有真实内容就不写。重要而稳定的结论可以顺手 update_notebook。'

/** 旧说明 → 新名字（启动时原地改名） */
const LEGACY_RENAMES: ReadonlyArray<{ from: string; to: string }> = [
  { from: LEGACY_DAILY_INSTRUCTION, to: GROWTH_DAILY_INSTRUCTION },
  { from: LEGACY_WEEKLY_INSTRUCTION, to: GROWTH_WEEKLY_INSTRUCTION }
]
export const GROWTH_LEGACY_INSTRUCTIONS: readonly string[] = LEGACY_RENAMES.map((item) => item.from)

/** 默认写作时刻：23:30（本地时间；ta 可以自己改） */
export const GROWTH_DAILY_HOUR = 23
export const GROWTH_DAILY_MINUTE = 30
/** 一篇写完后多久开始下一篇（单飞：这一轮结束才轮到下一条） */
export const GROWTH_WRITING_DELAY_MS = 2 * 60 * 1000
/** 老名字：周记的间隔（= 通用间隔），测试与老调用还在用 */
export const GROWTH_WEEKLY_DELAY_MS = GROWTH_WRITING_DELAY_MS

/** 当天 23:30；已经过了就排到明天 23:30 */
export function nextDailyWritingAt(now: number): number {
  const at = new Date(now)
  at.setHours(GROWTH_DAILY_HOUR, GROWTH_DAILY_MINUTE, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** 周记的「收尾日」：周日（本地日历）。ta 把日记挪到别的日子，就当天写周记 */
export function isWeeklyReviewDay(now: number): boolean {
  return new Date(now).getDay() === 0
}

/** 月末总结的「收尾日」：本地日历这个月的最后一天（28/29/30/31 都认） */
export function isMonthEndDay(now: number): boolean {
  const date = new Date(now)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  return date.getDate() === lastDay.getDate()
}

/** 年终总结的「收尾日」：12-31（本地日历） */
export function isYearEndDay(now: number): boolean {
  const date = new Date(now)
  return date.getMonth() === 11 && date.getDate() === 31
}

function dayStart(now: number): number {
  const at = new Date(now)
  at.setHours(0, 0, 0, 0)
  return at.getTime()
}

function findByInstruction(db: Db, instruction: string): TaskRow | null {
  const row = db
    .prepare(
      `SELECT id, instruction, next_due_at, repeat, origin, delivery, valid_until, state,
              last_run_at, run_key, obsidian_state, obsidian_path, obsidian_note, created_at, updated_at
       FROM mem_tasks WHERE instruction = ? ORDER BY id ASC LIMIT 1`
    )
    .get(instruction) as TaskRow | undefined
  return row ?? null
}

/**
 * 旧版长说明原地改名成短名（2026-11-01 拍板：任务名就写「写日记」/「写周记」）。
 * 改名而不是新建：已经播种过的机器不会因此多出一条写作任务。
 */
export function migrateLegacyGrowthInstructions(db: Db, now: number): number {
  const statement = db.prepare(`SELECT id FROM mem_tasks WHERE instruction = ? ORDER BY id ASC`)
  const rename = db.prepare(`UPDATE mem_tasks SET instruction = ?, updated_at = ? WHERE id = ?`)
  let changed = 0
  for (const item of LEGACY_RENAMES) {
    const rows = statement.all(item.from) as Array<{ id: number }>
    for (const row of rows) {
      rename.run(item.to, now, row.id)
      changed += 1
    }
  }
  return changed
}

/** 库里还有没有一条活着的（active / paused）同说明任务 */
function hasLiveInstruction(db: Db, instruction: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM mem_tasks WHERE instruction = ? AND state IN ('active', 'paused') LIMIT 1`
    )
    .get(instruction) as { id: number } | undefined
  return row !== undefined
}

/** 今天是不是已经排过一条同名任务（同一天重复触发不再建第二条） */
function queuedToday(db: Db, instruction: string, now: number): boolean {
  const row = db
    .prepare(
      `SELECT id FROM mem_tasks WHERE instruction = ? AND next_due_at IS NOT NULL AND next_due_at >= ? LIMIT 1`
    )
    .get(instruction, dayStart(now)) as { id: number } | undefined
  return row !== undefined
}

export interface GrowthTaskSeed {
  task: TaskRow
  created: boolean
}

/**
 * 播种「每天写日记」的自主任务（幂等）。
 * 已有同说明的行（哪怕已取消 / 已完成）就原样返回，不再建——用户取消过就不复活。
 * 旧版长说明会先原地改名（见 `migrateLegacyGrowthInstructions`）。
 */
export function ensureGrowthDailyTask(db: Db, now: number): GrowthTaskSeed {
  migrateLegacyGrowthInstructions(db, now)
  const existing = findByInstruction(db, GROWTH_DAILY_INSTRUCTION)
  if (existing !== null) return { task: existing, created: false }
  const task = createTask(db, {
    instruction: GROWTH_DAILY_INSTRUCTION,
    nextDueAt: nextDailyWritingAt(now),
    repeat: 'daily',
    origin: 'agent',
    delivery: 'background',
    now
  })
  return { task, created: true }
}

/** 上一层写完没写：这三个键就是接力时要问的问题 */
export interface GrowthWritingProgress {
  weekly: boolean
  monthly: boolean
  yearly: boolean
}

/**
 * 一层写完 → 串下一篇（一次只做一件事）：
 * 日记 →（周日）周记 →（月末）月末总结 →（年末）年终总结。
 *
 * - 已经排着一条活着的就暂停接力（等它做完再说，不堆）；
 * - 今天已经排过同名任务就不重复排；
 * - 这一层已经写过（`progress`）就跳过。
 *
 * 返回 null = 这次不用排。
 */
export function ensureNextGrowthWriting(
  db: Db,
  now: number,
  progress: GrowthWritingProgress
): GrowthTaskSeed | null {
  migrateLegacyGrowthInstructions(db, now)
  const steps: ReadonlyArray<{
    due: boolean
    written: boolean
    instruction: string
  }> = [
    { due: isWeeklyReviewDay(now), written: progress.weekly, instruction: GROWTH_WEEKLY_INSTRUCTION },
    {
      due: isMonthEndDay(now),
      written: progress.monthly,
      instruction: GROWTH_MONTHLY_INSTRUCTION
    },
    { due: isYearEndDay(now), written: progress.yearly, instruction: GROWTH_YEARLY_INSTRUCTION }
  ]
  for (const step of steps) {
    if (!step.due) continue
    if (step.written) continue
    // 活着的一条还没做完：先等它，别往上堆第二件（顺序不能乱：年终总结要读月末总结）
    if (hasLiveInstruction(db, step.instruction)) return null
    // 今天已经试过这一层（写失败也算试过）：跳过它，别把后面的层一起堵死
    if (queuedToday(db, step.instruction, now)) continue
    const task = createTask(db, {
      instruction: step.instruction,
      nextDueAt: now + GROWTH_WRITING_DELAY_MS,
      repeat: '',
      origin: 'agent',
      delivery: 'background',
      now
    })
    return { task, created: true }
  }
  return null
}

/** 所有写作任务的名字（含旧长名）：交付回来时判断「这条要不要接力」 */
const GROWTH_WRITING_INSTRUCTIONS: readonly string[] = [
  GROWTH_DAILY_INSTRUCTION,
  GROWTH_WEEKLY_INSTRUCTION,
  GROWTH_MONTHLY_INSTRUCTION,
  GROWTH_YEARLY_INSTRUCTION,
  LEGACY_DAILY_INSTRUCTION,
  LEGACY_WEEKLY_INSTRUCTION
]

/** 这条任务是不是成长档案的写作任务（写日记 / 周记 / 月末总结 / 年终总结；旧长名也认） */
export function isGrowthWritingTask(task: TaskRow): boolean {
  return GROWTH_WRITING_INSTRUCTIONS.includes(task.instruction)
}

/** 这条任务是不是「写日记」那条（旧长名也认） */
export function isGrowthDailyTask(task: TaskRow): boolean {
  return task.instruction === GROWTH_DAILY_INSTRUCTION || task.instruction === LEGACY_DAILY_INSTRUCTION
}
