import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import {
  buildSnippet,
  classifyQuery,
  displayOcrText,
  escapeLikePattern,
  ftsPhrase,
  listSearchApps,
  querySearchHitEvents,
  rebuildEventSearchIndex,
  SEARCH_EVENT_LIMIT,
  searchEvents,
  splitQueryTerms
} from '../../src/understand/search'

function at(day: number, hour: number, minute = 0, second = 0): number {
  return new Date(2026, 9, day, hour, minute, second, 0).getTime()
}

/** 造一条事件（走 insertEvent → v5 触发器同步索引）；`ocr` 故意保留 OCR 的逐字空格 */
function seed(
  db: Db,
  input: { ts: number; app?: string; title?: string | null; ocr?: string | null }
): number {
  return insertEvent(db, {
    ts: input.ts,
    app: input.app ?? 'Code',
    windowTitle: input.title === undefined ? 'a.ts' : input.title,
    ocrText: input.ocr ?? null
  })
}

function withDb(run: (db: Db) => void): void {
  const db = openDatabase(':memory:')
  try {
    run(db)
  } finally {
    db.close()
  }
}

describe('查询归一与分类', () => {
  it('切词时中文之间的空格先合并，英文 / 数字之间仍作为分词边界', () => {
    expect(splitQueryTerms('  图 谱\u3000设计  ')).toEqual(['图谱设计'])
    expect(splitQueryTerms('图谱 API 用法')).toEqual(['图谱', 'API', '用法'])
    expect(splitQueryTerms('   ')).toEqual([])
  })

  it('≥3 字全词走 MATCH；含短词或二字词走 LIKE；单字视为空查询', () => {
    expect(classifyQuery('图谱设计')).toMatchObject({ query: '图谱设计', mode: 'match' })
    // 用户粘贴 OCR 的逐字空格文本：中文之间空格先合并，仍算一个连续词
    expect(classifyQuery('图 谱 设 计')).toMatchObject({ query: '图谱设计', mode: 'match' })
    expect(classifyQuery('按钮 样式')).toMatchObject({ query: '按钮样式', mode: 'match' })
    expect(classifyQuery('图谱')).toMatchObject({ query: '图谱', mode: 'like' })
    expect(classifyQuery('图谱 2024')).toMatchObject({ query: '图谱 2024', mode: 'like' })
    expect(classifyQuery('图')).toMatchObject({ mode: 'empty' })
    expect(classifyQuery('   ')).toMatchObject({ mode: 'empty' })
  })

  it('FTS 短语与 LIKE 转义：用户输入当字面量，不是语法', () => {
    expect(ftsPhrase('图谱"OR"天气')).toBe('"图谱""OR""天气"')
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })

  it('展示层合并中文之间的空格，保留英文词间距', () => {
    expect(displayOcrText('0 AIHOT 一 AI 行 业 动 态')).toBe('0 AIHOT 一 AI 行业动态')
    expect(displayOcrText('hello   world')).toBe('hello world')
  })
})

describe('buildSnippet', () => {
  it('截取命中词附近上下文并加省略号', () => {
    const raw = `${'前'.repeat(120)}目标词${'后'.repeat(120)}`
    const snippet = buildSnippet(raw, ['目标词'], 40)
    expect(snippet).toContain('目标词')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect([...snippet].length).toBeLessThanOrEqual(42)
  })

  it('中文词内空格不影响命中；短文本原样返回', () => {
    expect(buildSnippet('图 谱 设 计', ['图谱'], 40)).toBe('图谱设计')
    expect(buildSnippet(null, ['图谱'])).toBe('')
  })

  it('找不到词时退化为开头一段', () => {
    expect(buildSnippet('甲乙丙丁'.repeat(40), ['不存在'], 20)).toBe(`${'甲乙丙丁'.repeat(5)}…`)
  })
})

