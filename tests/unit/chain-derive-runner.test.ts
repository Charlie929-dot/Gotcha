import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS_DDL } from '../../src/db/schema'
import { ensureChainSchema } from '../../src/chain/schema'
import {
  closeSegment,
  insertContent,
  openSegment,
  type ChainDb
} from '../../src/chain/store'
import { ChainDeriver } from '../../src/chain/derive/runner'
import {
  insertLink,
  listLinks,
  listSegmentLinks,
  listSegmentTags,
  getDeriveMarker
} from '../../src/chain/derive/store'
import { getSegmentVector } from '../../src/chain/derive/store'
import { FakeLlmClient, LlmError } from '../../src/understand/cloud/llm-client'
import type { Embedder } from '../../src/understand/embedding/types'

const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()

let db: ChainDb
let now: number

/** 名字 → 8 维向量；用来精确控制「≥0.95 / 0.90–0.95 / <0.90」三档 */
const NAME_VECTORS: Record<string, number[]> = {
  记忆系统: [1, 0, 0, 0, 0, 0, 0, 0],
  记忆系统设计: [0.93, Math.sqrt(1 - 0.93 * 0.93), 0, 0, 0, 0, 0, 0],
  记忆系统架构: [0.97, Math.sqrt(1 - 0.97 * 0.97), 0, 0, 0, 0, 0, 0],
  信息链: [0, 1, 0, 0, 0, 0, 0, 0],
  记忆球: [0, 0, 1, 0, 0, 0, 0, 0],
  旧概念: [0, 0, 0, 1, 0, 0, 0, 0],
  新概念: [0, 0, 0, 0, 1, 0, 0, 0],
  无关概念: [0, 0, 0, 0, 0, 1, 0, 0],
  旧标签: [0, 0, 0, 0, 0, 0, 1, 0],
  新标签: [0, 0, 0, 0, 0, 0, 0, 1]
}

function embedder(): Embedder {
  return {
    model: 'fake-embedding-v1',
    dim: 8,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const known = NAME_VECTORS[text.trim()]
        if (known) return new Float32Array(known)
        // 未知文本：按字符散列成一个确定方向（同一文本永远同向量，不同文本方向基本不相关）
        let seed = 0
        for (const char of text) seed = (seed * 31 + (char.codePointAt(0) ?? 0)) >>> 0
        const raw = Array.from({ length: 8 }, (_, index) => ((seed >>> (index * 3)) % 17) - 8)
        const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
        if (norm === 0) raw[0] = 1
        const safeNorm = norm === 0 ? 1 : norm
        return new Float32Array(raw.map((value) => value / safeNorm))
      })
    }
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SETTINGS_DDL)
  ensureChainSchema(db)
  now = T0 + 1_000
})

afterEach(() => {
  db.close()
})

function closedSegment(startTs: number, text: string): { segmentId: number; contentId: number } {
  const segmentId = openSegment(
    db,
    { startTs, pid: 100, exe: 'firefox', app: 'Firefox', hwnd: 200, title: '页面标题' },
    startTs
  )
  closeSegment(db, segmentId, {
    startTs,
    endTs: startTs + 60_000,
    activeMs: 60_000,
    idleMs: 0,
    pid: 100,
    exe: 'firefox',
    app: 'Firefox',
    hwnd: 200,
    titleFirst: '页面标题',
    titleLast: '页面标题'
  })
  const contentId = insertContent(db, {
    segmentId,
    capturedAt: startTs + 1_000,
    source: 'uia',
    text
  })
  return { segmentId, contentId }
}

function extractionReply(tags: string[], links: string[]) {
  return { json: { tags, links }, usage: { promptTokens: 10, completionTokens: 4 } }
}

async function startDeriver(
  options: {
    consent?: boolean
    client?: FakeLlmClient | null
    embed?: Embedder | null
  } = {}
): Promise<ChainDeriver> {
  const consent = options.consent ?? true
  const client = options.client === undefined ? new FakeLlmClient() : options.client
  const deriver = new ChainDeriver({
    db,
    now: () => now,
    log: () => {},
    sweepIntervalMs: 0,
    debounceMs: 0,
    readConsent: () => consent,
    resolveClient: () => (client ? { ok: true, client } : { ok: false, reason: 'missing-key' }),
    loadEmbedder: async () => (options.embed === undefined ? embedder() : options.embed)
  })
  deriver.start()
  // 取消 start 排的那一轮，让用例用 runNow 精确控制
  await deriver.drain()
  return deriver
}

