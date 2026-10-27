import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSegmentEvidence } from '../../src/chain/agent/evidence'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, insertShot, openSegment, type ChainDb } from '../../src/chain/store'
import { insertLink, replaceSegmentLinks, replaceSegmentTags } from '../../src/chain/derive/store'

/** 本地 2026-10-27 09:00 */
const T0 = new Date(2026, 9, 27, 9, 0, 0, 0).getTime()
const at = (seconds: number): number => T0 + seconds * 1000

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function seedSegment(): number {
  const draft = {
    startTs: at(0),
    pid: 1,
    exe: 'firefox.exe',
    app: 'Firefox',
    hwnd: 10,
    title: '编译报错 — 文档'
  }
  const id = openSegment(db, draft, at(0))
  insertContent(db, { segmentId: id, capturedAt: at(1), source: 'uia', text: '第一版正文：报 LNK1104' })
  insertContent(db, { segmentId: id, capturedAt: at(2), source: 'ocr', text: '第二版正文：改了链接顺序' })
  closeSegment(db, id, {
    ...draft,
    endTs: at(120),
    activeMs: at(120) - at(0),
    idleMs: 0,
    titleFirst: draft.title,
    titleLast: '编译报错 — 已解决'
  })
  return id
}

describe('段证据（引用点开）', () => {
  it('给出段事实 + 内容片段 + 标签 / 双链', () => {
    const id = seedSegment()
    replaceSegmentTags(db, id, [{ name: '编译问题', source: 'llm' }])
    replaceSegmentLinks(db, id, [{ linkId: insertLink(db, 'Rust 工具链'), weight: 1 }])

    const evidence = readSegmentEvidence(db, id)
    expect(evidence).not.toBeNull()
    expect(evidence).toMatchObject({
      segmentId: id,
      app: 'Firefox',
      title: '编译报错 — 已解决',
      startTs: at(0),
      endTs: at(120),
      activeMs: 120_000
    })
    // 内容按时间倒序、最新的在前
    expect(evidence?.contents.map((row) => row.text)).toEqual([
      '第二版正文：改了链接顺序',
      '第一版正文：报 LNK1104'
    ])
    expect(evidence?.tags).toEqual(['编译问题'])
    expect(evidence?.links).toEqual(['Rust 工具链'])
  })

  it('截图经注入的读取器变成 data URL；读不到就是 null', () => {
    const id = seedSegment()
    insertShot(db, { segmentId: id, ts: at(3), path: 'shots/a.jpg', width: 1920, height: 1080, source: 'enter' })
    insertShot(db, { segmentId: id, ts: at(4), path: 'shots/b.jpg', source: 'event' })
    // 归档进容器的没有文件路径
    insertShot(db, { segmentId: id, ts: at(5), container: '2026-10-27-cold.cgar', source: 'event' })

    const evidence = readSegmentEvidence(db, id, {
      readShot: (path) => (path.endsWith('a.jpg') ? 'data:image/jpeg;base64,AAA' : null)
    })
    expect(evidence?.shots.map((shot) => shot.dataUrl)).toEqual([null, 'data:image/jpeg;base64,AAA'])
    // 容器里的那张不进列表
    expect(evidence?.shots).toHaveLength(2)
  })

  it('段不存在返回 null（不抛）', () => {
    expect(readSegmentEvidence(db, 999_999)).toBeNull()
  })

  it('正文按上限截断', () => {
    const longText = '很长的正文'.repeat(40)
    const draft = { startTs: at(0), pid: 2, exe: 'a', app: 'A', hwnd: 20, title: '长文' }
    const id = openSegment(db, draft, at(0))
    insertContent(db, { segmentId: id, capturedAt: at(1), source: 'uia', text: longText })
    closeSegment(db, id, {
      ...draft,
      endTs: at(10),
      activeMs: at(10) - at(0),
      idleMs: 0,
      titleFirst: draft.title,
      titleLast: draft.title
    })
    const evidence = readSegmentEvidence(db, id, { textChars: 80 })
    const text = evidence?.contents[0].text ?? ''
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBe(81)
  })
})
