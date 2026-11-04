/**
 * 小本本 · 主进程接线（src/main/notebook.ts）
 *
 * 守的纪律：
 * 1. 文件落在记忆仓根目录的 notebook.md；没有文件时读 = 空，不建库；
 * 2. update 成功才落盘，失败（栏满 / 没编号 / 太短）一个字节都不写；
 * 3. /notebook 列表与 /notebook rm 走同一份文件；
 * 4. 每轮读到的 section 是中文栏名（链层注入靠它）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createNotebookStore } from '../../src/main/notebook'

const NOW = new Date(2026, 10, 1, 21, 0, 0, 0).getTime()
const TODAY = '2026-11-01'

describe('createNotebookStore', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gotcha-notebook-store-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('没有文件：读 = 空，不顺手建文件', () => {
    const store = createNotebookStore({ root, now: () => NOW })
    expect(store.path).toBe(join(root, 'notebook.md'))
    expect(store.read()).toEqual([])
    expect(store.list()).toContain('还是空的')
  })

  it('add 落盘；read 给中文栏名；list 带编号；remove 再落盘', () => {
    const store = createNotebookStore({ root, now: () => NOW })
    expect(store.claim().ok).toBe(true)
    const added = store.update({ action: 'add', section: 'about_you', text: '喜欢周深' })
    expect(added.ok).toBe(true)
    expect(added.entry).toEqual({
      id: 'n1',
      section: '关于你',
      text: '喜欢周深',
      at: TODAY
    })
    expect(added.total).toBe(1)
    expect(store.read()).toEqual([{ id: 'n1', section: '关于你', text: '喜欢周深' }])

    const file = readFileSync(join(root, 'notebook.md'), 'utf8')
    expect(file).toContain('## 关于你')
    expect(file).toContain('- n1 · 2026-11-01 · 喜欢周深')

    expect(store.list()).toContain('n1 喜欢周深')
    const removed = store.remove('n1')
    expect(removed).toContain('放下了 n1')
    expect(store.read()).toEqual([])
  })

  it('revise 走编号；失败时文件不动', () => {
    const store = createNotebookStore({ root, now: () => NOW })
    store.claim()
    store.update({ action: 'add', section: 'about_you', text: '喜欢周深' })
    const revised = store.update({ action: 'revise', id: 'n1', text: '最近常听周深' })
    expect(revised.ok).toBe(true)
    expect(revised.entry?.text).toBe('最近常听周深')
    const before = readFileSync(join(root, 'notebook.md'), 'utf8')

    const missing = store.update({ action: 'remove', id: 'n9' })
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('n9')
    expect(readFileSync(join(root, 'notebook.md'), 'utf8')).toBe(before)
  })

  it('view：只有自己使用的栏目，条目带编号 / 日期，路径指向仓里的文件', () => {
    const store = createNotebookStore({ root, now: () => NOW })
    const empty = store.view()
    expect(empty.path).toBe(join(root, 'notebook.md'))
    expect(empty.total).toBe(0)
    expect(empty.groups).toEqual([])

    store.claim()
    store.update({ action: 'add', section: 'about_you', text: '喜欢周深' })
    store.claim()
    store.update({ action: 'add', section: 'reminders', text: '别连续追问' })
    const view = store.view()
    expect(view.total).toBe(2)
    expect(view.groups[0].entries).toEqual([{ id: 'n1', text: '喜欢周深', at: TODAY }])
    expect(view.groups.map((group) => group.section)).toEqual(['关于你', '我给自己的提醒'])
    expect(view.groups[1].entries.map((entry) => entry.id)).toEqual(['n2'])
  })

  it('参数不全时如实拒绝，不落盘', () => {
    const store = createNotebookStore({ root, now: () => NOW })
    expect(store.update({ action: 'add', section: 'about_you' }).ok).toBe(false)
    expect(store.update({ action: 'revise', id: 'n1' }).ok).toBe(false)
    expect(store.update({ action: 'remove' }).ok).toBe(false)
    expect(store.read()).toEqual([])
  })
})
