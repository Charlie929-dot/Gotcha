/**
 * 个人记忆 · 条目浏览 / 删除（memory-admin.ts）
 *
 * 重点：边界上钳死参数（关键词长度、分页、类别、id / uid 形态）；视图字段如实映射
 * （时刻 / 文件名 / 回收站计数）；删除进回收站、可以撤销。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, type Db } from '../../src/db'
import { syncVault } from '../../src/memory/store'
import {
  buildMemoryListView,
  deleteMemoryView,
  MEMORY_LIST_LIMIT_MAX,
  MEMORY_SEARCH_MAX_CHARS,
  parseMemoryListQuery,
  restoreMemoryView
} from '../../src/main/memory-admin'

const note = `---
🌻日期🌻: 2026-09-29
---
# Tracking
- [ ] 补数据结构

# Diary
- 01:19
	- 昨天参加评选，肖梦婷的讲解很有感染力 #观察
`

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotcha-memory-admin-'))
  writeFileSync(join(dir, '2026-09-29.md'), note, 'utf8')
  db = openDatabase(':memory:')
  syncVault(db, dir, { now: 1_000 })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('parseMemoryListQuery', () => {
  it('缺省 = 第一页；空字符串的类别当「全部」', () => {
    expect(parseMemoryListQuery(undefined)).toEqual({ ok: true, query: {} })
    expect(parseMemoryListQuery(null)).toEqual({ ok: true, query: {} })
    expect(parseMemoryListQuery({ search: '  肖梦婷  ', kind: '' })).toEqual({
      ok: true,
      query: { search: '肖梦婷' }
    })
  })

  it('非对象 / 超长关键词 / 不认识的类别都拒绝', () => {
    expect(parseMemoryListQuery([])).toEqual({ ok: false, error: '参数不合法' })
    expect(parseMemoryListQuery({ search: 42 })).toMatchObject({ ok: false })
    expect(parseMemoryListQuery({ search: 'x'.repeat(MEMORY_SEARCH_MAX_CHARS + 1) })).toMatchObject({
      ok: false,
      error: expect.stringContaining('最多')
    })
    expect(parseMemoryListQuery({ kind: 'ocr' })).toMatchObject({ ok: false })
  })

  it('分页参数是整数且在范围内', () => {
    expect(parseMemoryListQuery({ offset: 20, limit: 5 })).toEqual({
      ok: true,
      query: { offset: 20, limit: 5 }
    })
    expect(parseMemoryListQuery({ limit: 0 })).toMatchObject({ ok: false })
    expect(parseMemoryListQuery({ limit: MEMORY_LIST_LIMIT_MAX + 1 })).toMatchObject({ ok: false })
    expect(parseMemoryListQuery({ offset: -1 })).toMatchObject({ ok: false })
    expect(parseMemoryListQuery({ offset: 1.5 })).toMatchObject({ ok: false })
  })
})

describe('buildMemoryListView', () => {
  it('条目按视图映射：时刻 / 类别 / 标签 / 文件名（不给完整路径）', () => {
    const view = buildMemoryListView(db, {})
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.total).toBe(2)
    expect(view.deleted).toBe(0)
    // 待办没有时刻，排在当天最前
    expect(view.items[0]).toMatchObject({ kind: 'task', clock: null, day: '2026-09-29' })
    const diary = view.items[1]!
    expect(diary.clock).toBe('01:19')
    expect(diary.section).toBe('Diary')
    expect(diary.tags).toContain('观察')
    expect(diary.file).toBe('2026-09-29.md')
    expect(diary.file).not.toContain(dir)
    expect(diary.uid).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('搜索 / 分页直接透传（日期前缀看某天）', () => {
    const view = buildMemoryListView(db, { search: '2026-09-29', limit: 1 })
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.total).toBe(2)
    expect(view.items).toHaveLength(1)
    expect(view.hasMore).toBe(true)
  })
})

describe('delete / restore', () => {
  it('删除：进回收站、列表少一条，视图里带回收站计数', () => {
    const before = buildMemoryListView(db, {})
    if (!before.ok) throw new Error('empty view')
    const target = before.items.find((item) => item.kind === 'note' || item.kind === 'diary')!

    const deleted = deleteMemoryView(db, { id: target.id })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.item.uid).toBe(target.uid)
    expect(deleted.deleted).toBe(1)

    const after = buildMemoryListView(db, {})
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.total).toBe(1)
    expect(after.deleted).toBe(1)
  })

  it('撤销：放回原条目，回收站清零', () => {
    const before = buildMemoryListView(db, {})
    if (!before.ok) throw new Error('empty view')
    const target = before.items[0]!
    deleteMemoryView(db, { id: target.id })

    const restored = restoreMemoryView(db, { uid: target.uid })
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.item.uid).toBe(target.uid)
    expect(restored.item.text).toBe(target.text)

    const after = buildMemoryListView(db, {})
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.total).toBe(2)
    expect(after.deleted).toBe(0)
  })

  it('参数不合法 / 条目不在了：可读的错误，不抛异常', () => {
    expect(deleteMemoryView(db, null)).toEqual({ ok: false, error: '参数不合法' })
    expect(deleteMemoryView(db, { id: 0 })).toMatchObject({ ok: false })
    expect(deleteMemoryView(db, { id: '2' })).toMatchObject({ ok: false })
    expect(deleteMemoryView(db, { id: 999_999 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不在了')
    })
    expect(restoreMemoryView(db, { uid: 'not-a-uid' })).toEqual({ ok: false, error: '条目 uid 不合法' })
    expect(restoreMemoryView(db, { uid: 'a'.repeat(40) })).toMatchObject({
      ok: false,
      error: expect.stringContaining('回收站')
    })
  })
})
