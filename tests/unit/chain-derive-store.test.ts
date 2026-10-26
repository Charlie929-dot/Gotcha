import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import {
  closeSegment,
  contentHash,
  insertContent,
  openSegment,
  type ChainDb
} from '../../src/chain/store'
import {
  deleteDeriveMarker,
  deleteSegmentVector,
  getDeriveMarker,
  getSegmentVector,
  insertLink,
  listLinks,
  listPendingDeriveSegments,
  listSegmentLinks,
  listSegmentTags,
  listTagNames,
  packVector,
  putDeriveMarker,
  putSegmentVector,
  replaceSegmentLinks,
  replaceSegmentTags,
  setLinkAliases,
  unpackVector
} from '../../src/chain/derive/store'

const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

/** 开一段并收口，返回段 id */
function closedSegment(startTs = T0): number {
  const id = openSegment(
    db,
    { startTs, pid: 100, exe: 'firefox', app: 'Firefox', hwnd: 200, title: 'A' },
    startTs
  )
  closeSegment(db, id, {
    startTs,
    endTs: startTs + 60_000,
    activeMs: 60_000,
    idleMs: 0,
    pid: 100,
    exe: 'firefox',
    app: 'Firefox',
    hwnd: 200,
    titleFirst: 'A',
    titleLast: 'A'
  })
  return id
}

function content(segmentId: number, text: string, at = T0 + 1_000): number {
  return insertContent(db, { segmentId, capturedAt: at, source: 'uia', text })
}

describe('待派生队列', () => {
  it('只列已收口、有内容、且向量/抽取落后于内容水位的段', () => {
    const closedId = closedSegment(T0)
    const emptyClosed = closedSegment(T0 + 60_000)
    const contentId = content(closedId, '收口之后才读到的内容', T0 + 1_000)
    // 还开着的段：有内容也不进队列
    const openStart = T0 + 120_000
    const openId = openSegment(
      db,
      { startTs: openStart, pid: 1, exe: 'a', app: 'A', hwnd: 1, title: 'A' },
      openStart
    )
    content(openId, '还开着的段', openStart + 1_000)

    const pending = listPendingDeriveSegments(db, { includeExtract: false })
    expect(pending.map((row) => row.segmentId)).toEqual([closedId])
    expect(pending[0]).toMatchObject({ maxContentId: contentId, vectorTextHash: null })

    putSegmentVector(db, {
      segmentId: closedId,
      model: 'fake',
      vec: new Float32Array([1, 0]),
      textHash: 'h1',
      contentMaxId: contentId
    })
    expect(listPendingDeriveSegments(db, { includeExtract: true }).map((row) => row.segmentId)).toEqual([
      closedId
    ])
    putDeriveMarker(db, { segmentId: closedId, textHash: 'h1', contentMaxId: contentId, derivedAt: 1 })
    expect(listPendingDeriveSegments(db, { includeExtract: true })).toEqual([])

    // 又读回来一条内容 → 水位落后，重新进队列
    const laterContent = content(closedId, '又一条内容', T0 + 2_000)
    expect(listPendingDeriveSegments(db, { includeExtract: true })[0]).toMatchObject({
      segmentId: closedId,
      maxContentId: laterContent,
      vectorContentMaxId: contentId
    })
    expect(emptyClosed).toBeGreaterThan(0)
  })

  it('最近优先，limit 生效', () => {
    const starts = [T0, T0 + 60_000, T0 + 120_000]
    const ids = starts.map((start) => closedSegment(start))
    ids.forEach((id, index) => content(id, `段 ${id} 的内容`, starts[index] + 1_000))
    expect(listPendingDeriveSegments(db, { includeExtract: false, limit: 2 }).map((row) => row.segmentId)).toEqual([
      ids[2],
      ids[1]
    ])
  })

  it('未确认出网时只列向量待办：抽过但没向量的段仍会进队列', () => {
    const id = closedSegment()
    const contentId = content(id, '内容')
    // 有抽取进度、没有向量（模型缺失时可能出现）
    putDeriveMarker(db, { segmentId: id, textHash: 'h', contentMaxId: contentId, derivedAt: 1 })
    expect(listPendingDeriveSegments(db, { includeExtract: false }).map((row) => row.segmentId)).toEqual([id])
  })
})

