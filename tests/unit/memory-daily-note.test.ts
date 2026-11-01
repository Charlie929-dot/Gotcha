/**
 * 缺当天笔记时自动创建（2026-11-01 拍板）
 *
 * 守的规矩：
 * 1. **只建不改**：文件已存在就一个字节都不动（返回 created=false）；
 * 2. 优先用用户自己的 `daily-notes.json` 模板：日期表达式能展开，`<%* %>` 逻辑块整段丢掉；
 * 3. 要 Templater 运行时 + 联网才算得出来的行（天气 / 一言）**整行跳过**，绝不把 `<% %>` 留在笔记里；
 * 4. 没有模板就写最简骨架，`# Tracking` / `# Diary` 两段齐全（计划同步与日记写入都要靠它定位）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureDailyNote, expandDailyTemplate, formatDailyStamp } from '../../src/memory/write'

const DAY = '2026-11-01'
const NOW = new Date(2026, 10, 1, 9, 30, 0, 0).getTime()

let root = ''
let vaultDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotcha-daily-note-'))
  vaultDir = join(root, 'daily')
  mkdirSync(vaultDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 按这台机器上的真实模板形状造一份（Templater 逻辑块 + 内联日期 + 算不出的变量） */
function writeTemplate(): string {
  const dir = join(root, '（Template）')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '日记模板.md')
  writeFileSync(
    file,
    [
      '<%*',
      'let date = tp.date.now("YYYY-MM-DD")',
      'await tp.file.rename(date)',
      'let 天气 = "未知"',
      '-%>',
      '---',
      '🌻日期🌻: <% tp.file.creation_date("YYYY-MM-DD") %>',
      '🌙星期🌙: <% tp.file.creation_date("dddd") %>',
      '⌚️时间⌚️: <% tp.file.creation_date("HH:mm") %>',
      '☁️天气☁️: <% 天气 %>',
      '---',
      '>[!quote] 一言',
      ' <% 一言 %>  —— 《<% 来源 %>》 · <% 作者 %>',
      '',
      '---',
      '# Tracking',
      '',
      '# Diary',
      '',
      '---',
      '<< [[<% tp.date.now("YYYY-MM-DD", -1) %>]] | [[<% tp.date.now("YYYY-MM-DD", 1) %>]] >>',
      ''
    ].join('\n'),
    'utf8'
  )
  mkdirSync(join(root, '.obsidian'), { recursive: true })
  writeFileSync(
    join(root, '.obsidian', 'daily-notes.json'),
    JSON.stringify({ folder: 'daily', template: '（Template）/日记模板' }),
    'utf8'
  )
  return file
}

function noteFile(day = DAY): string {
  return join(vaultDir, `${day}.md`)
}

describe('日期格式', () => {
  it('常见记号都换成本地时间', () => {
    expect(formatDailyStamp(NOW, 'YYYY-MM-DD')).toBe('2026-11-01')
    expect(formatDailyStamp(NOW, 'dddd')).toBe('星期日')
    expect(formatDailyStamp(NOW, 'HH:mm')).toBe('09:30')
    expect(formatDailyStamp(NOW, 'YYYY年MM月DD日')).toBe('2026年11月01日')
  })
})

describe('模板展开', () => {
  it('逻辑块整段去掉、日期表达式展开、算不出来的行跳过', () => {
    const template = readFileSync(writeTemplate(), 'utf8')
    const { lines, skipped } = expandDailyTemplate(template, DAY, NOW)
    const text = lines.join('\n')
    expect(text).not.toContain('<%')
    expect(text).not.toContain('tp.file.rename')
    expect(text).toContain('🌻日期🌻: 2026-11-01')
    expect(text).toContain('🌙星期🌙: 星期日')
    expect(text).toContain('⌚️时间⌚️: 09:30')
    // 天气 / 一言这几行要 Templater 运行时，自动创建时跳过（不让半截变量进笔记）
    expect(text).not.toContain('☁️天气☁️')
    expect(text).not.toContain('[!quote] 一言')
    expect(skipped).toBeGreaterThan(0)
    // 导航行是内联表达式，能算出来
    expect(text).toContain('<< [[2026-10-31]] | [[2026-11-02]] >>')
    expect(text).toContain('# Tracking')
    expect(text).toContain('# Diary')
  })

  it('没有 Templater 的纯 Obsidian 模板原样保留（含 {{date}} 之外的内容）', () => {
    const { lines, skipped } = expandDailyTemplate(
      ['# Tracking', '- [ ] 读一会儿书', '', '# Diary', ''].join('\n'),
      DAY,
      NOW
    )
    expect(skipped).toBe(0)
    expect(lines).toContain('- [ ] 读一会儿书')
  })
})

describe('ensureDailyNote', () => {
  it('按 daily-notes.json 的模板建（不需要手动告诉模板路径）', () => {
    writeTemplate()
    const result = ensureDailyNote({ dayKey: DAY, vaultDir, now: NOW })
    expect(result.created).toBe(true)
    expect(result.template).toContain('日记模板')
    const text = readFileSync(noteFile(), 'utf8')
    expect(text).toContain('🌻日期🌻: 2026-11-01')
    expect(text).toContain('# Tracking')
    expect(text).toContain('# Diary')
    expect(text).not.toContain('<%')
  })

  it('没有模板：写最简骨架（日期在 frontmatter、两段齐全、带前后一天导航）', () => {
    const result = ensureDailyNote({ dayKey: DAY, vaultDir, now: NOW })
    expect(result.created).toBe(true)
    expect(result.template).toBeNull()
    const text = readFileSync(noteFile(), 'utf8')
    expect(text).toContain('🌻日期🌻: 2026-11-01')
    expect(text).toContain('# Tracking')
    expect(text).toContain('# Diary')
    expect(text).toContain('[[2026-10-31]] | [[2026-11-02]]')
  })

  it('文件已存在：一个字节都不动', () => {
    mkdirSync(vaultDir, { recursive: true })
    const original = 'user 自己写的，别动\n'
    writeFileSync(noteFile(), original, 'utf8')
    const result = ensureDailyNote({ dayKey: DAY, vaultDir, now: NOW })
    expect(result.created).toBe(false)
    expect(readFileSync(noteFile(), 'utf8')).toBe(original)
  })

  it('模板缺段也补齐（保证计划同步有落点）', () => {
    const dir = join(root, '（Template）')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, '只有日记.md')
    writeFileSync(file, ['# Diary', ''].join('\n'), 'utf8')
    const result = ensureDailyNote({
      dayKey: DAY,
      vaultDir,
      now: NOW,
      templatePath: file
    })
    expect(result.created).toBe(true)
    const text = readFileSync(noteFile(), 'utf8')
    expect(text).toContain('# Diary')
    expect(text).toContain('# Tracking')
  })

  it('跨年 / 跨月的骨架导航算对（2026-12-31 → 2027-01-01）', () => {
    ensureDailyNote({ dayKey: '2026-12-31', vaultDir, now: NOW })
    const text = readFileSync(noteFile('2026-12-31'), 'utf8')
    expect(text).toContain('[[2026-12-30]] | [[2027-01-01]]')
  })
})
