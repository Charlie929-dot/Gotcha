/**
 * 个人记忆 · 同步 / 召回 / 画像（store.ts）
 *
 * 三条验收：
 * 1）幂等：同一批文件同步两次，第二次一条都不动；
 * 2）可解释：召回结果必须带人话理由（提到什么 / 标签 / 距今多少天）；
 * 3）可复现：同一个问题问两次，结果顺序完全一致。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, type Db } from '../../src/db'
import {
  buildMemoryProfile,
  countDeleted,
  deleteMemoryItem,
  forgetVault,
  listMemoryItems,
  listMemorySources,
  memoryDayRange,
  memoryStats,
  readMemoryDay,
  readObservations,
  recallMemory,
  restoreMemoryItem,
  syncVault
} from '../../src/memory/store'

const dayA = `---
🌻日期🌻: 2026-09-29
---
# Tracking
- [x] 写完记忆实验的评测台
- [ ] 补数据结构

# Diary
- 01:19
	- 昨天参加评选，肖梦婷的讲解很有感染力 #观察
	- 她让我想到周深，都是把一件事做到极致
- 10:30
	- 研究 ai 聚合网关 [[openrouter]]，比想象中好用
`

const dayB = `---
🌻日期🌻: 2026-10-02
---
# Diary
- 22:00
	- 把 lingva 的断言补到 46 项，假上游 fixture 也做了 #工程
	- 还差真机验证，明天补
`

const template = `---\n日期: <% tp.date.now() %>\n---\n# Diary\n`

let dir: string
let db: Db

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotcha-memory-'))
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('syncVault：增量与幂等', () => {
  it('首次同步入库；模板文件跳过；第二次一条都不动', () => {
    write('2026-09-29.md', dayA)
    write('2026-10-02.md', dayB)
    write('2026-10-23.md', template)

    const first = syncVault(db, dir, { now: 1_000 })
    expect(first.scanned).toBe(3)
    expect(first.skipped).toBe(1)
    // 2 条待办 + 日记块合并后 2 条（09-29）+ 1 条（10-02）= 5
    expect(first.added).toBe(5)
    expect(first.items).toBe(5)

    const second = syncVault(db, dir, { now: 2_000 })
    // 三份文件都记了 (mtime, size) 指纹：模板那次也记了，所以三份都进 unchanged
    expect(second.unchanged).toBe(3)
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.removed).toBe(0)
    expect(second.items).toBe(5)
  })

  it('改了正文：旧条目删、新条目进（不是把旧内容留着）', () => {
    write('2026-09-29.md', dayA)
    syncVault(db, dir, { now: 1_000 })

    write('2026-09-29.md', dayA.replace('比想象中好用', '比想象中麻烦'))
    // 同长度改写：Windows 上两次写入可能落在同一毫秒，mtime 指纹会认不出；
    // 显式把 mtime 推后 1 秒，测的是「正文变了要重建条目」而不是文件系统的时间戳分辨率
    const later = new Date(Date.now() + 1_000)
    utimesSync(join(dir, '2026-09-29.md'), later, later)
    const result = syncVault(db, dir, { now: 2_000 })
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    const hit = recallMemory(db, { keywords: ['麻烦'], now: 2_000 })
    expect(hit.hits).toHaveLength(1)
    expect(recallMemory(db, { keywords: ['好用'], now: 2_000 }).hits).toHaveLength(0)
  })

  it('源文件删了：条目跟着走', () => {
    write('2026-09-29.md', dayA)
    write('2026-10-02.md', dayB)
    syncVault(db, dir, { now: 1_000 })
    unlinkSync(join(dir, '2026-10-02.md'))
    const result = syncVault(db, dir, { now: 2_000 })
    expect(result.removed).toBe(1) // dayB 只有一个日记块
    expect(result.items).toBe(4) // dayA：2 条待办 + 2 条日记
  })

  it('目录不存在：不抛错，返回空结果', () => {
    const result = syncVault(db, join(dir, 'nope'), { now: 1_000 })
    expect(result).toMatchObject({ scanned: 0, added: 0, items: 0 })
  })

  it('换一个目录同步：只清这个目录里消失的文件，别的目录的记忆不动', () => {    // 真实事故复现：先同步 D 盘的日记，再同步另一个同名旧副本 —— 旧实现会删掉前者的 2382 条
    write('2026-09-29.md', dayA)
    syncVault(db, dir, { now: 1_000 })
    const firstCount = (db.prepare('SELECT COUNT(*) AS n FROM mem_items').get() as { n: number }).n
    expect(firstCount).toBe(4)

    const other = mkdtempSync(join(tmpdir(), 'gotcha-memory-other-'))
    try {
      writeFileSync(join(other, '2026-10-02.md'), dayB, 'utf8')
      const result = syncVault(db, other, { now: 2_000 })
      expect(result.removed).toBe(0)
      const total = (db.prepare('SELECT COUNT(*) AS n FROM mem_items').get() as { n: number }).n
      expect(total).toBe(firstCount + 1)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('recallMemory：可解释、可复现', () => {
  beforeEach(() => {
    write('2026-09-29.md', dayA)
    write('2026-10-02.md', dayB)
    syncVault(db, dir, { now: 1_000 })
  })

  it('关键词命中带理由（提到 / 标签 / 时间）', () => {
    const result = recallMemory(db, { keywords: ['肖梦婷'], now: 1_000 })
    expect(result.mode).toBe('keywords')
    expect(result.hits.length).toBe(1)
    const hit = result.hits[0]
    expect(hit.day_key).toBe('2026-09-29')
    expect(hit.reasons.some((reason) => reason.includes('肖梦婷'))).toBe(true)
    expect(hit.reasons.some((reason) => reason.includes('标签') || reason.includes('天'))).toBe(true)
  })

  it('标签 / 双链也能搜（不只是正文）', () => {
    expect(recallMemory(db, { keywords: ['工程'], now: 1_000 }).hits).toHaveLength(1)
    expect(recallMemory(db, { keywords: ['openrouter'], now: 1_000 }).hits).toHaveLength(1)
    const refHit = recallMemory(db, { keywords: ['openrouter'], now: 1_000 }).hits[0]
    expect(refHit.reasons.some((reason) => reason.includes('关联'))).toBe(true)
  })

  it('同一个问题问两次，结果完全一致', () => {
    const first = recallMemory(db, { keywords: ['评测', '断言'], limit: 5, now: 5_000 })
    const second = recallMemory(db, { keywords: ['评测', '断言'], limit: 5, now: 5_000 })
    expect(first.hits.map((hit) => hit.id)).toEqual(second.hits.map((hit) => hit.id))
  })

  it('按天 / 类别 / 标签过滤', () => {
    expect(recallMemory(db, { day: '2026-10-02', now: 1_000 }).hits).toHaveLength(1)
    expect(recallMemory(db, { kind: 'task', now: 1_000 }).hits).toHaveLength(2)
    const tag = recallMemory(db, { tag: '工程', now: 1_000 }).hits
    expect(tag).toHaveLength(1)
    expect(tag[0].day_key).toBe('2026-10-02')
  })

  it('纯过滤（没有关键词）按时间倒序，不会把无关条目当命中', () => {
    const result = recallMemory(db, { limit: 3, now: 1_000 })
    expect(result.mode).toBe('filter')
    expect(result.hits[0].day_key).toBe('2026-10-02')
  })
})

describe('readMemoryDay / memoryStats / 画像', () => {
  beforeEach(() => {
    write('2026-09-29.md', dayA)
    write('2026-10-02.md', dayB)
    syncVault(db, dir, { now: 1_000 })
  })

  it('读整天的条目：按原文顺序、带段落标题', () => {
    const day = readMemoryDay(db, '2026-09-29')
    expect(day).not.toBeNull()
    expect(day!.items).toHaveLength(4)
    expect(day!.text).toContain('## Tracking')
    expect(day!.text).toContain('## Diary')
    expect(readMemoryDay(db, '2026-01-01')).toBeNull()
  })

  it('统计：条目数 / 天数 / 待办 / 高频标签与双链', () => {
    const stats = memoryStats(db)
    expect(stats.items).toBe(5)
    expect(stats.days).toBe(2)
    expect(stats.firstDay).toBe('2026-09-29')
    expect(stats.lastDay).toBe('2026-10-02')
    expect(stats.tasks).toEqual({ open: 1, done: 1 })
    expect(stats.topTags[0].tag).toBe('工程')
    expect(stats.topRefs[0].ref).toBe('openrouter')
  })

  it('画像落成可解释的观测（可重复生成，不重复插入）', () => {
    const first = buildMemoryProfile(db, { now: 1_000 })
    expect(first.length).toBeGreaterThanOrEqual(3)
    expect(first.some((item) => item.statement.includes('5 条'))).toBe(true)
    expect(first.some((item) => item.statement.includes('openrouter'))).toBe(true)

    buildMemoryProfile(db, { now: 2_000 })
    expect(readObservations(db)).toHaveLength(first.length)
  })
})

describe('浏览 / 删除 / 回收站', () => {
  beforeEach(() => {
    write('2026-09-29.md', dayA)
    write('2026-10-02.md', dayB)
    syncVault(db, dir, { now: 1_000 })
  })

  it('列表：按天倒序；同一天按原文顺序（待办在日记前）', () => {
    const page = listMemoryItems(db, { limit: 3 })
    expect(page.total).toBe(5)
    expect(page.hasMore).toBe(true)
    expect(page.items[0].day_key).toBe('2026-10-02')
    expect(page.items.slice(1).map((item) => item.day_key)).toEqual(['2026-09-29', '2026-09-29'])
    // 同一天里第一条是 Tracking 的待办（没有时刻 → ts 为 null）
    expect(page.items[1].kind).toBe('task')
    expect(page.items[1].ts).toBeNull()

    const second = listMemoryItems(db, { offset: 3, limit: 3 })
    expect(second.items).toHaveLength(2)
    expect(second.hasMore).toBe(false)
  })

  it('搜索：关键词命中正文；日期前缀只按天过滤；类别过滤；多词是 OR', () => {
    expect(listMemoryItems(db, { search: '肖梦婷' }).total).toBe(1)
    expect(listMemoryItems(db, { search: '2026-09' }).total).toBe(4)
    const day = listMemoryItems(db, { search: '2026-10-02' })
    expect(day.total).toBe(1)
    expect(day.items[0].day_key).toBe('2026-10-02')
    expect(listMemoryItems(db, { kind: 'task' }).total).toBe(2)
    expect(listMemoryItems(db, { search: '肖梦婷 断言' }).total).toBe(2)
  })

  it('删除：从索引消失、进回收站；改别的段落重同步也不会把它带回来', () => {
    const target = listMemoryItems(db, { search: '肖梦婷' }).items[0]
    const result = deleteMemoryItem(db, target.id)
    expect(result).not.toBeNull()
    expect(result!.item.uid).toBe(target.uid)
    expect(result!.deleted).toBe(1)
    expect(countDeleted(db)).toBe(1)
    expect(memoryStats(db).items).toBe(4)
    expect(recallMemory(db, { keywords: ['肖梦婷'], now: 1_000 }).hits).toHaveLength(0)

    // 改同一份文件的另一个段落：整份重解析，但删掉的那条不能回来
    write('2026-09-29.md', dayA.replace('比想象中好用', '比想象中麻烦'))
    const later = new Date(Date.now() + 1_000)
    utimesSync(join(dir, '2026-09-29.md'), later, later)
    const sync = syncVault(db, dir, { now: 2_000 })
    expect(sync.items).toBe(4)
    expect(recallMemory(db, { keywords: ['肖梦婷'], now: 2_000 }).hits).toHaveLength(0)
    expect(countDeleted(db)).toBe(1)
  })

  it('撤销删除：原样放回；文件没变时再同步也不会重复插入', () => {
    const target = listMemoryItems(db, { search: '肖梦婷' }).items[0]
    deleteMemoryItem(db, target.id)
    const restored = restoreMemoryItem(db, target.uid)
    expect(restored).not.toBeNull()
    expect(restored!.uid).toBe(target.uid)
    expect(restored!.text).toBe(target.text)
    expect(restored!.tags).toEqual(target.tags)
    expect(countDeleted(db)).toBe(0)
    expect(recallMemory(db, { keywords: ['肖梦婷'], now: 1_000 }).hits).toHaveLength(1)

    const sync = syncVault(db, dir, { now: 2_000 })
    expect(sync.unchanged).toBe(2)
    expect(memoryStats(db).items).toBe(5)
  })

  it('删不存在的 id / 恢复不存在的 uid：返回 null，一条都不动', () => {
    expect(deleteMemoryItem(db, 999_999)).toBeNull()
    expect(restoreMemoryItem(db, 'x'.repeat(40))).toBeNull()
    expect(memoryStats(db).items).toBe(5)
    expect(countDeleted(db)).toBe(0)
  })
})

describe('sources / forgetVault：按目录清理', () => {
  it('列出每个来源的条目数；forget 只删指定目录', () => {
    const other = mkdtempSync(join(tmpdir(), 'gotcha-memory-other-'))
    try {
      write('2026-09-29.md', dayA)
      writeFileSync(join(other, '2026-10-02.md'), dayB, 'utf8')
      syncVault(db, dir, { now: 1_000 })
      syncVault(db, other, { now: 2_000 })

      const sources = listMemorySources(db)
      expect(sources).toHaveLength(2)
      expect(sources.map((source) => source.items).sort()).toEqual([1, 4])

      expect(forgetVault(db, other)).toBe(1)
      expect(listMemorySources(db)).toHaveLength(1)
      expect(memoryStats(db).items).toBe(4)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('forget 传无关目录：一条都不删', () => {
    write('2026-09-29.md', dayA)
    syncVault(db, dir, { now: 1_000 })
    expect(forgetVault(db, join(dir, 'not-this-vault'))).toBe(0)
    expect(memoryStats(db).items).toBe(4)
  })
})

// 开场每问都要「日记记到哪天」：只查首末日期，不读条目（2026-10-30 收敛）
describe('memoryDayRange：只取首末日期', () => {
  it('空库两头都是 null', () => {
    expect(memoryDayRange(db)).toEqual({ firstDay: null, lastDay: null })
  })

  it('有数据时取最早 / 最晚的 day_key，与 memoryStats 的口径一致', () => {
    write('2026-09-29.md', dayA)
    write('2026-10-02.md', dayB)
    syncVault(db, dir, { now: 1_000 })
    expect(memoryDayRange(db)).toEqual({ firstDay: '2026-09-29', lastDay: '2026-10-02' })
    const stats = memoryStats(db)
    expect(memoryDayRange(db).lastDay).toBe(stats.lastDay)
    expect(memoryDayRange(db).firstDay).toBe(stats.firstDay)
  })
})

