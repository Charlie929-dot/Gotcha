/**
 * 个人记忆 · 日记写入（write.ts）
 *
 * 这组用例守的是「碰用户正文」那条底线：写进去的行要符合 §2.3 的格式，用户的旧行一个字节都不许动，
 * 冲突 / 缺文件 / 缺段落必须报结构化错误而不是猜着写；备份、BOM、CRLF 是原样保留的一部分。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DiaryWriteError, appendDiary, appendPlan, insertComment } from '../../src/memory/write'

const DAY = '2026-10-29'

/** 带 BOM + CRLF 的当天笔记：模板噪音、两段、导航行都在，跟真机一致 */
function fixture(): string {
  return [
    '---',
    '🌻日期🌻: 2026-10-29',
    '---',
    '',
    '# Tracking',
    '- [ ] 09:00-10:00 写周报',
    '',
    '# Diary',
    '- 08:40 今天早上有点困，昨晚没睡好。',
    '',
    '---',
    '<< [[2026-10-28]] | [[2026-10-30]] >>',
    ''
  ].join('\r\n')
}

let root = ''

function writeNote(text: string): { file: string; dir: string } {
  const dir = join(root, 'daily')
  const file = join(dir, `${DAY}.md`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `\uFEFF${text}`, 'utf8')
  return { file, dir }
}

function readText(file: string): string {
  return readFileSync(file, 'utf8')
}

function linesOf(file: string): string[] {
  return readText(file)
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof DiaryWriteError) return error.code
    throw error
  }
  throw new Error('预期抛错，但没抛')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotcha-mem-write-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('appendDiary', () => {
  it('顶层第一句 + 缩进后续句，落在 # Diary 段末尾、导航行之前', () => {
    const { file, dir } = writeNote(fixture())
    const before = linesOf(file)
    const result = appendDiary({
      dayKey: DAY,
      vaultDir: dir,
      text: '我先读了一遍你今天写的。\n早上确实有点困。',
      time: '23:30',
      now: new Date('2026-10-29T23:30:00').getTime()
    })
    expect(result.lines).toBe(2)
    expect(result.section).toBe('diary')
    expect(result.backup).toBeNull()

    const after = linesOf(file)
    expect(after).toContain('- 23:30 我先读了一遍你今天写的。 [❤️]()')
    expect(after).toContain('  - 早上确实有点困。 [❤️]()')
    // 旧行原样保留
    expect(after).toContain('- 08:40 今天早上有点困，昨晚没睡好。')
    // 落点：在旧日记之后、分隔线之前
    const block = after.indexOf('- 23:30 我先读了一遍你今天写的。 [❤️]()')
    expect(block).toBeGreaterThan(after.indexOf('- 08:40 今天早上有点困，昨晚没睡好。'))
    expect(block).toBeLessThan(after.lastIndexOf('---'))
    // 只多两行
    expect(after.length).toBe(before.length + 2)
  })

  it('保留 BOM 与 CRLF', () => {
    const { file, dir } = writeNote(fixture())
    appendDiary({ dayKey: DAY, vaultDir: dir, text: '晚安。', time: '23:31' })
    const raw = readText(file)
    expect(raw.startsWith('\uFEFF')).toBe(true)
    expect(raw.split('\n').length).toBe(raw.split('\r\n').length)
  })

  it('时间容忍 9:05 并规范成 09:05', () => {
    const { file, dir } = writeNote(fixture())
    appendDiary({ dayKey: DAY, vaultDir: dir, text: '补记一句。', time: '9:05' })
    expect(linesOf(file)).toContain('- 09:05 补记一句。 [❤️]()')
  })

  it('缺文件 / 缺 # Diary 段都报结构化错误，不建骨架', () => {
    const dir = join(root, 'daily')
    expect(codeOf(() => appendDiary({ dayKey: DAY, vaultDir: dir, text: '一句话' }))).toBe('missing-file')

    const blank = writeNote(['# Tracking', '- [ ] 写周报', '', '---', '<< [[2026-10-28]] | [[2026-10-30]] >>', ''].join('\n'))
    expect(codeOf(() => appendDiary({ dayKey: DAY, vaultDir: blank.dir, text: '一句话' }))).toBe('no-section')
  })

  it('时间格式不对 / 正文为空都拒绝', () => {
    const { dir } = writeNote(fixture())
    expect(codeOf(() => appendDiary({ dayKey: DAY, vaultDir: dir, text: '一句话', time: '25:00' }))).toBe('bad-time')
    expect(codeOf(() => appendDiary({ dayKey: DAY, vaultDir: dir, text: '  \n ' }))).toBe('empty-text')
    expect(codeOf(() => appendDiary({ dayKey: '2026/10/29', vaultDir: dir, text: '一句话' }))).toBe('bad-day')
  })
})

describe('appendPlan', () => {
  it('写进 # Tracking（在 # Diary 之前），格式带勾选框与时间段', () => {
    const { file, dir } = writeNote(fixture())
    const result = appendPlan({ dayKey: DAY, vaultDir: dir, text: '复盘这周', time: '14:00', end: '14:30' })
    expect(result.section).toBe('tracking')
    const lines = linesOf(file)
    expect(lines).toContain('- [ ] 14:00-14:30 复盘这周 [❤️]()')
    expect(lines.indexOf('- [ ] 14:00-14:30 复盘这周 [❤️]()')).toBeLessThan(lines.indexOf('# Diary'))
    // 已有计划不动
    expect(lines).toContain('- [ ] 09:00-10:00 写周报')
  })

  it('time 直接给时间段也认', () => {
    const { file, dir } = writeNote(fixture())
    appendPlan({ dayKey: DAY, vaultDir: dir, text: '取快递', time: '16:00-16:20' })
    expect(linesOf(file)).toContain('- [ ] 16:00-16:20 取快递 [❤️]()')
  })

  it('没有 # Tracking 段报 no-section', () => {
    const note = writeNote(['# Diary', '- 08:40 一句话', ''].join('\n'))
    expect(codeOf(() => appendPlan({ dayKey: DAY, vaultDir: note.dir, text: '计划' }))).toBe('no-section')
  })
})