describe('ChainDeriver · 向量与抽取', () => {
  it('未确认出网时只建向量（零请求）；确认后补抽标签 / 双链', async () => {
    const { segmentId, contentId } = closedSegment(T0, '记忆球 信息链 内容')
    const client = new FakeLlmClient([extractionReply(['记忆球'], ['信息链'])])
    let consent = false
    const deriver = new ChainDeriver({
      db,
      now: () => now,
      log: () => {},
      sweepIntervalMs: 0,
      debounceMs: 0,
      readConsent: () => consent,
      resolveClient: () => ({ ok: true, client }),
      loadEmbedder: async () => embedder()
    })
    deriver.start()
    await deriver.drain()
    await deriver.runNow()

    expect(getSegmentVector(db, segmentId)).toMatchObject({
      model: 'fake-embedding-v1',
      textHash: expect.any(String),
      contentMaxId: contentId
    })
    expect(client.chainExtractRequests).toHaveLength(0)
    expect(listSegmentTags(db, segmentId)).toEqual([])
    expect(deriver.status()).toMatchObject({ vectors: 1, extracted: 0, skippedConsent: 1 })

    consent = true
    await deriver.runNow()
    expect(client.chainExtractRequests).toHaveLength(1)
    expect(listSegmentTags(db, segmentId).map((tag) => tag.name)).toEqual(['记忆球'])
    expect(listSegmentLinks(db, segmentId).map((link) => link.name)).toEqual(['信息链'])
    expect(getDeriveMarker(db, segmentId)).not.toBeNull()
    expect(deriver.status()).toMatchObject({ extracted: 1 })
    deriver.stop()
  })

  it('同指纹不重抽（幂等），内容变了才重抽并替换标签', async () => {
    const { segmentId } = closedSegment(T0, '第一版内容')
    const client = new FakeLlmClient([
      extractionReply(['旧标签'], ['旧概念']),
      extractionReply(['新标签'], ['新概念'])
    ])
    const deriver = await startDeriver({ client })
    await deriver.runNow()
    await deriver.runNow()
    expect(client.chainExtractRequests).toHaveLength(1)
    expect(listSegmentTags(db, segmentId).map((tag) => tag.name)).toEqual(['旧标签'])

    insertContent(db, {
      segmentId,
      capturedAt: T0 + 2_000,
      source: 'uia',
      text: '第二版内容'
    })
    await deriver.runNow()
    expect(client.chainExtractRequests).toHaveLength(2)
    expect(listSegmentTags(db, segmentId).map((tag) => tag.name)).toEqual(['新标签'])
    expect(listSegmentLinks(db, segmentId).map((link) => link.name)).toEqual(['新概念'])
    deriver.stop()
  })

  it('敏感段整段不出云：写空指纹、不请求、不留旧标签', async () => {
    const { segmentId } = closedSegment(T0, '请输入密码 passw0rd')
    const client = new FakeLlmClient([extractionReply(['不该出现'], [])])
    const deriver = await startDeriver({ client })
    await deriver.runNow()
    expect(client.chainExtractRequests).toHaveLength(0)
    expect(listSegmentTags(db, segmentId)).toEqual([])
    expect(getDeriveMarker(db, segmentId)).not.toBeNull()
    expect(deriver.status().blocked).toBe(1)
    deriver.stop()
  })

  it('没有向量模型也照抽标签 / 双链（只做同名合并）', async () => {
    const { segmentId } = closedSegment(T0, '记忆球 内容')
    const existing = insertLink(db, '信息链')
    const client = new FakeLlmClient([extractionReply(['记忆球'], ['信息链'])])
    const deriver = await startDeriver({ client, embed: null })
    await deriver.runNow()
    expect(getSegmentVector(db, segmentId)).toBeNull()
    expect(listSegmentLinks(db, segmentId)).toEqual([{ linkId: existing, name: '信息链', weight: 1 }])
    expect(deriver.status()).toMatchObject({ vectors: 0, extracted: 1 })
    deriver.stop()
  })
})

