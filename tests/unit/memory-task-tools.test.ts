/**
 * 任务工具执行体：共建计划 ↔ Obsidian 计划区（自调用 v0.2 §4.1）
 *
 * 守两条底线：
 * 1. **回执只认记录**：文案里的事实（id / 时间 / 同步状态）必须能对上库里的行与磁盘上的行；
 * 2. **失败不粉饰**：当天笔记没有 `# Tracking` 段时，计划照样落库，但回执要明说没同步上，
 *    绝不出现「已写进 Obsidian」这种话。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type Db } from '../../src/db'
import { createTaskToolPort } from '../../src/memory/agent/task-tools'
import { getTaskById } from '../../src/memory/agent/tasks'

const DAY = '2026-11-02'
/** 2026-11-02 19:30 本地时间 */
const WHEN = new Date(2026, 10, 2, 19, 30, 0, 0).getTime()

let root = ''
let db: Db
let vaultDir = ''

function writeNote(day: string, withTracking = true): void {
  const lines = [
    '---',
    `🌻日期🌻: ${day}`,
    '---',
    '',
    ...(withTracking ? ['# Tracking', '- [ ] 09:00-10:00 写周报', ''] : ['# Diary', '- 08:40 早。', '']),
    '# Diary',
    '- 08:40 早。',
    ''
  ]
  mkdirSync(vaultDir, { recursive: true })
  writeFileSync(join(vaultDir, `${day}.md`), `${lines.join('\n')}\n`, 'utf8')
}

