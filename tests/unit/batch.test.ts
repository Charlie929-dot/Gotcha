import { describe, expect, it } from 'vitest'
import { openDatabase, insertEvent } from '../../src/db'
import {
  mergeMoments,
  readBatch,
  readCursor,
  selectBatchEvents,
  writeCursor,
  type BatchEvent
} from '../../src/understand/cloud/batch'

function ev(id: number, ts: number, overrides: Partial<BatchEvent> = {}): BatchEvent {
  return {
    id,
    ts,
    app: 'chrome.exe',
    window_title: '文档',
    ocr_text: `内容 ${id}`,
    sensitive: 0,
    ...overrides
  }
}

describe('mergeMoments · 同一 app + 标题、相邻 ≤ 90s 合并为时刻', () => {
  it('相邻事件合并、OCR 去重、eventIds 与 ts 区间正确', () => {
    const { moments, consumed } = mergeMoments([
      ev(1, 1_000, { ocr_text: '第一段' }),
      ev(2, 30_000, { ocr_text: '第一段' }), // 相同 OCR 去重
      ev(3, 100_000, { ocr_text: '第二段' })
    ])
    expect(moments).toHaveLength(1)
    expect(moments[0]).toEqual({
      app: 'chrome.exe',
      title: '文档',
      startTs: 1_000,
      endTs: 100_000,
      ocr: '第一段 / 第二段',
      eventIds: [1, 2, 3],
      sensitive: false
    })
    expect(consumed.map((event) => event.id)).toEqual([1, 2, 3])
  })

  it('标题/app 变化或间隔 > 90s 会切开时刻', () => {
    const { moments } = mergeMoments([
      ev(1, 0),
      ev(2, 10_000),
      ev(3, 10_000, { window_title: '别的窗口' }),
      ev(4, 200_000),
      ev(5, 200_000, { app: 'code.exe' })
    ])
    expect(moments.map((moment) => moment.eventIds)).toEqual([[1, 2], [3], [4], [5]])
  })

  it('sensitive 标签合并为「任一事件敏感」', () => {
    const { moments } = mergeMoments([ev(1, 0), ev(2, 1_000, { sensitive: 1 })])
    expect(moments[0].sensitive).toBe(true)
  })

  it('单批最多 20 个时刻；未进批的事件不消费（游标留在已消费处）', () => {
    const events = Array.from({ length: 25 }, (_, index) =>
      ev(index + 1, index * 200_000, { ocr_text: `内容 ${index + 1}` })
    )
    const { moments, consumed } = mergeMoments(events)
    expect(moments).toHaveLength(20)
    expect(consumed).toHaveLength(20)
    expect(consumed[consumed.length - 1].id).toBe(20)
  })

  it('窗口标题为空 / 空白时仍可合并（normalize 后为空串）', () => {
    const { moments } = mergeMoments([
      ev(1, 0, { window_title: '  ' }),
      ev(2, 1_000, { window_title: null })
    ])
    expect(moments).toHaveLength(1)
    expect(moments[0].title).toBe('')
  })
})

describe('取批游标与批窗口', () => {
  const NOW = 2_000_000

  function seed(): ReturnType<typeof openDatabase> {
    const db = openDatabase(':memory:')
    insertEvent(db, { ts: 100_000, app: 'a.exe', windowTitle: 'A', ocrText: 'a' })
    insertEvent(db, { ts: 500_000, app: 'b.exe', windowTitle: 'B', ocrText: 'b1' })
    insertEvent(db, { ts: 500_000, app: 'b.exe', windowTitle: 'B', ocrText: 'b2' })
    insertEvent(db, { ts: 900_000, app: 'c.exe', windowTitle: 'C', ocrText: 'c' })
    // 最近 5 分钟内的不取（留出合并窗口）
    insertEvent(db, { ts: NOW - 60_000, app: 'd.exe', windowTitle: 'D', ocrText: 'd' })
    return db
  }

  it('默认游标 (0,0)：取批窗口内全部事件，同 ts 按 id 升序', () => {
    const db = seed()
    try {
      const events = selectBatchEvents(db, { ts: 0, id: 0 }, NOW)
      expect(events.map((event) => event.id)).toEqual([1, 2, 3, 4])
    } finally {
      db.close()
    }
  })

  it('同 ts 用 id 续切；ts 大于游标的事件继续取', () => {
    const db = seed()
    try {
      const events = selectBatchEvents(db, { ts: 500_000, id: 2 }, NOW)
      expect(events.map((event) => event.id)).toEqual([3, 4])
    } finally {
      db.close()
    }
  })

  it('游标写读与 readBatch 合并结果', () => {
    const db = seed()
    try {
      writeCursor(db, { ts: 500_000, id: 3 })
      expect(readCursor(db)).toEqual({ ts: 500_000, id: 3 })
      const { moments, consumed } = readBatch(db, NOW)
      expect(consumed.map((event) => event.id)).toEqual([4])
      expect(moments[0].eventIds).toEqual([4])
    } finally {
      db.close()
    }
  })
})
