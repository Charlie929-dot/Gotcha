import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import {
  closeSegment,
  dayKeyOf,
  getSegmentDetail,
  insertContent,
  insertEvent,
  insertShot,
  openSegment,
  type ChainDb
} from '../../src/chain/store'
import {
  insertLink,
  putSegmentVector,
  replaceSegmentLinks,
  replaceSegmentTags,
  setLinkAliases
} from '../../src/chain/derive/store'
import {
  buildSnippet,
  despaceSearchText,
  searchChainSegments
} from '../../src/chain/query'

const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const MINUTE = 60_000

let db: ChainDb
let seq = 0

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
  seq = 0
})

afterEach(() => {
  db.close()
})

interface SegmentInput {
  app: string
  title: string
  startTs: number
  /** 默认收口（30s 的段） */
  open?: boolean
}

function segment(input: SegmentInput): number {
  const id = openSegment(
    db,
    { startTs: input.startTs, pid: 100 + seq++, exe: `${input.app}.exe`, app: input.app, hwnd: 200 + seq, title: input.title },
    input.startTs
  )
  if (input.open !== true) {
    closeSegment(db, id, {
      startTs: input.startTs,
      endTs: input.startTs + 30_000,
      activeMs: 30_000,
      idleMs: 0,
      pid: 100,
      exe: `${input.app}.exe`,
      app: input.app,
      hwnd: 200,
      titleFirst: input.title,
      titleLast: input.title
    })
  }
  return id
}

function content(segmentId: number, text: string, capturedAt: number, source: 'uia' | 'ocr' = 'uia'): number {
  return insertContent(db, { segmentId, capturedAt, source, text })
}

function vector(segmentId: number, values: number[]): void {
  putSegmentVector(db, {
    segmentId,
    model: 'fake-embedding-v1',
    vec: new Float32Array(values),
    textHash: `h${segmentId}`,
    contentMaxId: 1
  })
}

/** 四维查询向量：与 `[1,0,0,0]` 的余弦依次是 1 / 0.8 / 0.6 / 0 */
const QUERY_VECTOR = new Float32Array([1, 0, 0, 0])

describe('buildSnippet', () => {
  it('OCR 逐字空格形态：查询不带空格也能在原文里定位，摘要保留原文', () => {
    const snippet = buildSnippet('记 忆 球 的 设 计 草 案', '记忆球')
    expect(snippet).toBe('记 忆 球 的 设 计 草 案')
  })

  it('长文本只截关键词两侧并加省略号', () => {
    const text = `${'前'.repeat(100)}目标词${'后'.repeat(100)}`
    const snippet = buildSnippet(text, '目标词', 10)
    expect(snippet).toBe(`…${'前'.repeat(10)}目标词${'后'.repeat(10)}…`)
  })

  it('查不到 / 空查询返回 null', () => {
    expect(buildSnippet('甲乙丙', '丁戊')).toBeNull()
    expect(buildSnippet('甲乙丙', '   ')).toBeNull()
  })

  it('去空白口径与 SQL 侧一致（全角空格 / NBSP / Tab）', () => {
    expect(despaceSearchText('记\u3000忆\u00a0球\t测\n试')).toBe('记忆球测试')
  })
})

describe('searchChainSegments · 关键词', () => {
  it('中文逐字空格形态能命中，结果带内容 id 与摘要', () => {
    const id = segment({ app: 'Firefox', title: '记忆球设计', startTs: T0 })
    const contentId = content(id, '记 忆 球 的 设 计 草 案', T0 + 1_000, 'ocr')

    const result = searchChainSegments(db, { text: '记忆球' })
    expect(result.stats.mode).toBe('keyword')
    expect(result.stats.keywordRows).toBe(1)
    expect(result.hits.map((hit) => hit.segment.id)).toEqual([id])
    expect(result.hits[0].matches).toBe(1)
    expect(result.hits[0].contentIds).toEqual([contentId])
    expect(result.hits[0].snippet).toContain('记 忆 球')
  })

  it('% 与 _ 按字面匹配，不当通配符', () => {
    const hitSeg = segment({ app: 'Firefox', title: '百分比', startTs: T0 })
    content(hitSeg, '覆盖率 100% 完成', T0 + 1_000)
    const otherSeg = segment({ app: 'Firefox', title: '近义', startTs: T0 + MINUTE })
    content(otherSeg, '覆盖率 1005 完成', T0 + MINUTE + 1_000)

    expect(searchChainSegments(db, { text: '100%' }).hits.map((hit) => hit.segment.id)).toEqual([hitSeg])
    expect(searchChainSegments(db, { text: '100_' }).hits).toEqual([])
    // 反斜杠本身也按字面
    expect(searchChainSegments(db, { text: '\\' }).hits).toEqual([])
  })

  it('同一段命中几条算几条：先按命中条数排，再按最近命中时刻排', () => {
    const many = segment({ app: 'Obsidian', title: '多命中', startTs: T0 })
    content(many, '检索入口的第一条', T0 + 1_000)
    content(many, '检索入口的第二条', T0 + 2_000)
    const oneOld = segment({ app: 'Firefox', title: '单命中旧', startTs: T0 + 10 * MINUTE })
    content(oneOld, '检索入口', T0 + 10 * MINUTE + 1_000)
    const oneNew = segment({ app: 'Firefox', title: '单命中新', startTs: T0 + 20 * MINUTE })
    content(oneNew, '检索入口', T0 + 20 * MINUTE + 1_000)

    const hits = searchChainSegments(db, { text: '检索入口' }).hits
    expect(hits.map((hit) => hit.segment.id)).toEqual([many, oneNew, oneOld])
    expect(hits[0].contentIds).toHaveLength(2)
  })

  it('没有关键词命中时不硬凑：空结果', () => {
    const id = segment({ app: 'Firefox', title: '别的', startTs: T0 })
    content(id, '完全无关的正文', T0 + 1_000)
    expect(searchChainSegments(db, { text: '检索入口' }).hits).toEqual([])
  })
})