function note(): string {
  return readFileSync(join(vaultDir, `${DAY}.md`), 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotcha-task-tools-'))
  vaultDir = join(root, 'daily')
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function port(changes: { count: number } = { count: 0 }) {
  return createTaskToolPort({
    db: () => db,
    now: () => WHEN - 60 * 60 * 1000,
    vaultDir: () => vaultDir,
    onChanged: () => {
      changes.count += 1
    }
  })
}

describe('共建计划：写库 + 写计划区', () => {
  it('记下计划：进 Task Tracking 段，回执里写明同步成功', () => {
    writeNote(DAY)
    const changes = { count: 0 }
    const result = port(changes).schedule({
      instruction: '一起去买猫粮',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('记下了共建计划')
    expect(result.message).toContain('已写进 Obsidian')
    expect(result.task?.sync).toBe('synced')
    expect(changes.count).toBe(1)

    const text = note()
    expect(text).toContain('- [ ] 19:30 一起去买猫粮 [❤️]()')
    // 用户自己那一行一个字节都没动
    expect(text).toContain('- [ ] 09:00-10:00 写周报')

    const stored = getTaskById(db, result.task!.id)
    expect(stored?.obsidian_state).toBe('synced')
    expect(stored?.origin).toBe('user')
  })

  it('当天笔记没有 # Tracking 段：计划照样落库，但回执明说没同步上', () => {
    writeNote(DAY, false)
    const result = port().schedule({
      instruction: '晚上十点半提醒他睡觉',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('记下了共建计划')
    expect(result.message).toContain('没同步上')
    expect(result.message).not.toContain('已写进 Obsidian')
    expect(result.task?.sync).toBe('failed')
    expect(getTaskById(db, result.task!.id)?.obsidian_state).toBe('failed')
  })

  it('没配日记目录：标记待同步，不当成同步成功', () => {
    const result = createTaskToolPort({ db: () => db, now: () => WHEN }).schedule({
      instruction: '周末去爬山',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.task?.sync).toBe('pending')
    expect(result.message).toContain('待同步')
  })

  it('自主任务不写用户 Obsidian（计划区只放共建计划）', () => {
    writeNote(DAY)
    const result = port().schedule({
      instruction: '问问他面试结果',
      when: WHEN,
      repeat: '',
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.task?.sync).toBeUndefined()
    expect(note()).not.toContain('面试结果')
    expect(result.message).toContain('记下了 #')
  })
})

describe('缺当天笔记：自动建再写（2026-11-01 拍板）', () => {
  it('当天笔记不存在：自动建一份，计划照样写进 # Tracking，回执说明是自动建的', () => {
    // 只建日记目录，不放当天笔记
    mkdirSync(vaultDir, { recursive: true })
    const result = port().schedule({
      instruction: '后天交小组作业',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.ok).toBe(true)
    expect(result.task?.sync).toBe('synced')
    expect(result.message).toContain('已写进 Obsidian')
    const text = readFileSync(join(vaultDir, `${DAY}.md`), 'utf8')
    expect(text).toContain('🌻日期🌻: 2026-11-02')
    expect(text).toContain('# Tracking')
    expect(text).toContain('- [ ] 19:30 后天交小组作业 [❤️]()')
    expect(getTaskById(db, result.task!.id)?.obsidian_note).toBe('当天笔记是自动建的')
  })

  it('设置关掉自动创建（autoCreateNote=false）：计划落库，但同步如实报失败', () => {
    mkdirSync(vaultDir, { recursive: true })
    const p = createTaskToolPort({
      db: () => db,
      now: () => WHEN - 60 * 60 * 1000,
      vaultDir: () => vaultDir,
      autoCreateNote: () => false
    })
    const result = p.schedule({
      instruction: '不去建笔记的计划',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.ok).toBe(true)
    expect(result.task?.sync).toBe('failed')
    expect(result.message).toContain('没同步上')
    expect(existsSync(join(vaultDir, `${DAY}.md`))).toBe(false)
    expect(getTaskById(db, result.task!.id)?.state).toBe('active')
  })

  it('已经有笔记：不会覆盖用户写的内容', () => {
    writeNote(DAY)
    const before = note()
    port().schedule({
      instruction: '写周报',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    const after = note()
    // 用户自己写的那行原样在，只多了一行计划
    expect(after.length).toBeGreaterThan(before.length)
    expect(after).toContain('- 08:40 早。')
    expect(getTaskById(db, 1)?.obsidian_note).toBeNull()
  })

  it('resyncPlans：上次没同步上的计划能补上，且不会重复追加', () => {
    mkdirSync(vaultDir, { recursive: true })
    const off = createTaskToolPort({
      db: () => db,
      now: () => WHEN - 60 * 60 * 1000,
      vaultDir: () => vaultDir,
      autoCreateNote: () => false
    })
    const created = off.schedule({
      instruction: '补同步的计划',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    expect(created.task?.sync).toBe('failed')

    // 第二次：允许自动建笔记 → 重试一次就同步上了
    const on = createTaskToolPort({
      db: () => db,
      now: () => WHEN - 60 * 60 * 1000,
      vaultDir: () => vaultDir
    })
    expect(on.resyncPlans()).toEqual({ attempted: 1, synced: 1 })
    const text = readFileSync(join(vaultDir, `${DAY}.md`), 'utf8')
    expect(text.match(/补同步的计划/gu)).toHaveLength(1)
    expect(getTaskById(db, created.task!.id)?.obsidian_state).toBe('synced')

    // 再跑一次：已经同步过，不在候选里，不会重复写
    expect(on.resyncPlans()).toEqual({ attempted: 0, synced: 0 })
    expect(readFileSync(join(vaultDir, `${DAY}.md`), 'utf8').match(/补同步的计划/gu)).toHaveLength(1)
  })
})

describe('修改与取消：同步到同一计划区', () => {
  it('同一天改时间：原地改那一行，勾选状态保留', () => {
    writeNote(DAY)
    const p = port()
    const created = p.schedule({
      instruction: '一起去买猫粮',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    // 用户勾掉了这一条：同步器改时间时不能把勾选抹掉
    writeFileSync(
      join(vaultDir, `${DAY}.md`),
      note().replace('- [ ] 19:30 一起去买猫粮 [❤️]()', '- [x] 19:30 一起去买猫粮 [❤️]()'),
      'utf8'
    )
    const updated = p.update({ id: created.task!.id, when: WHEN + 30 * 60 * 1000 })
    expect(updated.ok).toBe(true)
    expect(updated.message).toContain('改好了')
    const text = note()
    expect(text).toContain('- [x] 20:00 一起去买猫粮 [❤️]()')
    expect(text.match(/一起去买猫粮/gu)).toHaveLength(1)
  })

  it('取消共建计划：那一行也删掉，回执说明', () => {
    writeNote(DAY)
    const p = port()
    const created = p.schedule({
      instruction: '一起去买猫粮',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    const cancelled = p.cancel(created.task!.id)
    expect(cancelled.ok).toBe(true)
    expect(cancelled.message).toContain('取消了')
    expect(cancelled.message).toContain('删掉了')
    expect(note()).not.toContain('一起去买猫粮')
    expect(getTaskById(db, created.task!.id)?.state).toBe('cancelled')
  })

  it('用户自己删过那一行：取消照样成功，不报错', () => {
    writeNote(DAY)
    const p = port()
    const created = p.schedule({
      instruction: '一起去买猫粮',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    writeFileSync(
      join(vaultDir, `${DAY}.md`),
      note().replace('- [ ] 19:30 一起去买猫粮 [❤️]()\n', ''),
      'utf8'
    )
    const cancelled = p.cancel(created.task!.id)
    expect(cancelled.ok).toBe(true)
    expect(getTaskById(db, created.task!.id)?.state).toBe('cancelled')
  })

  it('改到另一天：删旧天的行、在新天追加', () => {
    writeNote(DAY)
    const other = '2026-11-03'
    writeNote(other)
    const p = port()
    const created = p.schedule({
      instruction: '一起去买猫粮',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    const next = new Date(2026, 10, 3, 9, 0, 0, 0).getTime()
    p.update({ id: created.task!.id, when: next })
    expect(note()).not.toContain('一起去买猫粮')
    expect(readFileSync(join(vaultDir, `${other}.md`), 'utf8')).toContain(
      '- [ ] 09:00 一起去买猫粮 [❤️]()'
    )
  })
})

describe('暂停 / 继续（设置抽屉）', () => {
  it('共建计划暂停：Obsidian 那一行收起；继续时写回来，且不重复', () => {
    writeNote(DAY)
    const p = port()
    const created = p.schedule({
      instruction: '一起去买猫粮',
      when: WHEN,
      repeat: '',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    expect(note()).toContain('- [ ] 19:30 一起去买猫粮')

    const paused = p.setState(created.task!.id, 'paused')
    expect(paused.ok).toBe(true)
    expect(paused.message).toContain('暂停了')
    expect(paused.task?.state).toBe('paused')
    expect(note()).not.toContain('一起去买猫粮')
    expect(getTaskById(db, created.task!.id)?.obsidian_state).toBe('pending')

    const resumed = p.setState(created.task!.id, 'active')
    expect(resumed.ok).toBe(true)
    expect(resumed.message).toContain('继续了')
    expect(resumed.task?.state).toBe('active')
    expect(note()).toContain('- [ ] 19:30 一起去买猫粮')
    // 收起来再写回去只留一行
    expect(note().match(/一起去买猫粮/gu)?.length).toBe(1)
    expect(getTaskById(db, created.task!.id)?.obsidian_state).toBe('synced')
  })

  it('自主任务暂停 / 继续不碰用户日记；重复操作如实说状态没变', () => {
    writeNote(DAY)
    const before = note()
    const p = port()
    const created = p.schedule({
      instruction: '自己查一下他睡没睡',
      when: WHEN,
      repeat: '',
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    const paused = p.setState(created.task!.id, 'paused')
    expect(paused.ok).toBe(true)
    expect(paused.task?.state).toBe('paused')
    expect(note()).toBe(before)

    const again = p.setState(created.task!.id, 'paused')
    expect(again.ok).toBe(true)
    expect(again.message).toContain('已经是暂停的')

    expect(p.setState(created.task!.id, 'active').task?.state).toBe('active')
    expect(note()).toBe(before)
  })

  it('不存在 / 已结束的任务不能暂停或继续', () => {
    writeNote(DAY)
    const p = port()
    const missing = p.setState(999, 'paused')
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('没有 #999')

    const created = p.schedule({
      instruction: '一次性的事',
      when: WHEN,
      repeat: '',
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    p.cancel(created.task!.id)
    const ended = p.setState(created.task!.id, 'paused')
    expect(ended.ok).toBe(false)
    expect(ended.message).toContain('已经结束了')
  })
})

describe('查与参数', () => {
  it('search 的四种视图直接透传（day 用当天那次的时间显示）', () => {
    writeNote(DAY)
    const p = port()
    p.schedule({
      instruction: '每天早上提醒他喝水',
      when: WHEN,
      repeat: 'daily',
      origin: 'user',
      delivery: 'auto',
      validUntil: null
    })
    const pending = p.search({ view: 'pending' })
    expect(pending.total).toBe(1)
    expect(pending.truncated).toBe(false)
    const day = p.search({ view: 'day', day: DAY })
    expect(day.tasks[0].when).toContain('19:30')
  })

  it('改一条不存在的任务：如实说没有，不假装成功', () => {
    const result = port().update({ id: 999, instruction: '随便' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有 #999')
    expect(result.task).toBeNull()
  })

  it('没有任务库（db 为 null）时抛错，由工具层转成可读失败', () => {
    const p = createTaskToolPort({ db: () => null })
    expect(() =>
      p.schedule({
        instruction: '记不下来',
        when: WHEN,
        repeat: '',
        origin: 'agent',
        delivery: 'auto',
        validUntil: null
      })
    ).toThrow()
  })
})

describe('重复规则：每周多选 / 每月多选', () => {
  it('每周一三五：落库是 weekly:1,3,5，回执说人话', () => {
    const result = port().schedule({
      instruction: '提醒他喝水',
      when: WHEN,
      repeat: 'weekly',
      weekdays: [5, 1, 3],
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('每周一、三、五')
    expect(result.task?.repeat).toBe('每周一、三、五')
    expect(getTaskById(db, result.task!.id)?.repeat).toBe('weekly:1,3,5')
  })

  it('每月 1、15 号：落库是 monthly:1,15；第一次到点归一到最近的所选日', () => {
    const result = port().schedule({
      instruction: '每月交房租',
      when: WHEN,
      repeat: 'monthly',
      monthDays: [15, 1],
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('每月 1、15 号')
    const stored = getTaskById(db, result.task!.id)
    expect(stored?.repeat).toBe('monthly:1,15')
    expect(stored?.next_due_at).toBe(new Date(2026, 10, 15, 19, 30, 0, 0).getTime())
  })

  it('不给列表：按第一次到点补出周几（周一 → weekly:1）', () => {
    const result = port().schedule({
      instruction: '每周提醒',
      when: WHEN,
      repeat: 'weekly',
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.message).toContain('每周一')
    expect(getTaskById(db, result.task!.id)?.repeat).toBe('weekly:1')
  })

  it('重复任务没有到点时间：如实拒绝，不落一条永远不响的行', () => {
    const result = port().schedule({
      instruction: '每天提醒',
      when: null,
      repeat: 'daily',
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('到点时间')
    expect(result.task).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM mem_tasks').get()).toEqual({ n: 0 })
  })

  it('只改周几（不给 repeat）：按现有 weekly 规则改；回执带新人话', () => {
    const p = port()
    const created = p.schedule({
      instruction: '提醒他喝水',
      when: WHEN,
      repeat: 'weekly',
      weekdays: [1, 3, 5],
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    const updated = p.update({ id: created.task!.id, weekdays: [2, 4] })
    expect(updated.ok).toBe(true)
    expect(updated.message).toContain('每周二、四')
    expect(getTaskById(db, created.task!.id)?.repeat).toBe('weekly:2,4')
  })

  it('只改几号（不给 repeat）：按现有 monthly 规则改', () => {
    const p = port()
    const created = p.schedule({
      instruction: '每月交房租',
      when: WHEN,
      repeat: 'monthly',
      monthDays: [15],
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    const updated = p.update({ id: created.task!.id, monthDays: [1, 20] })
    expect(updated.ok).toBe(true)
    expect(updated.message).toContain('每月 1、20 号')
    expect(getTaskById(db, created.task!.id)?.repeat).toBe('monthly:1,20')
  })

  it('非重复任务只给 weekdays：如实拒绝，不改行', () => {
    const p = port()
    const created = p.schedule({
      instruction: '一次性',
      when: WHEN,
      repeat: '',
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    const updated = p.update({ id: created.task!.id, weekdays: [1] })
    expect(updated.ok).toBe(false)
    expect(updated.message).toContain('不是重复任务')
    expect(getTaskById(db, created.task!.id)?.repeat).toBe('')
  })

  it('重复任务不能把到点时间清空：如实拒绝', () => {
    const p = port()
    const created = p.schedule({
      instruction: '每天提醒',
      when: WHEN,
      repeat: 'daily',
      origin: 'agent',
      delivery: 'auto',
      validUntil: null
    })
    const cleared = p.update({ id: created.task!.id, when: null })
    expect(cleared.ok).toBe(false)
    expect(cleared.message).toContain('不能把到点时间清掉')
    expect(getTaskById(db, created.task!.id)?.next_due_at).not.toBeNull()
  })
})
