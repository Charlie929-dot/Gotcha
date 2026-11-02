/**
 * QQ 表情 / 发图工具（D96 / PR2）
 *
 * 守这些事：`send_sticker` 不带 id 只给图鉴、带 id 才排一张；表情 / 图片每轮各最多一张；
 * `save_sticker` 只收本会话里真出现过的图；`send_image` 只认归档 id；
 * 媒体只挂在「有正文的回答」上；图片 id 进用户消息 JSON（这一轮就能收 / 发）。
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import { archiveIdOfImage } from '../../src/chain/agent/archive'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import type { QqStickerToolDeps, QqStickerView } from '../../src/chain/agent/tools'
import { askLoopToolsFor, buildChainAskLoopMessages } from '../../src/understand/cloud/deepseek'
import { FakeLlmClient, type LlmClient } from '../../src/understand/cloud/llm-client'

const NOW = new Date(2026, 10, 1, 22, 0, 0, 0).getTime()

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const TINY_PNG_ID = archiveIdOfImage(TINY_PNG)

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

interface FakeStickerPort extends QqStickerToolDeps {
  picked: string[]
  saved: { dataUrl: string; label: string; desc?: string }[]
}

function stickerPort(entries: readonly QqStickerView[] = []): FakeStickerPort {
  const picked: string[] = []
  const saved: { dataUrl: string; label: string; desc?: string }[] = []
  return {
    picked,
    saved,
    list: () => entries,
    pick: (id) => {
      const view = entries.find((entry) => entry.id === id)
      if (view === undefined) return null
      picked.push(id)
      return { view, dataUrl: TINY_PNG }
    },
    save: (input) => {
      saved.push(input)
      return { ok: true, id: 'ffffffffffff', label: input.label, duplicate: false }
    }
  }
}

const STICKER: QqStickerView = {
  id: 'a1b2c3d4e5f6',
  label: '无语',
  desc: '被问住的时候',
  tags: ['无语'],
  useCount: 3
}

function buildDeps(client: LlmClient, extra: Partial<ChainAskOptions> = {}): ChainAskOptions {
  return {
    db,
    outbound: createLocalAskOutbound(),
    resolveClient: () => ({ ok: true, client }),
    now: () => NOW,
    captureRunning: () => false,
    ...extra
  }
}

describe('send_sticker（D96 / PR2）', () => {
  it('不带 id：只给图鉴，什么都不发', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'send_sticker', arguments: {} }] },
      { json: { answer: '我挑一张。', citations: [] } }
    ])
    const port = stickerPort([STICKER])
    const result = await askChain(
      buildDeps(client, { tools: ['send_sticker'], stickers: port }),
      '发个无语的表情'
    )
    expect(result.kind).toBe('answer')
    expect(result.outboundMedia).toBeUndefined()
    expect(port.picked).toHaveLength(0)
    const turn = client.askLoopRequests[1]?.turns[0]
    expect(turn?.toolResult).toMatchObject({
      kind: 'send_sticker',
      ok: true,
      stickerId: null
    })
    const catalog = (turn?.toolResult as { catalog?: unknown[] }).catalog ?? []
    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({ id: 'a1b2c3d4e5f6', label: '无语' })
  })

  it('带 id：排一张，回答之后跟着发（outboundMedia 带 id 做 24h 去重）', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'send_sticker', arguments: { id: 'a1b2c3d4e5f6' } }] },
      { json: { answer: '（翻了个白眼）', citations: [] } }
    ])
    const port = stickerPort([STICKER])
    const result = await askChain(
      buildDeps(client, { tools: ['send_sticker'], stickers: port }),
      '发个无语的表情'
    )
    expect(port.picked).toEqual(['a1b2c3d4e5f6'])
    expect(result.outboundMedia).toHaveLength(1)
    expect(result.outboundMedia?.[0]).toMatchObject({
      kind: 'sticker',
      dataUrl: TINY_PNG,
      label: '无语',
      ref: 'a1b2c3d4e5f6'
    })
  })

  it('一轮只挑一张表情：第二张给错误，结果里只有第一张', async () => {
    const client = new FakeLlmClient([
      {
        toolCalls: [
          { name: 'send_sticker', arguments: { id: 'a1b2c3d4e5f6' } },
          { name: 'send_sticker', arguments: { id: 'a1b2c3d4e5f6' } }
        ]
      },
      { json: { answer: '就这样。', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, { tools: ['send_sticker'], stickers: stickerPort([STICKER]) }),
      '来一张'
    )
    expect(result.outboundMedia).toHaveLength(1)
    const second = client.askLoopRequests[1]?.turns[1]?.toolResult
    expect(second).toMatchObject({ kind: 'error' })
    expect(String((second as { message?: string }).message)).toContain('最多带一张表情')
  })

  it('id 不存在：错误里让人不带 id 看图鉴；没接表情池：如实说发不了', async () => {
    const missing = new FakeLlmClient([
      { toolCalls: [{ name: 'send_sticker', arguments: { id: 'ffffffffffff' } }] },
      { json: { answer: '那张没有。', citations: [] } }
    ])
    await askChain(
      buildDeps(missing, { tools: ['send_sticker'], stickers: stickerPort([STICKER]) }),
      '来一张'
    )
    expect(String((missing.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message)).toContain(
      '图鉴'
    )

    const noPort = new FakeLlmClient([
      { toolCalls: [{ name: 'send_sticker', arguments: {} }] },
      { json: { answer: '这边发不了。', citations: [] } }
    ])
    await askChain(buildDeps(noPort, { tools: ['send_sticker'] }), '来一张')
    expect(String((noPort.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message)).toContain(
      '发不了'
    )
  })
})

describe('save_sticker / send_image（D96 / PR2）', () => {
  it('本轮收到的图能当场收进表情包（拿得到字节）', async () => {
    const client = new FakeLlmClient([
      {
        toolCalls: [
          {
            name: 'save_sticker',
            arguments: { image_id: `#${TINY_PNG_ID}`, label: '翻白眼', desc: '被问住的时候' }
          }
        ]
      },
      { json: { answer: '收好了。', citations: [] } }
    ])
    const port = stickerPort()
    const result = await askChain(
      buildDeps(client, {
        tools: ['save_sticker'],
        stickers: port,
        attachments: { images: [TINY_PNG], files: [] }
      }),
      '存成表情包，叫翻白眼'
    )
    expect(result.kind).toBe('answer')
    expect(result.outboundMedia).toBeUndefined()
    expect(port.saved).toEqual([
      { dataUrl: TINY_PNG, label: '翻白眼', desc: '被问住的时候' }
    ])
    expect(client.askLoopRequests[1]?.turns[0]?.toolResult).toMatchObject({
      kind: 'save_sticker',
      ok: true,
      stickerId: 'ffffffffffff'
    })
  })

  it('会话里没有这张图 / 没给 image_id：如实说收不了', async () => {
    const unknown = new FakeLlmClient([
      { toolCalls: [{ name: 'save_sticker', arguments: { image_id: 'deadbeef', label: 'x' } }] },
      { json: { answer: '没收成。', citations: [] } }
    ])
    await askChain(
      buildDeps(unknown, { tools: ['save_sticker'], stickers: stickerPort() }),
      '存一下'
    )
    expect(
      String((unknown.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message)
    ).toContain('原始字节')

    const noId = new FakeLlmClient([
      { toolCalls: [{ name: 'save_sticker', arguments: { label: 'x' } }] },
      { json: { answer: '哪个图？', citations: [] } }
    ])
    await askChain(buildDeps(noId, { tools: ['save_sticker'], stickers: stickerPort() }), '存一下')
    expect(String((noId.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message)).toContain(
      'image_id'
    )
  })

  it('发图：认归档 id，回答之后发一张；再发第二张被挡住', async () => {
    const client = new FakeLlmClient([
      {
        toolCalls: [
          { name: 'send_image', arguments: { archive_id: TINY_PNG_ID } },
          { name: 'send_image', arguments: { archive_id: TINY_PNG_ID } }
        ]
      },
      { json: { answer: '给你。', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, {
        tools: ['send_image'],
        attachments: { images: [TINY_PNG], files: [] }
      }),
      '把刚才那张发我'
    )
    expect(result.outboundMedia).toHaveLength(1)
    expect(result.outboundMedia?.[0]).toMatchObject({ kind: 'image', ref: TINY_PNG_ID })
    expect(String((client.askLoopRequests[1]?.turns[1]?.toolResult as { message?: string }).message)).toContain(
      '最多带一张图'
    )
  })

  it('发不存在的图：如实说取不到，不瞎发', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'send_image', arguments: { archive_id: 'deadbeef' } }] },
      { json: { answer: '那张我这儿没有。', citations: [] } }
    ])
    const result = await askChain(buildDeps(client, { tools: ['send_image'] }), '发刚才那张')
    expect(result.outboundMedia).toBeUndefined()
    expect(String((client.askLoopRequests[1]?.turns[0]?.toolResult as { message?: string }).message)).toContain(
      '这次会话里没有这张图'
    )
  })
})

describe('媒体的挂载口径（D96 / PR2）', () => {
  it('澄清 / 报错不带媒体（只有有正文的回答才发图）', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'send_sticker', arguments: { id: 'a1b2c3d4e5f6' } }] },
      { json: { ask: '要哪一张？', options: ['这张'] } }
    ])
    const result = await askChain(
      buildDeps(client, { tools: ['send_sticker'], stickers: stickerPort([STICKER]) }),
      '来一张'
    )
    expect(result.kind).toBe('clarify')
    expect(result.outboundMedia).toBeUndefined()
  })

  it('桌面不挂这三个工具：默认工具集里没有它们', () => {
    const names = askLoopToolsFor().map((tool) => tool.function.name)
    expect(names).not.toContain('send_sticker')
    expect(names).not.toContain('save_sticker')
    expect(names).not.toContain('send_image')
  })

  it('本轮图片的 id 进用户消息 JSON（模型中这一轮就能收 / 发）', () => {
    const payload = {
      question: '这张图存起来',
      systemTime: '2026-11-01 22:00',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      history: [],
      now: '',
      attachments: { images: [TINY_PNG], files: [] }
    }
    const messages = buildChainAskLoopMessages(
      payload as unknown as Parameters<typeof buildChainAskLoopMessages>[0],
      {},
      undefined,
      undefined,
      ['send_sticker', 'save_sticker', 'send_image']
    )
    const user = JSON.parse(String(messages[1]?.content)) as Record<string, unknown>
    expect(user['images']).toEqual([{ id: TINY_PNG_ID }])
    // 图本身还在同一条 user 消息里（模型看得见）
    expect(messages[1]?.images).toHaveLength(1)
  })
})
