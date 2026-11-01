/**
 * 任务工具执行体：共建计划 ↔ Obsidian 计划区（自调用 v0.2 §4.1）
 *
 * 守两条底线：
 * 1. **回执只认记录**：文案里的事实（id / 时间 / 同步状态）必须能对上库里的行与磁盘上的行；
 * 2. **失败不粉饰**：当天笔记没有 `# Tracking` 段时，计划照样落库，但回执要明说没同步上，
 *    绝不出现「已写进 Obsidian」这种话。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