describe('searchChainSegments · 向量', () => {
  it('按余弦降序，minSimilarity 是硬下限', () => {
    const a = segment({ app: 'Firefox', title: 'A', startTs: T0 })
    const b = segment({ app: 'Firefox', title: 'B', startTs: T0 + MINUTE })
    const c = segment({ app: 'Firefox', title: 'C', startTs: T0 + 2 * MINUTE })
    vector(a, [1, 0, 0, 0])
    vector(b, [0.8, 0.6, 0, 0])
    vector(c, [0, 1, 0, 0])

    const all = searchChainSegments(db, { vector: QUERY_VECTOR })
    expect(all.stats.mode).toBe('vector')
    expect(all.hits.map((hit) => hit.segment.id)).toEqual([a, b, c])
    expect(all.hits[0].similarity).toBeCloseTo(1, 5)
    expect(all.hits[1].similarity).toBeCloseTo(0.8, 5)

    const filtered = searchChainSegments(db, { vector: QUERY_VECTOR, minSimilarity: 0.5 })
    expect(filtered.hits.map((hit) => hit.segment.id)).toEqual([a, b])
  })

  it('换模型（维度不同）与坏字节的向量行不参与比较，但在统计里如实计数', () => {
    const good = segment({ app: 'Firefox', title: '好向量', startTs: T0 })
    vector(good, [1, 0, 0, 0])
    const otherDim = segment({ app: 'Firefox', title: '别的模型', startTs: T0 + MINUTE })
    vector(otherDim, [1, 0, 0, 0, 0, 0, 0, 0])
    const corrupt = segment({ app: 'Firefox', title: '坏行', startTs: T0 + 2 * MINUTE })
    db.prepare(
      `INSERT INTO chain_vector (segment_id, model, dim, vec, text_hash, content_max_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(corrupt, 'fake-embedding-v1', 4, Buffer.from([1, 2, 3]), 'bad', 1)

    const result = searchChainSegments(db, { vector: QUERY_VECTOR })
    expect(result.hits.map((hit) => hit.segment.id)).toEqual([good])
    expect(result.stats.vectors).toBe(1)
    expect(result.stats.skippedVectors).toBe(2)
  })
})

describe('searchChainSegments · 混合（RRF）', () => {
  it('两路都命中的段排在只命中一路的前面', () => {
    const both = segment({ app: 'Firefox', title: '两路都中', startTs: T0 })
    content(both, '共享关键词 第一段', T0 + 1_000)
    vector(both, [1, 0, 0, 0])

    const vectorOnly = segment({ app: 'Firefox', title: '只向量', startTs: T0 + 5 * MINUTE })
    vector(vectorOnly, [0.9, Math.sqrt(1 - 0.81), 0, 0])

    const keywordOnly = segment({ app: 'Firefox', title: '只关键词', startTs: T0 + 10 * MINUTE })
    content(keywordOnly, '共享关键词 第二段', T0 + 10 * MINUTE + 1_000)


    const result = searchChainSegments(db, { text: '共享关键词', vector: QUERY_VECTOR })
    expect(result.stats.mode).toBe('hybrid')
    expect(result.hits.map((hit) => hit.segment.id)).toEqual([both, keywordOnly, vectorOnly])
    expect(result.hits[0].similarity).toBeCloseTo(1, 5)
    expect(result.hits[0].matches).toBe(1)
    expect(result.hits[1].similarity).toBeNull()
    expect(result.hits[2].matches).toBe(0)
  })
})

describe('searchChainSegments · 过滤', () => {
  it('时间窗口 / 日期 / 应用', () => {
    const old = segment({ app: 'Firefox', title: '旧段', startTs: T0 })
    content(old, '共同词 旧', T0 + 1_000)
    const recent = segment({ app: 'Obsidian', title: '新段', startTs: T0 + 30 * MINUTE })
    content(recent, '共同词 新', T0 + 30 * MINUTE + 1_000)

    expect(
      searchChainSegments(db, { text: '共同词', from: T0 + 10 * MINUTE }).hits.map((hit) => hit.segment.id)
    ).toEqual([recent])
    expect(
      searchChainSegments(db, { text: '共同词', to: T0 + 10 * MINUTE }).hits.map((hit) => hit.segment.id)
    ).toEqual([old])
    expect(searchChainSegments(db, { text: '共同词', app: 'Obsidian' }).hits.map((hit) => hit.segment.id)).toEqual([
      recent
    ])
    expect(searchChainSegments(db, { dayKey: dayKeyOf(T0) }).hits).toHaveLength(2)
    expect(searchChainSegments(db, { dayKey: '1999-01-01' }).hits).toEqual([])
  })

  it('开着（未收口）的段默认不算，includeOpen 才纳入', () => {
    const openId = segment({ app: 'Firefox', title: '开着的段', startTs: T0, open: true })
    content(openId, '开着的正文', T0 + 1_000)

    expect(searchChainSegments(db, { text: '开着的正文' }).hits).toEqual([])
    expect(
      searchChainSegments(db, { text: '开着的正文', includeOpen: true }).hits.map((hit) => hit.segment.id)
    ).toEqual([openId])
  })

  it('标签按归一后同名匹配（大小写 / 空白 / 两侧标点不影响），没有的名字给空结果', () => {
    const id = segment({ app: 'Firefox', title: '打标签', startTs: T0 })
    replaceSegmentTags(db, id, [{ name: '记忆系统设计', source: 'llm' }])

    expect(searchChainSegments(db, { tag: '记忆系统 设计' }).hits.map((hit) => hit.segment.id)).toEqual([id])
    expect(searchChainSegments(db, { tag: '「记忆系统设计」' }).hits.map((hit) => hit.segment.id)).toEqual([id])
    expect(searchChainSegments(db, { tag: '不存在的标签' }).hits).toEqual([])
  })

  it('双链名与别名都能命中', () => {
    const id = segment({ app: 'Firefox', title: '挂双链', startTs: T0 })
    const linkId = insertLink(db, '信息链')
    setLinkAliases(db, linkId, ['信息链条'])
    replaceSegmentLinks(db, id, [{ linkId, weight: 1 }])

    expect(searchChainSegments(db, { link: '信息链' }).hits.map((hit) => hit.segment.id)).toEqual([id])
    expect(searchChainSegments(db, { link: '信息链条' }).hits.map((hit) => hit.segment.id)).toEqual([id])
    expect(searchChainSegments(db, { link: '别的双链' }).hits).toEqual([])
  })

  it('纯过滤按开始时间倒序、score 为 0；什么都不给则空结果（不倒整库）', () => {
    const a = segment({ app: 'Firefox', title: '先', startTs: T0 })
    const b = segment({ app: 'Firefox', title: '后', startTs: T0 + MINUTE })

    const result = searchChainSegments(db, { app: 'Firefox' })
    expect(result.stats.mode).toBe('filter')
    expect(result.hits.map((hit) => hit.segment.id)).toEqual([b, a])
    expect(result.hits[0].score).toBe(0)

    expect(searchChainSegments(db, {}).hits).toEqual([])
    expect(searchChainSegments(db, { app: 'Firefox', limit: 1 }).hits.map((hit) => hit.segment.id)).toEqual([b])
  })
})

describe('searchChainSegments · 证据反查', () => {
  it('命中带的字段够顺着段查回事件 / 截图 / 原文', () => {
    const id = segment({ app: 'Firefox', title: '证据段', startTs: T0 })
    const contentId = content(id, '可核验的原文', T0 + 1_000)
    const eventId = insertEvent(db, { segmentId: id, ts: T0 + 900, kind: 'click_left', x: 10, y: 20 })
    const shotId = insertShot(db, {
      segmentId: id,
      eventId,
      ts: T0 + 900,
      path: 'shots/s1.png',
      source: 'event'
    })

    const hit = searchChainSegments(db, { text: '可核验' }).hits[0]
    expect(hit.contentIds).toEqual([contentId])
    expect(hit.counts).toEqual({ events: 1, shots: 1, contents: 1 })

    const detail = getSegmentDetail(db, hit.segment.id)
    expect(detail?.events.map((event) => event.id)).toEqual([eventId])
    expect(detail?.shots.map((shot) => shot.id)).toEqual([shotId])
    expect(detail?.contents.map((row) => row.id)).toEqual([contentId])
  })
})
