/**
 * 成长档案 · 文件层（src/memory/growth.ts）
 *
 * 守的纪律（自调用 v0.2 §8 / §12.3）：
 * 1. 键是本地日 / ISO 周；跨年按 ISO 归属（12-31 可能属于下一年的第 1 周）；
 * 2. 同一天 / 同一周只有一篇：重写是覆盖，不是追加（重试不会写出两份）；
 * 3. 有界：空内容 / 超长如实拒绝，不静默截断；被拒绝时旧文件一个字节不动；
 * 4. 只写记忆仓自己的 growth/ 目录；目录不存在就建。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  GROWTH_DAILY_MAX_CHARS,
  checkGrowthBody,
  emptyGrowthText,
  growthEntryText,
  growthFilePath,
  growthKeyOf,
  growthListText,
  growthTitle,
  isoWeekKey,
  isoWeekOf,
  isoWeekRange,
  listGrowthKeys,
  localDayKey,
  normalizeGrowthBody,
  parseGrowthFile,
  readGrowthEntry,
  serializeGrowthFile,
  writeGrowthEntry
} from '../../src/memory/growth'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotcha-growth-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('时间键', () => {
  it('本地日', () => {
    expect(localDayKey(new Date(2026, 10, 1, 23, 30).getTime())).toBe('2026-11-01')
  })

  it('ISO 周：周日属于同一周，周一换周', () => {
    expect(isoWeekRange(new Date(2026, 10, 1).getTime())).toEqual({
      start: '2026-10-26',
      end: '2026-11-01'
    })
    expect(isoWeekKey(new Date(2026, 10, 1).getTime())).toBe(isoWeekKey(new Date(2026, 9, 26).getTime()))
    expect(isoWeekKey(new Date(2026, 10, 2).getTime())).not.toBe(
      isoWeekKey(new Date(2026, 9, 26).getTime())
    )
  })

  it('ISO 跨年归属：12-29 属于下一年第 1 周；2026 有第 53 周', () => {
    expect(isoWeekKey(new Date(2025, 11, 29).getTime())).toBe('2026-W01')
    expect(isoWeekKey(new Date(2026, 11, 31).getTime())).toBe('2026-W53')
    expect(isoWeekOf(new Date(2026, 0, 1).getTime())).toEqual({ year: 2026, week: 1 })
  })

  it('写哪一篇：日记按本地日，周记按 ISO 周', () => {
    const at = new Date(2026, 10, 1, 23, 30).getTime()
    expect(growthKeyOf('daily', at)).toBe('2026-11-01')
    expect(growthKeyOf('weekly', at)).toMatch(/^2026-W\d{2}$/u)
  })

  it('标题是人话', () => {
    expect(growthTitle('daily', '2026-11-01')).toBe('2026-11-01（周日）')
    expect(growthTitle('weekly', '2026-W44')).toContain('2026 第 44 周')
    expect(growthTitle('weekly', '2026-W44')).toContain('~')
  })
})

describe('正文归一与有界', () => {
  it('去掉重复的一级标题、压掉多余空行、行尾空白', () => {
    expect(normalizeGrowthBody('\n\n# 2026-11-01（周日）\n\n今天   \n\n\n\n写了点东西  \n')).toBe(
      '今天\n\n写了点东西'
    )
  })

  it('空内容拒；超长拒（不截断）', () => {
    expect(checkGrowthBody('daily', '   \n\n  ').ok).toBe(false)
    const tooLong = checkGrowthBody('daily', 'a'.repeat(GROWTH_DAILY_MAX_CHARS + 1))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.message).toContain('最多')
  })
})

describe('解析 / 序列化', () => {
  it('往返：标题 + 正文', () => {
    const text = serializeGrowthFile('daily', '2026-11-01', '今天做了三件事。')
    expect(text.startsWith('# 2026-11-01（周日）')).toBe(true)
    expect(parseGrowthFile(text)).toEqual({ title: '2026-11-01（周日）', body: '今天做了三件事。' })
  })

  it('没有标题行 = 全是正文（人改坏了也读得出来）', () => {
    expect(parseGrowthFile('随便写的一句\n第二行')).toEqual({
      title: '',
      body: '随便写的一句\n第二行'
    })
  })
})

describe('写 / 读 / 列', () => {
  it('目录不存在就建；写完读得回来', () => {
    const outcome = writeGrowthEntry(root, 'daily', '2026-11-01', '今天在改自调用。')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.replaced).toBe(false)
    expect(outcome.entry.path).toBe(join('growth', 'daily', '2026-11-01.md'))
    const entry = readGrowthEntry(root, 'daily', '2026-11-01')
    expect(entry?.body).toBe('今天在改自调用。')
  })

  it('同一天再写一次是覆盖（不是追加）', () => {
    writeGrowthEntry(root, 'daily', '2026-11-01', '第一版')
    const second = writeGrowthEntry(root, 'daily', '2026-11-01', '第二版')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.replaced).toBe(true)
    const text = readFileSync(growthFilePath(root, 'daily', '2026-11-01'), 'utf8')
    expect(text).not.toContain('第一版')
    expect(text.match(/第二版/gu)).toHaveLength(1)
  })

  it('被拒绝时旧文件一个字节不动', () => {
    writeGrowthEntry(root, 'daily', '2026-11-01', '原来的内容')
    const before = readFileSync(growthFilePath(root, 'daily', '2026-11-01'), 'utf8')
    expect(writeGrowthEntry(root, 'daily', '2026-11-01', '  ').ok).toBe(false)
    expect(readFileSync(growthFilePath(root, 'daily', '2026-11-01'), 'utf8')).toBe(before)
  })

  it('不认识的键 / 不存在的篇', () => {
    expect(writeGrowthEntry(root, 'daily', '2026-13-40', 'x').ok).toBe(false)
    expect(writeGrowthEntry(root, 'weekly', '2026-44', 'x').ok).toBe(false)
    expect(readGrowthEntry(root, 'daily', '2026-11-01')).toBeNull()
    expect(readGrowthEntry(root, 'daily', '不是日期')).toBeNull()
  })

  it('列键：新到旧，忽略不认识的文件；目录不存在 = 空', () => {
    expect(listGrowthKeys(root, 'daily')).toEqual([])
    writeGrowthEntry(root, 'daily', '2026-10-31', 'a')
    writeGrowthEntry(root, 'daily', '2026-11-01', 'b')
    writeGrowthEntry(root, 'weekly', '2026-W44', 'c')
    mkdirSync(join(root, 'growth', 'daily'), { recursive: true })
    writeFileSync(join(root, 'growth', 'daily', 'notes.md'), 'x', 'utf8')
    expect(listGrowthKeys(root, 'daily')).toEqual(['2026-11-01', '2026-10-31'])
    expect(listGrowthKeys(root, 'weekly')).toEqual(['2026-W44'])
  })
})

describe('/growth 文本', () => {
  it('空档案给一句人话', () => {
    expect(growthListText(root)).toBe(emptyGrowthText())
  })

  it('列出最近几篇（标题 + 字数），并给看全文的用法', () => {
    writeGrowthEntry(root, 'daily', '2026-11-01', '今天的日记')
    writeGrowthEntry(root, 'weekly', '2026-W44', '这一周')
    const text = growthListText(root)
    expect(text).toContain('2026-11-01（周日）')
    expect(text).toContain('5 字')
    expect(text).toContain('2026 第 44 周')
    expect(text).toContain('/growth 2026-11-01')
  })

  it('全文带路径', () => {
    writeGrowthEntry(root, 'daily', '2026-11-01', '今天的日记')
    const entry = readGrowthEntry(root, 'daily', '2026-11-01')
    expect(entry).not.toBeNull()
    if (entry === null) return
    expect(growthEntryText(entry)).toContain('今天的日记')
    expect(growthEntryText(entry)).toContain(join('growth', 'daily', '2026-11-01.md'))
  })
})