describe('insertComment', () => {
  it('默认插在行尾，只加标记不动正文', () => {
    const { file, dir } = writeNote(fixture())
    const result = insertComment({
      dayKey: DAY,
      vaultDir: dir,
      line: '今天早上有点困',
      comment: '那就别硬撑，午休二十分钟？'
    })
    expect(result.lines).toBe(1)
    expect(linesOf(file)).toContain(
      '- 08:40 今天早上有点困，昨晚没睡好。 [❤️](那就别硬撑，午休二十分钟？)'
    )
  })

  it('给了锚点就插在锚点之后（中文标点前不加空格）', () => {
    const { file, dir } = writeNote(fixture())
    insertComment({
      dayKey: DAY,
      vaultDir: dir,
      line: '今天早上有点困',
      comment: '（昨晚睡太晚）',
      after: '今天早上有点困'
    })
    expect(linesOf(file)).toContain(
      '- 08:40 今天早上有点困 [❤️](（昨晚睡太晚）)，昨晚没睡好。'
    )
  })

  it('找不到 / 多命中都报错，不猜', () => {
    const { dir } = writeNote(`${fixture()}- 09:30 今天早上开会\n- 09:40 今天下午写文档\n`)
    expect(codeOf(() => insertComment({ dayKey: DAY, vaultDir: dir, line: '不存在的一句', comment: '嗯' }))).toBe(
      'line-not-found'
    )
    expect(codeOf(() => insertComment({ dayKey: DAY, vaultDir: dir, line: '今天', comment: '嗯' }))).toBe(
      'line-ambiguous'
    )
  })

  it('已评论过 / ta 自己写的行拒绝再评', () => {
    const { dir } = writeNote(`${fixture()}- 09:30 用户写的一行 [❤️](已经评过)\n- 09:40 ta 写的行 [❤️]()\n`)
    expect(codeOf(() => insertComment({ dayKey: DAY, vaultDir: dir, line: '用户写的一行', comment: '再评' }))).toBe(
      'already-commented'
    )
    expect(codeOf(() => insertComment({ dayKey: DAY, vaultDir: dir, line: 'ta 写的行', comment: '评' }))).toBe(
      'already-commented'
    )
  })

  it('锚点缺失 / 多次出现都报错', () => {
    const { dir } = writeNote(`${fixture()}- 09:30 重复 重复 的一句话\n`)
    expect(codeOf(() => insertComment({ dayKey: DAY, vaultDir: dir, line: '重复', comment: '嗯', after: '不存在' }))).toBe(
      'anchor-not-found'
    )
    expect(codeOf(() => insertComment({ dayKey: DAY, vaultDir: dir, line: '重复', comment: '嗯', after: '重复' }))).toBe(
      'anchor-ambiguous'
    )
  })
})

describe('备份 / 冲突', () => {
  it('写前备份原文件，文件名按天归档', () => {
    const { file, dir } = writeNote(fixture())
    const original = readText(file)
    const backupDir = join(root, 'backups')
    const result = appendDiary({ dayKey: DAY, vaultDir: dir, text: '晚安。', time: '23:32', backupDir })
    expect(result.backup).not.toBeNull()
    expect(result.backup!.startsWith(DAY)).toBe(true)
    const backed = readFileSync(join(backupDir, result.backup!), 'utf8')
    expect(backed).toBe(original)
  })

  it('每天最多留 20 份备份', () => {
    const { dir } = writeNote(fixture())
    const backupDir = join(root, 'backups')
    for (let index = 0; index < 23; index += 1) {
      appendDiary({
        dayKey: DAY,
        vaultDir: dir,
        text: `第 ${index} 句。`,
        time: '23:00',
        backupDir,
        now: new Date('2026-10-29T23:00:00').getTime() + index * 1000
      })
    }
    const backups = readdirSync(backupDir).filter((name) => name.startsWith(`${DAY}-`))
    expect(backups.length).toBe(20)
  })

  it('写之前文件被改过 → 重读重试，两边的改动都在', () => {
    const { file, dir } = writeNote(fixture())
    let injected = false
    const result = appendDiary({
      dayKey: DAY,
      vaultDir: dir,
      text: '我写的一句。',
      time: '23:33',
      onRead: () => {
        if (injected) return
        injected = true
        writeFileSync(file, `${readText(file)}- 09:50 用户在我读之后补的一句\n`, 'utf8')
        expect(statSync(file).size).toBeGreaterThan(0)
      }
    })
    expect(result.lines).toBe(1)
    const lines = linesOf(file)
    expect(lines).toContain('- 09:50 用户在我读之后补的一句')
    expect(lines).toContain('- 23:33 我写的一句。 [❤️]()')
  })

  it('一直改个不停 → conflict，不写坏文件', () => {
    const { file, dir } = writeNote(fixture())
    const before = readText(file)
    expect(
      codeOf(() =>
        appendDiary({
          dayKey: DAY,
          vaultDir: dir,
          text: '写不进去的一句。',
          time: '23:34',
          onRead: () => {
            writeFileSync(file, `${readText(file)}- 09:51 又改了一次\n`, 'utf8')
          }
        })
      )
    ).toBe('conflict')
    expect(readText(file)).toContain('- 09:51 又改了一次')
    expect(readText(file)).not.toContain('写不进去的一句')
    expect(readText(file).length).toBeGreaterThan(before.length)
  })
})
