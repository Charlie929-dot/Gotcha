/**
 * 信息链正文 → events 镜像（P0-2 第一阶段）。
 *
 * 口径：
 * - 一条 chain_content 落行 → 一条 events（ts = captured_at，app / title 取所属段）；
 * - 正文超过上限只镜像前缀（完整正文仍在 chain_content）；
 * - 先过 sanitize：密码类命中整条不写，其它敏感命中只标 sensitive=1；
 * - 段不存在 / 写库抛错只计数，不把采集带崩。
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, queryTimeline, type Db } from '../../src/db'
import { ensureChainSchema } from '../../src/chain/schema'
import { openSegment } from '../../src/chain/store'
import { createChainEventMirror } from '../../src/main/chain-events'

/** 本地 2026-10-26 12:00 */
const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const at = (seconds: number): number => T0 + seconds * 1000

let db: Db

function openTestSegment(title = '文章 A - Firefox', app: string | null = 'Firefox'): number {
  return openSegment(
    db,
    {
      startTs: at(0),
      pid: 4242,
      exe: 'firefox.exe',
      app,
      hwnd: 42_424,
      title
    },
    at(0)
  )
}

beforeEach(() => {
  db = openDatabase(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

describe('createChainEventMirror', () => {
  it('正文落成 events：ts / app / title / 正文都对得上', () => {
    const segmentId = openTestSegment()
    const mirror = createChainEventMirror({ db })

    expect(mirror.onContent(segmentId, at(5), { source: 'uia', text: '插件市场里有 7.2k 条目' })).toBe(
      true
    )

    const rows = queryTimeline(db, 0, at(100))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ts: at(5),
      app: 'Firefox',
      window_title: '文章 A - Firefox',
      ocr_text: '插件市场里有 7.2k 条目',
      shot_path: null,
      sensitive: 0
    })
    expect(mirror.stats).toMatchObject({ written: 1, empty: 0, truncated: 0 })

    // 走的是 events 的 FTS 触发器：旧检索 / 时间线搜索也能命中镜像行
    const hits = db
      .prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?")
      .all('插件市场')
    expect(hits).toHaveLength(1)
  })

  it('超过上限只镜像前缀，并计入 truncated（完整正文仍在 chain_content）', () => {
    const segmentId = openTestSegment()
    const mirror = createChainEventMirror({ db, maxChars: 10 })

    expect(mirror.onContent(segmentId, at(1), { source: 'uia', text: '一二三四五六七八九十十一' })).toBe(
      true
    )
    expect(queryTimeline(db, 0, at(100))[0].ocr_text).toBe('一二三四五六七八九十')
    expect(mirror.stats).toMatchObject({ written: 1, truncated: 1 })
  })

  it('空正文不写行', () => {
    const segmentId = openTestSegment()
    const mirror = createChainEventMirror({ db })
    expect(mirror.onContent(segmentId, at(1), { source: 'uia', text: '   \n ' })).toBe(false)
    expect(queryTimeline(db, 0, at(100))).toHaveLength(0)
    expect(mirror.stats.empty).toBe(1)
  })

  it('密码类命中整条不写（与旧管线整帧丢弃同口径）', () => {
    const segmentId = openTestSegment()
    const mirror = createChainEventMirror({ db })
    expect(mirror.onContent(segmentId, at(1), { source: 'uia', text: '请输入密码后继续' })).toBe(false)
    expect(queryTimeline(db, 0, at(100))).toHaveLength(0)
    expect(mirror.stats.sensitive).toBe(1)
  })

  it('非密码类敏感命中仍写行，只标 sensitive=1', () => {
    const segmentId = openTestSegment()
    const mirror = createChainEventMirror({ db })
    expect(mirror.onContent(segmentId, at(1), { source: 'uia', text: '联系 alice@example.com 处理' })).toBe(
      true
    )
    const [row] = queryTimeline(db, 0, at(100))
    expect(row).toMatchObject({ ocr_text: '联系 alice@example.com 处理', sensitive: 1 })
  })

  it('段不存在：只计数，不写行、不抛错', () => {
    const mirror = createChainEventMirror({ db })
    expect(mirror.onContent(9999, at(1), { source: 'uia', text: '正文' })).toBe(false)
    expect(mirror.stats.missingSegment).toBe(1)
    expect(queryTimeline(db, 0, at(100))).toHaveLength(0)
  })

  it('events 表不存在（结构异常）只计 failed，不把采集带崩', () => {
    const bare = new Database(':memory:')
    try {
      ensureChainSchema(bare)
      const segmentId = openSegment(
        bare,
        { startTs: at(0), pid: 1, exe: 'app1', app: 'App1', hwnd: 10, title: '窗口' },
        at(0)
      )
      const mirror = createChainEventMirror({ db: bare })
      expect(() => mirror.onContent(segmentId, at(1), { source: 'uia', text: '正文' })).not.toThrow()
      expect(mirror.stats.failed).toBe(1)
    } finally {
      bare.close()
    }
  })

  it('段没有 app 时退回 exe', () => {
    const segmentId = openTestSegment('终端', null)
    const mirror = createChainEventMirror({ db })
    mirror.onContent(segmentId, at(1), { source: 'ocr', text: '➜ ~ git status' })
    expect(queryTimeline(db, 0, at(100))[0]).toMatchObject({
      app: 'firefox.exe',
      window_title: '终端'
    })
  })
})
