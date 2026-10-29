/**
 * 问记忆 · 自由文本答复（2026-10-29 拍板：不再强制填 JSON）
 *
 * 底线没变：引用要能在白名单里找到、编造的段号被剥掉、只说了「没找到」仍按没找到收口。
 * 变的是语气：ta 想聊天就聊天，不必为了通过校验硬凑一个 JSON。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import { parseChainReplyText, type CitationMeta } from '../../src/chain/agent/parse'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, openSegment, type ChainDb } from '../../src/chain/store'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'

const NOW = new Date(2026, 9, 29, 20, 0, 0, 0).getTime()
const at = (seconds: number): number => NOW + seconds * 1000

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

function seed(): number {
  const start = at(-600)
  const id = openSegment(
    db,
    { startTs: start, pid: 1, exe: 'app1', app: 'Firefox', hwnd: 10, title: '文档' },
    start
  )
  insertContent(db, { segmentId: id, capturedAt: start + 1_000, source: 'uia', text: '看文档' })
  closeSegment(db, id, {
    startTs: start,
    endTs: start + 60_000,
    activeMs: 60_000,
    idleMs: 0,
    pid: 1,
    exe: 'app1',
    app: 'Firefox',
    hwnd: 10,
    titleFirst: '文档',
    titleLast: '文档'
  })
  return id
}

function buildDeps(client: FakeLlmClient): ChainAskOptions {
  return {
    db,
    outbound: createCloudAskOutbound(),
    resolveClient: () => ({ ok: true, client }),
    now: () => NOW,
    captureRunning: () => false
  }
}

const meta = (id: number): Map<number, CitationMeta> =>
  new Map([[id, { segmentId: id, at: NOW, app: 'Firefox', title: '文档' }]])

describe('parseChainReplyText', () => {
  it('纯聊天：没有引用也是正常答复（不再变成「没找到」）', () => {
    const parsed = parseChainReplyText('在呢。今天想聊点什么？', new Map())
    expect(parsed).toMatchObject({ ok: true, kind: 'answer', citations: [] })
    if (parsed.ok && parsed.kind === 'answer') expect(parsed.answer).toBe('在呢。今天想聊点什么？')
  })

  it('[[段 12]] 变成引用，记号从正文里去掉；编造的段号被剥掉', () => {
    const parsed = parseChainReplyText(
      '17:57 的〈Firefox〉里在看文档 [[段 12]]。另一段是编的 [[段 999999]]',
      meta(12)
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'answer') return
    expect(parsed.citations.map((item) => item.segmentId)).toEqual([12])
    expect(parsed.citations[0]).toMatchObject({ app: 'Firefox', at: NOW })
    expect(parsed.answer).not.toContain('[[段')
    expect(parsed.answer).toContain('看文档')
  })

  it('[[日记 7]] 走日记白名单；没有白名单时整条丢掉', () => {
    const memoryMeta = new Map([
      [7, { itemId: 7, day: '2026-10-28', section: 'Diary', text: '今天早上有点困' }]
    ])
    const withWhitelist = parseChainReplyText('你说过早上有点困 [[日记 7]]', meta(12), {
      memoryMeta
    })
    expect(withWhitelist.ok).toBe(true)
    if (withWhitelist.ok && withWhitelist.kind === 'answer') {
      expect(withWhitelist.memories.map((item) => item.itemId)).toEqual([7])
      expect(withWhitelist.answer).not.toContain('[[日记')
    }
    const without = parseChainReplyText('你说过早上有点困 [[日记 7]]', meta(12))
    expect(without.ok && without.kind === 'answer' && without.memories.length === 0).toBe(true)
  })

  it('只说了「信息链里没找到」仍按没找到收口（不把它当回答）', () => {
    expect(parseChainReplyText('信息链里没找到', new Map())).toMatchObject({
      ok: false,
      reason: 'no-citations'
    })
    expect(parseChainReplyText('信息链里没找到。', new Map())).toMatchObject({
      ok: false,
      reason: 'no-citations'
    })
  })

  it('去掉记号后不留下空括号 / 多余空格', () => {
    const parsed = parseChainReplyText('我在（[[段 12]]）看到过这个', meta(12))
    expect(parsed.ok && parsed.kind === 'answer' && parsed.answer).toBe('我在看到过这个')
  })

  it('空答复算结构不对', () => {
    expect(parseChainReplyText('   ', new Map())).toMatchObject({ ok: false, reason: 'shape' })
  })
})

describe('askChain · 自由文本收口', () => {
  it('寒暄：模型直接说话，不再落成「没找到」', async () => {
    seed()
    const client = new FakeLlmClient([{ json: '你好呀，我在。' }])
    const result = await askChain(buildDeps(client), '你好')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.answer).toContain('你好呀')
    expect(result.citations).toEqual([])
  })

  it('自由文本 + [[段 id]]：引用带上服务端事实；编造的剥掉', async () => {
    const id = seed()
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'search_info', arguments: { keywords: ['文档'] } }] },
      { json: `08:50 的〈Firefox〉在看文档 [[段 ${id}]]，还有一段编的 [[段 999999]]` }
    ])
    const result = await askChain(buildDeps(client), '我刚才在看什么')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((item) => item.segmentId)).toEqual([id])
    expect(result.answer).not.toContain('[[段')
  })
})
