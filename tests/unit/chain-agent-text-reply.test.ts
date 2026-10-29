/**
 * 问记忆 · 自由文本答复（2026-10-29 晚，DSH 式）
 *
 * ta 直接说话；引用不再靠模型在正文里标记号，而是由 read_segment / read_diary 的
 * 「已读」记录自动带出。文本层只负责把旧记号从显示里剥掉，不再拿它算引用；
 * 也不再做「空括号 / 连续空格」的全局清洗（会改坏代码）。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import { parseChainReplyText } from '../../src/chain/agent/parse'
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

describe('parseChainReplyText', () => {
  it('纯聊天：没有引用也是正常答复', () => {
    const parsed = parseChainReplyText('在呢。今天想聊点什么？')
    expect(parsed).toMatchObject({ ok: true, kind: 'answer', citations: [] })
    if (parsed.ok && parsed.kind === 'answer') expect(parsed.answer).toBe('在呢。今天想聊点什么？')
  })

  it('旧记号从正文里剥掉，不再产生引用', () => {
    const parsed = parseChainReplyText(
      '17:57 的〈Firefox〉里在看文档 [[段 12]]。另一段是编的 [[段 999999]]'
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'answer') return
    expect(parsed.citations).toEqual([])
    expect(parsed.answer).not.toContain('[[段')
    expect(parsed.answer).toContain('看文档')
  })

  it('旧日记记号也从正文里剥掉，不再产生 memories', () => {
    const parsed = parseChainReplyText('你说过早上有点困 [[日记 7]]')
    expect(parsed.ok && parsed.kind === 'answer' && parsed.answer).toBe('你说过早上有点困')
    if (parsed.ok && parsed.kind === 'answer') expect(parsed.memories).toEqual([])
  })

  it('只说了「信息链里没找到」仍然是文本，由循环层收口', () => {
    expect(parseChainReplyText('信息链里没找到')).toMatchObject({ ok: true, kind: 'answer' })
    expect(parseChainReplyText('信息链里没找到。')).toMatchObject({ ok: true, kind: 'answer' })
  })

  it('拆掉引用外层括号，但不改正文里的空括号与缩进', () => {
    const parsed = parseChainReplyText('我在（[[段 12]]）看到过这个；代码是 `.keys()`')
    expect(parsed.ok && parsed.kind === 'answer' && parsed.answer).toBe('我在看到过这个；代码是 `.keys()`')

    const code = parseChainReplyText('```python\n    f.write(x)\n```')
    expect(code.ok && code.kind === 'answer' && code.answer).toContain('    f.write(x)')
  })

  it('空答复算结构不对', () => {
    expect(parseChainReplyText('   ')).toMatchObject({ ok: false, reason: 'shape' })
  })
})

describe('askChain · 自动引用（DSH 式）', () => {
  it('寒暄：模型直接说话，无引用也正常', async () => {
    seed()
    const client = new FakeLlmClient([{ json: '你好呀，我在。' }])
    const result = await askChain(buildDeps(client), '你好')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.answer).toContain('你好呀')
    expect(result.citations).toEqual([])
  })

  it('read_segment 打开过的段自动成为引用；正文不写记号也行', async () => {
    const id = seed()
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'search_info', arguments: { keywords: ['文档'] } }] },
      { toolCalls: [{ name: 'read_segment', arguments: { segmentId: id } }] },
      { json: '08:50 的〈Firefox〉在看文档' }
    ])
    const result = await askChain(buildDeps(client), '我刚才在看什么')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((item) => item.segmentId)).toEqual([id])
    expect(result.citations[0]).toMatchObject({ app: 'Firefox', at: at(-600) })
    expect(result.answer).not.toContain('[[段')
  })

  it('模型写引用了但没打开正文：不算引用，记号也不留在正文', async () => {
    const id = seed()
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'search_info', arguments: { keywords: ['文档'] } }] },
      { json: `08:50 的〈Firefox〉在看文档 [[段 ${id}]]，还有一段编的 [[段 999999]]` }
    ])
    const result = await askChain(buildDeps(client), '我刚才在看什么')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations).toEqual([])
    expect(result.answer).not.toContain('[[段')
  })
})
