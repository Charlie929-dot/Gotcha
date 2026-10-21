import { describe, expect, it } from 'vitest'
import {
  dayRange,
  formatDate,
  formatTime,
  groupByDay,
  startOfDay,
  summary
} from '../../src/renderer/timeline'
import type { EventRow } from '../../src/db'

function row(ts: number, id: number, ocrText: string | null = null): EventRow {
  return {
    id,
    ts,
    app: 'notepad',
    window_title: '窗口',
    ocr_text: ocrText,
    shot_path: null,
    intent_json: null,
    sensitive: 0
  }
}

describe('timeline 视图纯逻辑', () => {
  it('startOfDay / dayRange 覆盖本地一整天（闭区间）', () => {
    const ts = new Date(2026, 9, 21, 15, 30, 12).getTime()
    const start = startOfDay(ts)
    expect(new Date(start)).toEqual(new Date(2026, 9, 21, 0, 0, 0, 0))

    const { from, to } = dayRange(ts)
    expect(from).toBe(start)
    expect(to).toBe(new Date(2026, 9, 22, 0, 0, 0, 0).getTime() - 1)
  })

  it('formatTime 输出 HH:mm', () => {
    expect(formatTime(new Date(2026, 9, 21, 9, 5).getTime())).toBe('09:05')
    expect(formatTime(new Date(2026, 9, 21, 23, 59).getTime())).toBe('23:59')
  })

  it('formatDate 带日期与星期', () => {
    const ts = new Date(2026, 9, 21).getTime()
    const text = formatDate(ts)
    expect(text.startsWith('2026-10-21 ')).toBe(true)
    expect(text).toMatch(/(周一|周二|周三|周四|周五|周六|周日)$/)
  })

  it('summary 压缩空白并截断到 80 字 + 省略号', () => {
    expect(summary(null)).toBe('')
    expect(summary('  项目\n计划   待办  ')).toBe('项目 计划 待办')
    const long = summary('x'.repeat(120))
    expect(long.length).toBe(81)
    expect(long.endsWith('…')).toBe(true)
  })

  it('groupByDay 按本地日期分组', () => {
    const day1 = new Date(2026, 9, 20, 23, 0).getTime()
    const day2 = new Date(2026, 9, 21, 1, 0).getTime()
    const groups = groupByDay([row(day1, 1), row(day1 + 1000, 2), row(day2, 3)])
    expect(groups).toHaveLength(2)
    expect(groups[0].date).toBe('2026-10-20')
    expect(groups[0].rows).toHaveLength(2)
    expect(groups[1].date).toBe('2026-10-21')
    expect(groups[1].rows[0].id).toBe(3)
  })
})