describe('searchEvents · L0 检索', () => {
  it('OCR 逐字空格的中文仍能被连续词命中（归一化索引，非原文 LIKE）', () => {
    withDb((db) => {
      const ts = at(22, 9)
      seed(db, { ts, app: 'Code', title: 'a.ts', ocr: '改 按 钮 样 式 与 悬 停 态' })
      const result = searchEvents(db, { query: '按钮样式' })
      expect(result.mode).toBe('match')
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0].snippet).toContain('按钮样式')
      expect(result.hits[0].app).toBe('Code')
    })
  })

  it('两字词走 LIKE 兜底，同样命中逐字空格文本', () => {
    withDb((db) => {
      const ts = at(22, 9)
      seed(db, { ts, ocr: '改 按 钮 样 式' })
      const result = searchEvents(db, { query: '按钮' })
      expect(result.mode).toBe('like')
      expect(result.hits).toHaveLength(1)
      expect(result.matchedEvents).toBe(1)
    })
  })

  it('英文大小写不敏感；LIKE 兜底里 % _ 按字面匹配', () => {
    withDb((db) => {
      const ts = at(22, 9)
      seed(db, { ts, ocr: 'SEARCHFTS 与 百 分 之 燃' })
      seed(db, { ts: ts + 1_000, ocr: '1 0 0 % 燃' })
      expect(searchEvents(db, { query: 'searchfts' }).hits).toHaveLength(1)
      // '%' 若被当成通配符会连「百分之燃」一起命中；转义后只认字面 '%燃'
      const percent = searchEvents(db, { query: '%燃' })
      expect(percent.hits).toHaveLength(1)
      expect(percent.hits[0].snippet).toContain('%')
      expect(percent.hits[0].snippet).toContain('燃')
      expect(searchEvents(db, { query: '燃%' }).hits).toHaveLength(0)
      expect(searchEvents(db, { query: '_燃' }).hits).toHaveLength(0)
    })
  })

  it('app / 标题 / 时间窗过滤都生效，可组合', () => {
    withDb((db) => {
      const t1 = at(22, 9)
      const t2 = at(22, 15)
      seed(db, { ts: t1, app: 'Code', title: 'a.ts', ocr: '查 API 用法' })
      seed(db, { ts: t2, app: 'Chrome', title: '文档', ocr: '查 API 用法' })
      seed(db, { ts: at(21, 9), app: 'Chrome', title: '文档', ocr: '查 API 用法' })

      expect(searchEvents(db, { query: '用法' }).hits).toHaveLength(3)
      expect(searchEvents(db, { query: '用法', app: 'Chrome' }).hits).toHaveLength(2)
      expect(searchEvents(db, { query: '用法', app: 'Chrome', titleContains: '文' }).hits).toHaveLength(2)
      const ranged = searchEvents(db, { query: '用法', fromTs: at(22, 8), toTs: at(22, 12) })
      expect(ranged.hits).toHaveLength(1)
      expect(ranged.hits[0].app).toBe('Code')
      // 反向区间不查库，直接空结果
      expect(searchEvents(db, { query: '用法', fromTs: t2, toTs: t1 }).hits).toEqual([])
    })
  })

  it('单字 / 空查询不查库返回 empty', () => {
    withDb((db) => {
      seed(db, { ts: at(22, 9), ocr: '图 谱' })
      expect(searchEvents(db, { query: '图' })).toMatchObject({ mode: 'empty', hits: [] })
      expect(searchEvents(db, { query: '  ' })).toMatchObject({ mode: 'empty', hits: [] })
    })
  })

  it('同一时刻的多条事件归并成一张卡片，未成时刻的按 90s 口径就地成组', () => {
    withDb((db) => {
      const t = at(22, 9)
      const e1 = seed(db, { ts: t, app: 'Code', title: 'a.ts', ocr: '改 按 钮' })
      const e2 = seed(db, { ts: t + 30_000, app: 'Code', title: 'a.ts', ocr: '调 整 按 钮' })
      const e3 = seed(db, { ts: t + 300_000, app: 'Code', title: 'a.ts', ocr: '又 见 按 钮' })
      db.prepare(
        `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
         VALUES (1, ?, ?, '2026-10-22', 'Code', 'a.ts', '改按钮 / 调整按钮', ?, 1)`
      ).run(t, t + 30_000, JSON.stringify([e1, e2]))

      const result = searchEvents(db, { query: '按钮' })
      expect(result.hits).toHaveLength(2)
      // LIKE 路径按时间倒序：后面的散事件在前，时刻卡片在后
      const [later, moment] = result.hits
      expect(later.momentId).toBeNull()
      expect(later.eventIds).toEqual([e3])
      expect(moment.momentId).toBe(1)
      expect(moment.matchedEvents).toBe(2)
      expect(moment.ocrSummary).toBe('改按钮 / 调整按钮')
      expect(moment.eventIds).toEqual([e1, e2])
    })
  })

  it('命中事件被上限截断时标 truncated', () => {
    withDb((db) => {
      const t = at(22, 9)
      for (let index = 0; index <= SEARCH_EVENT_LIMIT; index += 1) {
        seed(db, { ts: t + index * 60_000, app: 'Code', title: `t${index}.ts`, ocr: `第 ${index} 条 记 录` })
      }
      const result = searchEvents(db, { query: '记录' })
      expect(result.matchedEvents).toBe(SEARCH_EVENT_LIMIT)
      expect(result.truncated).toBe(true)
      expect(result.hits.length).toBeLessThanOrEqual(50)
    })
  })

  it('只读 L0：完全没有 moments / nodes / edges 时检索照常（归纳全停的架构断言）', () => {
    withDb((db) => {
      seed(db, { ts: at(22, 9), ocr: '离 线 也 要 能 搜 到' })
      const result = searchEvents(db, { query: '离线也要' })
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0].momentId).toBeNull()
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM moments').get()).toEqual({ n: 0 })
    })
  })
})