describe('向量', () => {
  it('写入 / 读回 Float32Array，模型与水位一起存', () => {
    const id = closedSegment()
    const vec = new Float32Array([0.5, -0.25, 0.125])
    putSegmentVector(db, { segmentId: id, model: 'bge', vec, textHash: 'abc', contentMaxId: 7 })
    const stored = getSegmentVector(db, id)
    expect(stored).toMatchObject({ model: 'bge', dim: 3, textHash: 'abc', contentMaxId: 7 })
    expect(Array.from(stored?.vec ?? [])).toEqual([0.5, -0.25, 0.125])
    // 覆盖写
    putSegmentVector(db, { segmentId: id, model: 'bge', vec: new Float32Array([1, 1, 1]), textHash: 'def', contentMaxId: 9 })
    expect(getSegmentVector(db, id)?.contentMaxId).toBe(9)
    deleteSegmentVector(db, id)
    expect(getSegmentVector(db, id)).toBeNull()
  })

  it('坏行（字节数与维度对不上）读回 null，不抛错', () => {
    expect(unpackVector(Buffer.from([1, 2, 3]), 2)).toBeNull()
    expect(unpackVector(null, 2)).toBeNull()
    const id = closedSegment()
    db.prepare('INSERT INTO chain_vector (segment_id, model, dim, vec, text_hash) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'bge',
      4,
      Buffer.from([1, 2, 3]),
      'x'
    )
    expect(getSegmentVector(db, id)).toBeNull()
  })

  it('packVector 与输入不共享 buffer', () => {
    const vec = new Float32Array([1, 2])
    const buf = packVector(vec)
    vec[0] = 9
    expect(Array.from(new Float32Array(buf.buffer, buf.byteOffset, 2))).toEqual([1, 2])
  })
})

describe('抽取进度', () => {
  it('写入 / 覆盖 / 删除', () => {
    const id = closedSegment()
    putDeriveMarker(db, { segmentId: id, textHash: 'a', contentMaxId: 1, derivedAt: 10 })
    putDeriveMarker(db, { segmentId: id, textHash: 'b', contentMaxId: 2, derivedAt: 20 })
    expect(getDeriveMarker(db, id)).toMatchObject({ text_hash: 'b', content_max_id: 2, derived_at: 20 })
    deleteDeriveMarker(db, id)
    expect(getDeriveMarker(db, id)).toBeNull()
  })
})

describe('标签', () => {
  it('整段替换、大小写去重、列出已有名字', () => {
    const id = closedSegment()
    replaceSegmentTags(db, id, [
      { name: '记忆球', source: 'llm' },
      { name: '记忆球', source: 'llm' },
      { name: 'Hindsight', source: 'llm' }
    ])
    expect(listSegmentTags(db, id).map((tag) => tag.name)).toEqual(['记忆球', 'Hindsight'])
    replaceSegmentTags(db, id, [{ name: '信息链', source: 'llm' }])
    expect(listSegmentTags(db, id).map((tag) => tag.name)).toEqual(['信息链'])
    const other = closedSegment(T0 + 60_000)
    replaceSegmentTags(db, other, [{ name: '记忆球', source: 'llm' }])
    expect(listTagNames(db)).toEqual(['信息链', '记忆球'].sort())
  })

  it('空名字直接抛错（不写坏行）', () => {
    const id = closedSegment()
    expect(() => replaceSegmentTags(db, id, [{ name: '  ', source: 'llm' }])).toThrow(/不能为空/)
    expect(listSegmentTags(db, id)).toEqual([])
  })
})

describe('双链', () => {
  it('同名唯一，重复插入返回同一个 id', () => {
    const a = insertLink(db, '记忆球')
    const b = insertLink(db, ' 记忆球 ')
    expect(b).toBe(a)
    expect(insertLink(db, '信息链')).not.toBe(a)
    expect(listLinks(db).map((link) => link.name)).toEqual(['记忆球', '信息链'])
  })

  it('别名去重去空；坏 JSON 当作没有别名', () => {
    const id = insertLink(db, 'DeepSeek Harness')
    setLinkAliases(db, id, ['DeepSeek', ' deepseek ', ''])
    expect(listLinks(db)[0].aliases).toEqual(['DeepSeek'])
    db.prepare('UPDATE chain_link SET aliases = ? WHERE id = ?').run('{bad', id)
    expect(listLinks(db)[0].aliases).toEqual([])
  })

  it('段-双链关系整段替换、按 link 去重、权重校验', () => {
    const segment = closedSegment()
    const a = insertLink(db, '记忆球')
    const b = insertLink(db, '信息链')
    replaceSegmentLinks(db, segment, [
      { linkId: a, weight: 1 },
      { linkId: a, weight: 0.5 },
      { linkId: b, weight: 0.9 }
    ])
    expect(listSegmentLinks(db, segment)).toEqual([
      { linkId: a, name: '记忆球', weight: 1 },
      { linkId: b, name: '信息链', weight: 0.9 }
    ])
    replaceSegmentLinks(db, segment, [{ linkId: b, weight: 1 }])
    expect(listSegmentLinks(db, segment).map((link) => link.name)).toEqual(['信息链'])
    expect(() => replaceSegmentLinks(db, segment, [{ linkId: a, weight: 2 }])).toThrow(/权重/)
    expect(() => replaceSegmentLinks(db, segment, [{ linkId: 0, weight: 1 }])).toThrow(/id 不合法/)
  })
})
