import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHAIN_META_TABLE,
  CHAIN_SCHEMA_VERSION,
  CHAIN_TABLES,
  ensureChainSchema,
  type ChainSegmentRow,
  type ChainShotRow
} from '../../src/chain/schema'
import {
  findOverlaps,
  validateContent,
  validateEvent,
  validateSegment,
  validateShot
} from '../../src/chain/invariants'

let db: Database.Database | null = null

function open(): Database.Database {
  db = new Database(':memory:')
  ensureChainSchema(db)
  return db
}

afterEach(() => {
  db?.close()
  db = null
})

function segment(overrides: Partial<ChainSegmentRow> = {}): ChainSegmentRow {
  return {
    id: 1,
    start_ts: 1_000,
    end_ts: 61_000,
    active_ms: 60_000,
    idle_ms: 0,
    day_key: '2026-10-26',
    app: 'Firefox',
    exe: 'firefox',
    pid: 100,
    hwnd: 200,
    title_first: 'A',
    title_last: 'A',
    created_at: 1_000,
    closed: 1,
    ...overrides
  }
}

describe('ensureChainSchema', () => {
  it('建出契约的八张表 + 版本记账表，且重复执行幂等', () => {
    const database = open()
    ensureChainSchema(database)
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chain_%' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(names.map((row) => row.name)).toEqual([...CHAIN_TABLES, CHAIN_META_TABLE].sort())
  })

  it('新建库把自己的结构版本记成当前版本（幂等，不覆盖成 0）', () => {
    const database = open()
    ensureChainSchema(database)
    const version = () =>
      (
        database.prepare("SELECT value FROM chain_meta WHERE key = 'schema_version'").get() as {
          value: string
        }
      ).value
    expect(version()).toBe(String(CHAIN_SCHEMA_VERSION))
    ensureChainSchema(database)
    expect(version()).toBe(String(CHAIN_SCHEMA_VERSION))
  })

  it('库的结构版本高于程序：拒绝启动，不让旧程序往新库里写', () => {
    const database = open()
    database
      .prepare("UPDATE chain_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(CHAIN_SCHEMA_VERSION + 1))
    expect(() => ensureChainSchema(database)).toThrow(/高于本程序支持/)
  })

  it('版本落后但没写迁移步骤：抛错而不是假装迁移成功', () => {
    const database = open()
    // 1 → 0 是假想的老库：当前没有 v1 迁移步骤，必须响错
    database.prepare("UPDATE chain_meta SET value = '0' WHERE key = 'schema_version'").run()
    expect(() => ensureChainSchema(database)).toThrow(/缺少 chain v0 → v1 的迁移步骤/)
  })

  it('版本账本内容非法：响错', () => {
    const database = open()
    database.prepare("UPDATE chain_meta SET value = 'abc' WHERE key = 'schema_version'").run()
    expect(() => ensureChainSchema(database)).toThrow(/schema_version 非法/)
  })

  it('不碰旧表：只建 chain_ 前缀', () => {
    const database = open()
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    expect(names.every((row) => row.name.startsWith('chain_'))).toBe(true)
  })

  it('证据表能写入，段与非空字段的 CHECK 生效', () => {
    const database = open()
    database
      .prepare(
        `INSERT INTO chain_segment (start_ts, end_ts, active_ms, idle_ms, day_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(1_000, 61_000, 60_000, 0, '2026-10-26', 1_000)
    expect(() =>
      database
        .prepare(
          `INSERT INTO chain_segment (start_ts, end_ts, active_ms, idle_ms, day_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(1_000, 61_000, -1, 0, '2026-10-26', 1_000)
    ).toThrow()
  })

  it('事件类型与截图层级受 CHECK 约束', () => {
    const database = open()
    database.prepare('INSERT INTO chain_segment (id, start_ts, end_ts, active_ms, day_key, created_at) VALUES (1, 0, 1000, 1000, ?, 0)').run('2026-10-26')
    expect(() =>
      database.prepare('INSERT INTO chain_event (segment_id, ts, kind) VALUES (1, 10, ?)').run('keypress')
    ).toThrow()
    expect(() =>
      database
        .prepare("INSERT INTO chain_shot (segment_id, ts, source, tier) VALUES (1, 10, 'event', 'frozen')")
        .run()
    ).toThrow()
    expect(() =>
      database.prepare("INSERT INTO chain_shot (segment_id, ts, source) VALUES (1, 10, 'event')").run()
    ).not.toThrow()
  })

  it('内容来源只能是 uia / ocr / manual', () => {
    const database = open()
    database.prepare('INSERT INTO chain_segment (id, start_ts, end_ts, active_ms, day_key, created_at) VALUES (1, 0, 1000, 1000, ?, 0)').run('2026-10-26')
    expect(() =>
      database
        .prepare("INSERT INTO chain_content (segment_id, captured_at, source, text, chars, hash) VALUES (1, 1, 'guess', 'x', 1, 'h')")
        .run()
    ).toThrow()
  })

  it('派生层：向量行带 content_max_id，derived 进度行独立（v0.8）', () => {
    const database = open()
    database.prepare('INSERT INTO chain_segment (id, start_ts, end_ts, active_ms, day_key, created_at) VALUES (1, 0, 1000, 1000, ?, 0)').run('2026-10-26')
    database
      .prepare('INSERT INTO chain_vector (segment_id, model, dim, vec, text_hash) VALUES (1, ?, 512, ?, ?)')
      .run('bge-small-zh-v1.5', Buffer.alloc(4), 'abc')
    const vector = database.prepare('SELECT * FROM chain_vector WHERE segment_id = 1').get() as {
      content_max_id: number
    }
    expect(vector.content_max_id).toBe(0)
    database
      .prepare('INSERT INTO chain_derive (segment_id, text_hash, content_max_id, derived_at) VALUES (1, ?, 0, ?)')
      .run('abc', 123)
    expect(database.prepare('SELECT * FROM chain_derive WHERE segment_id = 1').get()).toMatchObject({
      text_hash: 'abc',
      content_max_id: 0,
      derived_at: 123
    })
  })

  it('v1 老库迁移到 v2：补 chain_derive 表与 chain_vector.content_max_id，老向量不丢', () => {
    const database = open()
    // 把库退回 v1 形状：删掉 v2 的表 / 列，写入一条老向量，再把版本账本改成 1
    database.exec('DROP TABLE chain_derive')
    database.exec('DROP TABLE chain_vector')
    database.exec(`CREATE TABLE chain_vector (
      segment_id INTEGER PRIMARY KEY,
      model      TEXT    NOT NULL,
      dim        INTEGER NOT NULL,
      vec        BLOB    NOT NULL,
      text_hash  TEXT    NOT NULL
    )`)
    database
      .prepare('INSERT INTO chain_vector (segment_id, model, dim, vec, text_hash) VALUES (7, ?, 2, ?, ?)')
      .run('bge-small-zh-v1.5', Buffer.from([1, 2, 3, 4]), 'old')
    database.prepare("UPDATE chain_meta SET value = '1' WHERE key = 'schema_version'").run()

    ensureChainSchema(database)

    const columns = (
      database.prepare('PRAGMA table_info(chain_vector)').all() as Array<{ name: string }>
    ).map((column) => column.name)
    expect(columns).toContain('content_max_id')
    expect(database.prepare('SELECT content_max_id FROM chain_vector WHERE segment_id = 7').get()).toEqual({
      content_max_id: 0
    })
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chain_derive'").get()
    ).toBeTruthy()
    expect(
      (database.prepare("SELECT value FROM chain_meta WHERE key = 'schema_version'").get() as { value: string }).value
    ).toBe(String(CHAIN_SCHEMA_VERSION))
  })
})

describe('validateSegment', () => {
  it('有效时长 + 空闲必须等于跨度', () => {
    expect(validateSegment(segment())).toEqual([])
    // 走开回来接续：跨度 60s，其中 20s 空闲
    expect(validateSegment(segment({ active_ms: 40_000, idle_ms: 20_000 }))).toEqual([])
    expect(validateSegment(segment({ active_ms: 40_000, idle_ms: 0 }))).toEqual([
      '有效时长 + 空闲 (40000 + 0) 不等于跨度 60000'
    ])
  })

  it('结束早于开始、负时长、空 day_key 都报错', () => {
    expect(validateSegment(segment({ start_ts: 61_000, end_ts: 1_000 }))).toContain('段结束早于开始')
    expect(validateSegment(segment({ active_ms: -1 }))).toContain('段时长不能为负')
    expect(validateSegment(segment({ day_key: '  ' }))).toContain('段缺少 day_key')
  })
})

describe('validateEvent / validateShot / validateContent', () => {
  const base = segment()

  it('事件必须落在段内且指向存在的段', () => {
    expect(validateEvent({ id: 1, segment_id: 1, ts: 5_000, kind: 'click_left', x: 1, y: 2, delta: null }, base)).toEqual([])
    expect(validateEvent({ id: 1, segment_id: 2, ts: 5_000, kind: 'click_left', x: null, y: null, delta: null }, base)).toContain(
      '事件指向的段不存在'
    )
    expect(validateEvent({ id: 1, segment_id: 1, ts: 99_000, kind: 'wheel', x: null, y: null, delta: 1 }, base)).toContain(
      '事件时刻落在段之外'
    )
  })

  function shot(overrides: Partial<ChainShotRow> = {}): ChainShotRow {
    return {
      id: 1,
      segment_id: 1,
      event_id: null,
      ts: 5_000,
      path: '/tmp/a.webp',
      width: 100,
      height: 100,
      bytes: 1000,
      source: 'enter',
      tier: 'hot',
      container: null,
      ...overrides
    }
  }

  it('截图必须挂在存在的段上，挂的事件必须同段', () => {
    expect(validateShot(shot(), base)).toEqual([])
    expect(validateShot(shot({ segment_id: 9 }), base)).toContain('截图指向的段不存在')
    expect(validateShot(shot({ event_id: 3 }), base)).toContain('截图挂在不存在的事件上')
    expect(
      validateShot(shot({ event_id: 3 }), base, { id: 3, segment_id: 2, ts: 5_000, kind: 'enter', x: null, y: null, delta: null })
    ).toContain('截图与它的事件不属于同一段')
    // 入场帧挂在 enter 事件上是正常的（每张截图都有锚点）
    expect(
      validateShot(
        shot({ event_id: 3 }),
        base,
        { id: 3, segment_id: 1, ts: 5_000, kind: 'enter', x: null, y: null, delta: null }
      )
    ).toEqual([])
  })

  it('内容必须有正文，字符数要和正文对得上', () => {
    expect(
      validateContent({ id: 1, segment_id: 1, captured_at: 1, source: 'uia', text: '记忆球', chars: 3, hash: 'h' })
    ).toEqual([])
    expect(
      validateContent({ id: 1, segment_id: 1, captured_at: 1, source: 'ocr', text: '  ', chars: 2, hash: 'h' })
    ).toContain('内容为空')
    expect(
      validateContent({ id: 1, segment_id: 1, captured_at: 1, source: 'ocr', text: 'abc', chars: 9, hash: 'h' })
    ).toContain('字符数 9 与正文长度 3 不一致')
  })
})

describe('findOverlaps', () => {
  it('相邻不算重叠，交错算', () => {
    expect(findOverlaps([{ start_ts: 0, end_ts: 100 }, { start_ts: 100, end_ts: 200 }])).toEqual([])
    expect(findOverlaps([{ start_ts: 0, end_ts: 150 }, { start_ts: 100, end_ts: 200 }])).toHaveLength(1)
  })

  it('乱序输入也能发现重叠', () => {
    expect(findOverlaps([{ start_ts: 100, end_ts: 200 }, { start_ts: 0, end_ts: 150 }])).toHaveLength(1)
  })
})
