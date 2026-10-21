import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, queryTimeline, type Db } from '../../src/db'

const DAY = 24 * 60 * 60 * 1000

describe('queryTimeline · 时间线数据源', () => {
  let db: Db | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('闭区间 [from, to]、按 ts 升序；缺省列落 NULL，sensitive 默认 0', () => {
    db = openDatabase(':memory:')
    const id = insertEvent(db, { ts: 1_000, app: 'notepad' })
    expect(id).toBe(1)

    const rows = queryTimeline(db, 1_000, 1_000)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: 1,
      ts: 1_000,
      app: 'notepad',
      window_title: null,
      ocr_text: null,
      shot_path: null,
      intent_json: null,
      sensitive: 0
    })
  })

  it('时间戳相同按 id 升序（插入顺序）', () => {
    db = openDatabase(':memory:')
    const first = insertEvent(db, { ts: 5_000, app: 'a' })
    const second = insertEvent(db, { ts: 5_000, app: 'b' })

    expect(queryTimeline(db, 0, 10_000).map((r) => r.id)).toEqual([first, second])
  })

  it('空区间 / 区间外边界 1ms / from > to 都返回空数组', () => {
    db = openDatabase(':memory:')
    insertEvent(db, { ts: 10_000, app: 'notepad' })

    expect(queryTimeline(db, 10_001, 20_000)).toEqual([])
    expect(queryTimeline(db, 0, 9_999)).toEqual([])
    expect(queryTimeline(db, 20_000, 10_000)).toEqual([])
    // 边界包含：恰好等于 from / to 的事件要能取到
    expect(queryTimeline(db, 10_000, 10_000)).toHaveLength(1)
  })

  it('跨天区间返回两天的全部事件且顺序连续', () => {
    db = openDatabase(':memory:')
    const day1Late = Date.UTC(2026, 9, 20, 23, 50)
    const day2Early = Date.UTC(2026, 9, 21, 0, 10)
    const day2Noon = Date.UTC(2026, 9, 21, 12, 0)
    insertEvent(db, { ts: day2Noon, app: 'chrome' })
    insertEvent(db, { ts: day1Late, app: 'notepad' })
    insertEvent(db, { ts: day2Early, app: 'code' })

    const rows = queryTimeline(db, day1Late - DAY, day2Noon + DAY)
    expect(rows.map((r) => r.ts)).toEqual([day1Late, day2Early, day2Noon])
    expect(rows.map((r) => r.app)).toEqual(['notepad', 'code', 'chrome'])
  })

  it('敏感标记与 OCR 原文按写入值落库（D10：本地保留原文）', () => {
    db = openDatabase(':memory:')
    insertEvent(db, {
      ts: 42,
      app: 'chrome',
      windowTitle: '登录',
      ocrText: 'api_key=sk-xxx',
      sensitive: 1
    })

    const [row] = queryTimeline(db, 0, 100)
    expect(row.sensitive).toBe(1)
    expect(row.ocr_text).toBe('api_key=sk-xxx')
  })
})

describe('openDatabase · 文件库', () => {
  it('文件库启用 WAL（采集高频小写入）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-db-'))
    try {
      const db = openDatabase(join(dir, 'memory.db'))
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      db.close()
    } finally {
      // Windows 上杀毒/索引偶发占用，重试几次再放弃
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
