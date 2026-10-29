/**
 * 个人记忆 · 日记解析（vault.ts）
 *
 * 重点不是「能解析正常文件」，而是三件会真的污染记忆的事：
 * 1）模板文件（Templater `<%* %>`）不能被当成日记；
 * 2）「一言 / 提醒 / 导航行」这些模板噪音不能变成记忆条目；
 * 3）`- 01:19` 的时刻要挂到当天，标签 / 双链要抽出来。
 */

import { describe, expect, it } from 'vitest'

import { cleanItemText, dayKeyOf, dayStartTs, parseDailyNote } from '../../src/memory/vault'

const TEMPLATE = `---
🌻日期🌻: <% tp.file.creation_date("YYYY-MM-DD") %>
🌙星期🌙: <% tp.file.creation_date("dddd") %>
---
<%*
let date = tp.date.now("YYYY-MM-DD")
await tp.file.rename(date)
-%>
# Tracking

# Diary

---
<< [[2026-10-22]] | [[2026-10-24]] >>
`

const NOTE = `---
🌻日期🌻: 2026-09-29
🌙星期🌙: 星期二
⌚️时间⌚️: 00:29
---
>[!quote] 一言
 要保持希望每天清晨太阳升起。  —— 《自己》 · 佚名

> [!warning]
>- **"完成比完美更重要"**

---
# Tracking
- [ ] 技术探索
	- [x] ai工作台,cherry studio
	- [ ] cpu资源管理工具
- [ ] 学习规划
	- [ ] 六级计划

# Diary
- 01:19
	- 昨天参加国家奖学金评选，重点观察了肖梦婷的讲解
	> 她把自己擅长的表达发挥到极致 #观察 #表达
	> 她的稿子[[肖梦婷]]是夜里一遍遍打磨的
- 研究ai使用
	ai 聚合网关 [[openrouter]] 很不错

---
<< [[2026-09-28]] | [[2026-09-30]] >>
`

describe('parseDailyNote', () => {
  it('Templater 模板整份跳过（不当成日记）', () => {
    expect(parseDailyNote('2026-10-23.md', TEMPLATE)).toBeNull()
  })

  it('模板噪音（一言 / 提醒 / 导航 / frontmatter）不进记忆', () => {
    const parsed = parseDailyNote('2026-09-29.md', NOTE)
    expect(parsed).not.toBeNull()
    const texts = parsed!.items.map((item) => item.text)
    expect(texts.some((text) => text.includes('保持希望'))).toBe(false)
    expect(texts.some((text) => text.includes('完成比完美更重要'))).toBe(false)
    expect(texts.some((text) => text.includes('<<'))).toBe(false)
    expect(texts.some((text) => text.includes('🌻日期'))).toBe(false)
  })

  it('待办：顶层与缩进勾选框各自一条，带完成态', () => {
    const parsed = parseDailyNote('2026-09-29.md', NOTE)!
    const tasks = parsed.items.filter((item) => item.kind === 'task')
    const texts = tasks.map((task) => task.text)
    expect(texts).toContain('技术探索')
    expect(texts).toContain('ai工作台,cherry studio')
    expect(texts).toContain('cpu资源管理工具')
    expect(texts).toContain('六级计划')
    expect(tasks.find((task) => task.text === 'ai工作台,cherry studio')?.done).toBe(true)
    expect(tasks.find((task) => task.text === 'cpu资源管理工具')?.done).toBe(false)
  })

  it('日记块：`- HH:mm` 解出时刻，续行合并成一条，抽标签与双链', () => {
    const parsed = parseDailyNote('2026-09-29.md', NOTE)!
    const diary = parsed.items.filter((item) => item.kind === 'diary')
    expect(diary).toHaveLength(2)

    const first = diary[0]
    expect(first.text).toContain('昨天参加国家奖学金评选')
    expect(first.text).toContain('一遍遍打磨')
    // 09-29 01:19 本地时间
    expect(first.ts).toBe(dayStartTs('2026-09-29')! + (1 * 60 + 19) * 60_000)
    expect(first.tags).toEqual(expect.arrayContaining(['观察', '表达']))
    expect(first.refs).toEqual(expect.arrayContaining(['肖梦婷']))

    const second = diary[1]
    expect(second.ts).toBeNull()
    expect(second.refs).toContain('openrouter')
  })

  it('文件名里的日期优先于 frontmatter', () => {
    const parsed = parseDailyNote('2026-10-01.md', NOTE)
    expect(parsed!.dayKey).toBe('2026-10-01')
  })

  it('没有日期 / 没有有效条目 → null（调用方跳过，不算错）', () => {
    expect(parseDailyNote('notes.md', '# Diary\n- 一句话\n')).toBeNull()
    expect(parseDailyNote('2026-10-28.md', '# Diary\n\n# Tracking\n')).toBeNull()
  })

  it('高亮颜色值（#[FF5582A6]）不算标签', () => {
    const parsed = parseDailyNote('2026-10-01.md', '# Diary\n- 一句话 #[FF5582A6] 高亮 #思考\n')!
    expect(parsed.items[0].tags).toEqual(['思考'])
  })

  it('同一天重复粘贴的同一条只留一份', () => {
    const duplicated = NOTE.replace(
      '- 研究ai使用\n\tai 聚合网关 [[openrouter]] 很不错',
      '- 研究ai使用\n\tai 聚合网关 [[openrouter]] 很不错\n- 研究ai使用\n\tai 聚合网关 [[openrouter]] 很不错'
    )
    const parsed = parseDailyNote('2026-09-29.md', duplicated)!
    expect(parsed.items.filter((item) => item.text.startsWith('研究ai使用'))).toHaveLength(1)
  })
})

describe('cleanItemText / 日期工具', () => {
  it('清洗：去勾选框、引用符、行内代码，折叠空白', () => {
    expect(cleanItemText('- [x] 看完 `tsconfig`  的说明')).toBe('看完 tsconfig 的说明')
    expect(cleanItemText('> 一段引用\n> 第二行')).toBe('一段引用 第二行')
  })

  it('dayStartTs / dayKeyOf 用本地时区，往返一致', () => {
    const ts = dayStartTs('2026-09-29')!
    expect(dayKeyOf(ts)).toBe('2026-09-29')
    expect(dayStartTs('not-a-day')).toBeNull()
    expect(dayStartTs('2026-13-40')).toBeNull()
  })
})