describe('ChainDeriver · 名字合并分带', () => {
  it('0.90–0.95 问模型：判同 → 复用并补别名；<0.90 新建', async () => {
    const existing = insertLink(db, '记忆系统')
    const first = closedSegment(T0, '关于记忆系统的内容')
    const client = new FakeLlmClient([
      extractionReply([], ['记忆系统设计']),
      { json: { same: [true] }, usage: { promptTokens: 5, completionTokens: 1 } },
      extractionReply([], ['无关概念', '记忆系统架构'])
    ])
    const deriver = await startDeriver({ client })
    await deriver.runNow()

    const links = listLinks(db)
    expect(links.map((link) => link.name)).toEqual(['记忆系统'])
    expect(links[0].aliases).toEqual(['记忆系统设计'])
    expect(listSegmentLinks(db, first.segmentId)).toEqual([
      { linkId: existing, name: '记忆系统', weight: 1 }
    ])
    expect(client.chainMergeRequests).toHaveLength(1)
    expect(deriver.status().mergedLinks).toBe(1)

    // 第二段：「记忆系统架构」0.97 ≥ 0.95 直接复用（不问模型）；「无关概念」相似度 < 0.90 新建
    const second = closedSegment(T0 + 60_000, '记忆系统架构的内容')
    await deriver.runNow()
    expect(listSegmentLinks(db, second.segmentId).map((link) => link.name).sort()).toEqual([
      '无关概念',
      '记忆系统'
    ])
    expect(listLinks(db).map((link) => link.name).sort()).toEqual(['无关概念', '记忆系统'])
    expect(client.chainMergeRequests).toHaveLength(1)
    deriver.stop()
  })

  it('≥0.95 直接复用，不问模型', async () => {
    insertLink(db, '记忆系统')
    const { segmentId } = closedSegment(T0, '记忆系统架构')
    const client = new FakeLlmClient([extractionReply([], ['记忆系统架构'])])
    const deriver = await startDeriver({ client })
    await deriver.runNow()
    expect(client.chainMergeRequests).toHaveLength(0)
    expect(listSegmentLinks(db, segmentId).map((link) => link.name)).toEqual(['记忆系统'])
    deriver.stop()
  })
})

describe('ChainDeriver · 预算 / 失败退避 / 生命周期', () => {
  it('每日预算用完就停抽取（向量照建），待办留着', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('graph.budget_tokens_per_day', '12')").run()
    const first = closedSegment(T0, '第一段内容')
    const second = closedSegment(T0 + 60_000, '第二段内容')
    const client = new FakeLlmClient([
      { json: { tags: ['a'], links: [] }, usage: { promptTokens: 10, completionTokens: 4 } }
    ])
    const deriver = await startDeriver({ client })
    await deriver.runNow()
    // 待办按「最近优先」：先处理第二段，预算用完第一段就只剩向量
    expect(client.chainExtractRequests).toHaveLength(1)
    expect(getDeriveMarker(db, second.segmentId)).not.toBeNull()
    expect(getDeriveMarker(db, first.segmentId)).toBeNull()
    expect(getSegmentVector(db, first.segmentId)).not.toBeNull()
    expect(getSegmentVector(db, second.segmentId)).not.toBeNull()
    expect(deriver.status()).toMatchObject({ skippedBudget: 1 })
    deriver.stop()
  })

  it('请求失败：记失败 + 退避，退避期内不重抽，退避后重试', async () => {
    const { segmentId } = closedSegment(T0, '内容')
    const client = new FakeLlmClient([
      new LlmError('模拟网络失败', 'network'),
      extractionReply(['记忆球'], [])
    ])
    const deriver = await startDeriver({ client })
    await deriver.runNow()
    expect(deriver.status().failed).toBe(1)
    expect(getDeriveMarker(db, segmentId)).toBeNull()

    await deriver.runNow()
    expect(client.chainExtractRequests).toHaveLength(1)

    now += 31 * 60_000
    await deriver.runNow()
    expect(client.chainExtractRequests).toHaveLength(2)
    expect(getDeriveMarker(db, segmentId)).not.toBeNull()
    deriver.stop()
  })

  it('stop 后 runNow 不做任何事（暂停即停派生）', async () => {
    closedSegment(T0, '内容')
    const client = new FakeLlmClient([extractionReply(['记忆球'], [])])
    const deriver = await startDeriver({ client })
    deriver.stop()
    await deriver.runNow()
    expect(client.chainExtractRequests).toHaveLength(0)
    expect(deriver.status().started).toBe(false)
  })
})
