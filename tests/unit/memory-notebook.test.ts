/**
 * 小本本 · 文件层（src/memory/notebook.ts）
 *
 * 守的纪律（自调用 v0.2 §7 / §12.2）：
 * 1. 代码写的格式能原样读回；用户手写的 `- 一句话` 也能收进来（补编号，不丢）；
 * 2. 有界：单条太长 / 一栏满了 / 全本超字数都如实拒绝，不静默丢旧条目；
 * 3. 改编号不变、位置不变；纠正旧理解用 revise，放下用 remove；
 * 4. 文件不存在 = 空本子（不建文件）；写一次就落盘，四个分区永远在。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addNotebookEntry,
  emptyNotebookText,
  normalizeNotebookText,
  notebookListText,
  parseNotebook,
  readNotebookFile,
  removeNotebookEntry,
  reviseNotebookEntry,
  serializeNotebook,
  writeNotebookFile,
  type Notebook
} from '../../src/memory/notebook'

const TODAY = '2026-11-01'

function entry(id: string, section: Notebook['entries'][number]['section'], text: string): Notebook['entries'][number] {
  return { id, section, text, at: TODAY }
}

describe('解析 / 序列化', () => {
  it('空文件 / 只有标题 = 空本子', () => {
    expect(parseNotebook('').entries).toEqual([])
    expect(parseNotebook('# 小本本\n\n## 关于你\n').entries).toEqual([])
  })

  it('代码格式带编号与日期；手写行补编号，勾选框不当条目', () => {
    const text = [
      '# 小本本',
      '',
      '## 关于你',
      '- n2 · 2026-10-30 · 喜欢周深，现场版更有感觉',
      '- 也爱在夜里写东西',
      '- [ ] 这不是小本本条目',
      '',
      '## 放在外面的行',
      '- n9 · 2026-10-30 · 不认识的标题下面不算',
      '## 我们之间',
      '- n1 · 2026-10-31 · 答应过不连续追问'
    ].join('\n')
    const notebook = parseNotebook(text, TODAY)
    expect(notebook.entries.map((item) => item.id)).toEqual(['n2', 'n10', 'n9', 'n1'])
    expect(notebook.entries[1]).toEqual({
      id: 'n10',
      section: 'about_you',
      text: '也爱在夜里写东西',
      at: TODAY
    })
    expect(notebook.entries[2]?.section).toBe('放在外面的行')
    expect(notebook.entries[3]?.text).toBe('答应过不连续追问')
  })

  it('序列化 → 再解析：内容一致，四个分区标题都在', () => {
    const notebook: Notebook = {
      entries: [
        entry('n1', 'about_you', '喜欢周深'),
        entry('n2', 'recent_you', '这周在赶作业'),
        entry('n3', 'between_us', '约好睡前说一声'),
        entry('n4', 'reminders', '别连续追问')
      ]
    }
    const text = serializeNotebook(notebook)
    for (const heading of ['## 关于你', '## 最近的你', '## 我们之间', '## 我给自己的提醒']) {
      expect(text).toContain(heading)
    }
    expect(parseNotebook(text, TODAY)).toEqual(notebook)
  })

  it('正文归一：折叠空白、去掉开头的列表符', () => {
    expect(normalizeNotebookText('  -  喜欢\n  周深  ')).toBe('喜欢\n  周深')
  })
})

describe('增 / 改 / 删', () => {
  it('add：编号递增、日期是当天', () => {
    const first = addNotebookEntry({ entries: [] }, 'about_you', '喜欢周深', TODAY)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.entry).toEqual({ id: 'n1', section: 'about_you', text: '喜欢周深', at: TODAY })
    const second = addNotebookEntry(first.notebook, 'about_you', '不喜欢被连续追问', TODAY)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.entry.id).toBe('n2')
    expect(second.total).toBe(2)
  })

  it('add：重复的文字也各自保留，编号不同', () => {
    const first = addNotebookEntry({ entries: [] }, '花', '今天开花了', TODAY)
    if (!first.ok) throw new Error(first.message)
    const second = addNotebookEntry(first.notebook, '花', '今天开花了', TODAY)
    expect(second).toMatchObject({ ok: true, total: 2, entry: { id: 'n2' } })
  })

  it('add：长文与段落完整往返，空内容仍是无效参数', () => {
    const text = '字'.repeat(8000) + '\n\n第二段\n  有缩进'
    const added = addNotebookEntry({ entries: [] }, '我的梦', text, TODAY)
    expect(added).toMatchObject({ ok: true, entry: { text } })
    if (!added.ok) throw new Error(added.message)
    expect(parseNotebook(serializeNotebook(added.notebook), TODAY)).toEqual(added.notebook)
    expect(addNotebookEntry({ entries: [] }, '我的梦', '   ', TODAY).ok).toBe(false)
  })

  it('add：同一栏目超过原五条限制，没有条数或全本字数上限', () => {
    let notebook: Notebook = { entries: [] }
    for (let index = 0; index < 30; index += 1) {
      const added = addNotebookEntry(notebook, '看云', `第${index}天 ` + '云'.repeat(200), TODAY)
      if (!added.ok) throw new Error(added.message)
      notebook = added.notebook
    }
    expect(notebook.entries).toHaveLength(30)
    expect(parseNotebook(serializeNotebook(notebook), TODAY)).toEqual(notebook)
  })

  it('新本子没有预设栏目，自取栏目名可以往返', () => {
    expect(serializeNotebook({ entries: [] })).toBe('# 小本本\n')
    const added = addNotebookEntry({ entries: [] }, '一些乱七八糟的想法', '很长的名字也不截断', TODAY)
    if (!added.ok) throw new Error(added.message)
    expect(parseNotebook(serializeNotebook(added.notebook), TODAY)).toEqual(added.notebook)
    expect(serializeNotebook(added.notebook)).not.toContain('关于你')
  })

  it('revise：编号不变、位置不变、日期更新', () => {
    let notebook: Notebook = {
      entries: [entry('n1', 'about_you', '喜欢周深'), entry('n2', 'about_you', '爱熬夜')]
    }
    const revised = reviseNotebookEntry(notebook, 'n2', '最近在调作息，想早睡', '2026-11-02')
    expect(revised.ok).toBe(true)
    if (!revised.ok) return
    notebook = revised.notebook
    expect(notebook.entries.map((item) => item.id)).toEqual(['n1', 'n2'])
    expect(notebook.entries[1]).toEqual({
      id: 'n2',
      section: 'about_you',
      text: '最近在调作息，想早睡',
      at: '2026-11-02'
    })
  })

  it('revise：不存在的编号拒绝，重复内容仍能写入', () => {
    const notebook: Notebook = {
      entries: [entry('n1', 'about_you', '喜欢周深'), entry('n2', 'about_you', '爱熬夜')]
    }
    const missing = reviseNotebookEntry(notebook, 'n9', '随便', TODAY)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.message).toContain('n9')
    const duplicate = reviseNotebookEntry(notebook, 'n2', '喜欢周深', TODAY)
    expect(duplicate).toMatchObject({ ok: true, entry: { id: 'n2', text: '喜欢周深' } })
  })

  it('remove：删掉一条，其余不动', () => {
    const notebook: Notebook = {
      entries: [entry('n1', 'about_you', '喜欢周深'), entry('n2', 'between_us', '约好睡前说一声')]
    }
    const removed = removeNotebookEntry(notebook, 'n1')
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.notebook.entries.map((item) => item.id)).toEqual(['n2'])
    expect(removed.total).toBe(1)
    expect(removed.entry.id).toBe('n1')
    const missing = removeNotebookEntry(notebook, 'n9')
    expect(missing.ok).toBe(false)
  })
})

describe('文件读写 / 列表', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gotcha-notebook-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('文件不存在 = 空本子，且不会顺手建文件', () => {
    const path = join(root, 'memory-repo', 'notebook.md')
    expect(readNotebookFile(path, TODAY).entries).toEqual([])
    expect(() => readFileSync(path, 'utf8')).toThrow()
  })

  it('写进去的内容能原样读回（含中文与手工行）', () => {
    const path = join(root, 'memory-repo', 'notebook.md')
    const notebook: Notebook = {
      entries: [entry('n1', 'about_you', '喜欢周深；提到现场版会更兴奋')]
    }
    writeNotebookFile(path, notebook, TODAY)
    expect(readNotebookFile(path, TODAY)).toEqual(notebook)
    expect(readFileSync(path, 'utf8')).toContain('- n1 · 2026-11-01 · 喜欢周深')
  })

  it('手改文件：带编号的行按原样读回', () => {
    const path = join(root, 'memory-repo', 'notebook.md')
    mkdirSync(join(root, 'memory-repo'), { recursive: true })
    writeFileSync(
      path,
      ['# 小本本', '', '## 关于你', '- n7 · 2026-10-20 · 用户改过的条目', ''].join('\n'),
      'utf8'
    )
    const notebook = readNotebookFile(path, TODAY)
    expect(notebook.entries).toEqual([
      { id: 'n7', section: 'about_you', text: '用户改过的条目', at: '2026-10-20' }
    ])
  })

  it('列表带编号与分区；空本子给人话', () => {
    const notebook: Notebook = {
      entries: [
        entry('n1', 'about_you', '喜欢周深'),
        entry('n2', 'reminders', '别连续追问')
      ]
    }
    const text = notebookListText(notebook)
    expect(text).toContain('小本本（2 条')
    expect(text).toContain('关于你')
    expect(text).toContain('n1 喜欢周深')
    expect(text).toContain('我给自己的提醒')
    expect(text).toContain('/notebook rm <编号>')
    expect(notebookListText({ entries: [] })).toBe(emptyNotebookText())
  })
})