describe('检索索引维护（v5 触发器 + 重建）', () => {
  it('插入 / 改写 / 删除都同步到索引', () => {
    withDb((db) => {
      const id = seed(db, { ts: at(22, 9), ocr: '原 文 甲 乙 丙' })
      expect(searchEvents(db, { query: '甲乙丙' }).hits).toHaveLength(1)

      db.prepare('UPDATE events SET ocr_text = ? WHERE id = ?').run('改 成 丁 戊 己', id)
      expect(searchEvents(db, { query: '甲乙丙' }).hits).toHaveLength(0)
      expect(searchEvents(db, { query: '丁戊己' }).hits).toHaveLength(1)

      db.prepare('DELETE FROM events WHERE id = ?').run(id)
      expect(searchEvents(db, { query: '丁戊己' }).hits).toHaveLength(0)
      expect(db.prepare('SELECT COUNT(*) AS n FROM events_fts').get()).toEqual({ n: 0 })
    })
  })

  it('索引可整体重建：清空后重灌回同一结果，且幂等', () => {
    withDb((db) => {
      seed(db, { ts: at(22, 9), ocr: '重 建 前 也 能 查' })
      db.exec('DELETE FROM events_fts')
      expect(searchEvents(db, { query: '重建前' }).hits).toHaveLength(0)

      expect(rebuildEventSearchIndex(db)).toBe(1)
      expect(searchEvents(db, { query: '重建前' }).hits).toHaveLength(1)
      expect(rebuildEventSearchIndex(db)).toBe(1)
      expect(searchEvents(db, { query: '重建前' }).hits).toHaveLength(1)
    })
  })
})

describe('querySearchHitEvents · 卡片下钻', () => {
  it('有 momentId 时复用时刻成员事件（与图谱侧栏同源）', () => {
    withDb((db) => {
      const t = at(22, 9)
      const e1 = seed(db, { ts: t, app: 'Code', title: 'a.ts', ocr: '甲' })
      const e2 = seed(db, { ts: t + 10_000, app: 'Code', title: 'a.ts', ocr: '乙' })
      db.prepare(
        `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
         VALUES (1, ?, ?, '2026-10-22', 'Code', 'a.ts', '甲乙', ?, 1)`
      ).run(t, t + 10_000, JSON.stringify([e1, e2]))
      const events = querySearchHitEvents(db, {
        momentId: 1,
        app: 'Code',
        windowTitle: 'a.ts',
        startTs: t,
        endTs: t + 10_000
      })
      expect(events.found).toBe(true)
      expect(events.events.map((event) => event.id)).toEqual([e1, e2])
    })
  })

  it('没有时刻时按 app + 标题 + 区间从 L0 现取（含标题归一化比较）', () => {
    withDb((db) => {
      const t = at(22, 9)
      const e1 = seed(db, { ts: t, app: 'Code', title: 'a.ts', ocr: '甲' })
      seed(db, { ts: t + 5_000, app: 'Code', title: 'a.ts', ocr: '乙' })
      seed(db, { ts: t + 6_000, app: 'Code', title: 'b.ts', ocr: '丙' })
      const events = querySearchHitEvents(db, {
        app: 'Code',
        windowTitle: 'a.ts',
        startTs: t,
        endTs: t + 30_000
      })
      expect(events.events).toHaveLength(2)
      expect(events.events[0].id).toBe(e1)
      expect(events.missingIds).toEqual([])

      const bad = querySearchHitEvents(db, { app: 'Code', startTs: t + 10, endTs: t })
      expect(bad.found).toBe(false)
    })
  })
})

describe('listSearchApps', () => {
  it('按事件量倒序返回应用名，空 app 不列', () => {
    withDb((db) => {
      seed(db, { ts: at(22, 9), app: 'Code', ocr: 'a' })
      seed(db, { ts: at(22, 10), app: 'Code', ocr: 'b' })
      seed(db, { ts: at(22, 11), app: 'Chrome', ocr: 'c' })
      seed(db, { ts: at(22, 12), app: '', ocr: 'd' })
      expect(listSearchApps(db)).toEqual(['Code', 'Chrome'])
    })
  })
})
