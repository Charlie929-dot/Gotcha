/**
 * 成长档案 · 主进程接线（src/main/growth.ts）
 *
 * 守的纪律：
 * 1. 文件落在记忆仓的 growth/ 目录；没有文件时列表给一句人话，不顺手建目录；
 * 2. write 成功才落盘；失败（空 / 超长）如实回，不写半篇；
 * 3. 同一天 / 同一周再写是覆盖（重试不产生两份）；
 * 4. /growth 列表与 /growth <键> 走同一份文件；hasEntry 判断这周周记写没写。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createGrowthStore } from '../../src/main/growth'
import { isoWeekKey } from '../../src/memory/growth'

const NOW = new Date(2026, 10, 1, 23, 30, 0, 0).getTime()
const TODAY = '2026-11-01'
const WEEK = isoWeekKey(NOW)

describe('createGrowthStore', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gotcha-growth-store-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('没有文件：列表给人话，不建目录', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    expect(store.dir).toBe(join(root, 'growth'))
    expect(store.list()).toContain('还是空的')
    expect(existsSync(join(root, 'growth'))).toBe(false)
  })

  it('写日记：落在 growth/daily/当天.md，回执带路径与字数', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    const result = store.write({ kind: 'daily', content: '今天在改自调用。' })
    expect(result).toMatchObject({ ok: true, kind: 'daily', period: TODAY, chars: 8 })
    expect(result.message).toContain(join('growth', 'daily', `${TODAY}.md`))
    const file = readFileSync(join(root, 'growth', 'daily', `${TODAY}.md`), 'utf8')
    expect(file).toContain('今天在改自调用。')
    expect(store.hasEntry('daily', NOW)).toBe(true)
  })

  it('写周记：按 ISO 周落盘', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    const result = store.write({ kind: 'weekly', content: '这一周写了自调用第三阶段。' })
    expect(result).toMatchObject({ ok: true, kind: 'weekly', period: WEEK })
    expect(store.hasEntry('weekly', NOW)).toBe(true)
    expect(store.hasEntry('daily', NOW)).toBe(false)
  })

  it('写月末总结 / 年终总结：落在 growth/monthly/<YYYY-MM> 与 growth/yearly/<YYYY>', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    const monthly = store.write({ kind: 'monthly', content: '这个月把第三层做完了。' })
    expect(monthly).toMatchObject({ ok: true, kind: 'monthly', period: '2026-11' })
    expect(monthly.message).toContain(join('growth', 'monthly', '2026-11.md'))
    expect(store.hasEntry('monthly', NOW)).toBe(true)

    const yearly = store.write({ kind: 'yearly', content: '这一年从头到尾。' })
    expect(yearly).toMatchObject({ ok: true, kind: 'yearly', period: '2026' })
    expect(yearly.message).toContain(join('growth', 'yearly', '2026.md'))
    expect(store.hasEntry('yearly', NOW)).toBe(true)
    // 互不串台：写了年终不代表写过月末
    expect(store.hasEntry('weekly', NOW)).toBe(false)
  })

  it('空 / 超长：不落盘，旧文件不动', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    store.write({ kind: 'daily', content: '原来的' })
    const before = readFileSync(join(root, 'growth', 'daily', `${TODAY}.md`), 'utf8')
    const empty = store.write({ kind: 'daily', content: '   ' })
    expect(empty.ok).toBe(false)
    expect(empty.message).toContain('空的')
    expect(store.write({ kind: 'daily', content: 'a'.repeat(2000) }).ok).toBe(false)
    expect(readFileSync(join(root, 'growth', 'daily', `${TODAY}.md`), 'utf8')).toBe(before)
  })

  it('同一天再写是覆盖', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    store.write({ kind: 'daily', content: '第一版' })
    const second = store.write({ kind: 'daily', content: '第二版' })
    expect(second.ok).toBe(true)
    const file = readFileSync(join(root, 'growth', 'daily', `${TODAY}.md`), 'utf8')
    expect(file).not.toContain('第一版')
    expect(file.match(/第二版/gu)).toHaveLength(1)
  })

  it('list / show：列表带标题，show 给全文与路径，缺篇 / 坏键给人话', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    store.write({ kind: 'daily', content: '今天的日记' })
    expect(store.list()).toContain(`${TODAY}（周日）`)

    const text = store.show(TODAY)
    expect(text).toContain('今天的日记')
    expect(text).toContain(join('growth', 'daily', `${TODAY}.md`))

    expect(store.show('2026-10-30')).toContain('还没有')
    expect(store.show('不是日期')).toContain('不认识的')
    expect(store.show('')).toContain('用法')
  })

  it('show 认得四层键（不把 2026-11 当日期、不把 2026 当月份）', () => {
    const store = createGrowthStore({ root, now: () => NOW })
    store.write({ kind: 'daily', content: '今天的日记' })
    store.write({ kind: 'monthly', content: '这个月的月末总结' })
    store.write({ kind: 'yearly', content: '这一年的年终总结' })

    expect(store.show('2026-11')).toContain('这个月的月末总结')
    expect(store.show('2026-11')).toContain(join('growth', 'monthly', '2026-11.md'))
    expect(store.show('2026')).toContain('这一年的年终总结')
    expect(store.show('2026')).toContain(join('growth', 'yearly', '2026.md'))
    // 越界 / 形状不对：说不认识，不猜成别的层
    expect(store.show('2026-13')).toContain('不认识的')
    expect(store.show('2026-11-1')).toContain('不认识的')
    expect(store.show('2025-11')).toContain('还没有')
  })
})
