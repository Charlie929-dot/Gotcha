import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import { createThemeOnlineRuntime, type ThemeOnlineRuntimeDeps } from '../../src/main/theme-online-runtime'
import { FakeLlmClient, LlmHttpError } from '../../src/understand/cloud/llm-client'
import type { Embedder } from '../../src/understand/embedding/types'
import { recordUsage } from '../../src/understand/induction'
import { localDayKey } from '../../src/understand/moments'
import { writeEventVectors } from '../../src/understand/event-embeddings'
import { writeThemeCentroids } from '../../src/understand/theme-centroids'
import { onlineMetaJson } from '../../src/understand/theme-online'
import type { ConfirmOutcome } from '../../src/understand/theme-confirm'
import type { ThemeNamingOutcome } from '../../src/understand/theme-naming'

const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime()

function seedEvent(db: Db, ts: number, title: string, ocr = ''): number {
  return insertEvent(db, { ts, app: 'Code', windowTitle: title, ocrText: ocr })
}

function seedMoment(
  db: Db,
  input: { startTs: number; title: string; ocr?: string; eventIds: number[] }
): number {
  const result = db
    .prepare(
      `INSERT INTO moments (start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
       VALUES (?, ?, ?, 'Code', ?, ?, ?, ?)`
    )
    .run(
      input.startTs,
      input.startTs + 60_000,
      localDayKey(input.startTs),
      input.title,
      input.ocr ?? '',
      JSON.stringify(input.eventIds),
      NOW
    )
  return Number(result.lastInsertRowid)
}

function seedTheme(
  db: Db,
  input: {
    title: string
    summary?: string
    tsStart?: number
    tsEnd?: number
    eventIds?: number[]
    metaJson?: string | null
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO nodes (level, type, title, summary, ts_start, ts_end, source_events, meta_json)
       VALUES (1, 'activity', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title,
      input.summary ?? '',
      input.tsStart ?? NOW - 120_000,
      input.tsEnd ?? NOW - 60_000,
      JSON.stringify(input.eventIds ?? []),
      input.metaJson ?? null
    )
  return Number(result.lastInsertRowid)
}

function attachOwner(db: Db, themeId: number, momentId: number): void {
  db.prepare(
    `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
     VALUES (?, ?, 1, 'owner', ?)`
  ).run(themeId, momentId, NOW)
}

function fakeEmbedder(vector: (text: string) => number[] = () => [1, 0]): Embedder & {
  calls: number
} {
  return {
    model: 'fake-bge',
    dim: 2,
    calls: 0,
    async embed(texts) {
      this.calls += 1
      return texts.map((text) => Float32Array.from(vector(text)))
    }
  }
}

interface Harness {
  runtime: ReturnType<typeof createThemeOnlineRuntime>
  lines: Array<{ level: string; msg: string }>
  changed: Array<{ nodes: number; edges: number; placeholders: number }>
  state: {
    client: FakeLlmClient
    clientOk: boolean
    consent: boolean
    enabled: boolean
    embeddingsReady: boolean
  }
  embedder: Embedder & { calls: number }
}

function makeHarness(
  db: Db,
  options: {
    client?: FakeLlmClient
    clientOk?: boolean
    consent?: boolean
    enabled?: boolean
    embeddingsReady?: boolean
    embedder?: Embedder & { calls: number }
    overrides?: Partial<ThemeOnlineRuntimeDeps>
  } = {}
): Harness {
  const state = {
    client: options.client ?? new FakeLlmClient(),
    clientOk: options.clientOk ?? true,
    consent: options.consent ?? true,
    enabled: options.enabled ?? true,
    embeddingsReady: options.embeddingsReady ?? true
  }
  const embedder = options.embedder ?? fakeEmbedder()
  const lines: Array<{ level: string; msg: string }> = []
  const changed: Harness['changed'] = []
  const runtime = createThemeOnlineRuntime({
    db,
    resolveClient: () =>
      state.clientOk
        ? { ok: true, client: state.client }
        : { ok: false, reason: 'missing-key' },
    readConsent: () => state.consent,
    readEmbeddingsReady: () => state.embeddingsReady,
    loadEmbedder: async () => embedder,
    readEnabled: () => state.enabled,
    now: () => NOW,
    log: (level, msg) => lines.push({ level, msg }),
    onGraphChanged: (outcome) => changed.push(outcome),
    ...options.overrides
  })
  return { runtime, lines, changed, state, embedder }
}

function node(db: Db, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown>
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c
}

describe('theme online runtime（S6：新时刻 → 归属 / 命名 / 确认）', () => {
  it('没有客户端时照建主题、零请求；补上客户端后把模型标题补回来', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '调试按钮', '改 hover 样式')
    const momentId = seedMoment(db, {
      startTs: NOW - 90_000,
      title: '调试按钮',
      ocr: '改 hover 样式',
      eventIds: [eventId]
    })
    const harness = makeHarness(db, { clientOk: false })
    harness.state.client.push({
      json: { title: '按钮悬停样式', summary: '调 hover 颜色', type: 'knowledge' }
    })

    const first = await harness.runtime.runOnce()
    expect(first.status).toBe('done')
    expect(first.created).toBe(1)
    expect(harness.state.client.namingRequests).toHaveLength(0)
    expect(harness.runtime.getState().queue.waitingClient).toBe(true)

    const themeCount = count(db, 'SELECT COUNT(*) AS c FROM nodes')
    expect(themeCount).toBe(1)
    const themeId = (db.prepare('SELECT id FROM nodes').get() as { id: number }).id
    expect(node(db, themeId).title).toBe('调试按钮')
    expect(String(node(db, themeId).meta_json)).toContain('"namePending":true')
    expect(count(db, 'SELECT COUNT(*) AS c FROM theme_moments WHERE moment_id = ?', momentId)).toBe(1)

    // 补上 key：唤醒队列，模型标题覆盖兜底标题，并清掉待命名标记
    harness.state.clientOk = true
    harness.runtime.wake()
    await harness.runtime.drain()
    expect(harness.state.client.namingRequests).toHaveLength(1)
    const named = node(db, themeId)
    expect(named.title).toBe('按钮悬停样式')
    expect(named.summary).toBe('调 hover 颜色')
    expect(named.type).toBe('knowledge')
    expect(String(named.meta_json)).toContain('"namePending":false')
    // 命名后标题向量也算出来了
    expect(count(db, 'SELECT COUNT(*) AS c FROM node_embeddings')).toBe(1)
    db.close()
  })

  it('有客户端 + 授权：新主题命名回写并通知画布', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '报表')
    seedMoment(db, { startTs: NOW - 90_000, title: '报表', eventIds: [eventId] })
    const client = new FakeLlmClient([
      { json: { title: '季度报表', summary: '整理 Q3 数据', type: 'knowledge' } }
    ])
    const harness = makeHarness(db, { client })

    const result = await harness.runtime.runOnce()
    await harness.runtime.drain()
    expect(result.created).toBe(1)
    expect(harness.changed.length).toBeGreaterThan(0)
    expect(harness.changed[0].nodes).toBeGreaterThan(0)
    const row = db.prepare('SELECT title, summary FROM nodes').get() as {
      title: string
      summary: string
    }
    expect(row).toEqual({ title: '季度报表', summary: '整理 Q3 数据' })
    db.close()
  })

  it('同一主题的代表时刻合并成一次命名，不重复发请求', async () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 120_000, '同一主题')
    const e2 = seedEvent(db, NOW - 60_000, '同一主题续')
    const m1 = seedMoment(db, { startTs: NOW - 120_000, title: '同一主题', eventIds: [e1] })
    const m2 = seedMoment(db, { startTs: NOW - 60_000, title: '同一主题续', eventIds: [e2] })
    // 两个时刻 → 第一个建主题 + 命名；第二个应直接归到该主题（同一向量）而不再命名
    const harness = makeHarness(db, {
      client: new FakeLlmClient([
        { json: { title: '合并后的主题', summary: '摘要', type: 'activity' } }
      ])
    })
    const result = await harness.runtime.runOnce()
    await harness.runtime.drain()
    expect(result.created).toBe(1)
    expect(result.assigned).toBe(1)
    expect(harness.state.client.namingRequests).toHaveLength(1)
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM theme_moments').get() as { c: number }
    ).toEqual({ c: 2 })
    expect(m1).not.toBe(m2)
    db.close()
  })

  it('暂停 = 零出网；恢复后才补发（D18）', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '待命名')
    const momentId = seedMoment(db, { startTs: NOW - 90_000, title: '待命名', eventIds: [eventId] })
    const themeId = seedTheme(db, { title: '待命名', metaJson: onlineMetaJson(true) })
    attachOwner(db, themeId, momentId)
    const client = new FakeLlmClient([{ json: { title: '恢复后命名', summary: 'x', type: 'activity' } }])
    const harness = makeHarness(db, { client })

    harness.runtime.pause()
    const paused = await harness.runtime.runOnce()
    expect(paused.status).toBe('skipped')
    expect(paused.reason).toBe('paused')
    expect(client.namingRequests).toHaveLength(0)
    // 采集暂停期间即使「恢复授权」也不能出网
    harness.runtime.resumeEgress()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.namingRequests).toHaveLength(0)

    // 恢复采集：起定时器并立刻跑一轮
    harness.runtime.start()
    await harness.runtime.drain()
    expect(client.namingRequests).toHaveLength(1)
    expect(node(db, themeId).title).toBe('恢复后命名')
    harness.runtime.dispose()
    db.close()
  })

  it('撤销授权：等待中的任务留住、零请求；重新授权后补发（D24）', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '待命名')
    const momentId = seedMoment(db, { startTs: NOW - 90_000, title: '待命名', eventIds: [eventId] })
    const themeId = seedTheme(db, { title: '待命名', metaJson: onlineMetaJson(true) })
    attachOwner(db, themeId, momentId)
    const client = new FakeLlmClient([{ json: { title: '授权后命名', summary: 'x', type: 'activity' } }])
    const harness = makeHarness(db, { client, consent: false })

    const blocked = await harness.runtime.runOnce()
    expect(blocked.status).toBe('done')
    expect(client.namingRequests).toHaveLength(0)
    expect(harness.runtime.getState().queue.pendingJobs).toBeGreaterThan(0)
    expect(harness.runtime.getState().queue.waitingClient).toBe(true)

    harness.state.consent = true
    harness.runtime.resumeEgress()
    await harness.runtime.drain()
    expect(client.namingRequests).toHaveLength(1)
    expect(node(db, themeId).title).toBe('授权后命名')
    db.close()
  })

  it('每日预算耗尽：零请求、任务留住；调高预算后能补发', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '待命名')
    const momentId = seedMoment(db, { startTs: NOW - 90_000, title: '待命名', eventIds: [eventId] })
    const themeId = seedTheme(db, { title: '待命名', metaJson: onlineMetaJson(true) })
    attachOwner(db, themeId, momentId)
    recordUsage(db, NOW, { calls: 1, promptTokens: 1_000_000, completionTokens: 0 })
    const client = new FakeLlmClient([{ json: { title: '预算内的命名', summary: 'x', type: 'activity' } }])
    const harness = makeHarness(db, { client })

    await harness.runtime.runOnce()
    await harness.runtime.drain()
    expect(client.namingRequests).toHaveLength(0)
    expect(harness.runtime.getState().queue.waitingClient).toBe(true)

    setSetting(db, 'graph.budget_tokens_per_day', '2000000')
    harness.runtime.wake()
    await harness.runtime.drain()
    expect(client.namingRequests).toHaveLength(1)
    expect(node(db, themeId).title).toBe('预算内的命名')
    db.close()
  })

  it('请求失败按退避处理：退避期内不再发下一条', async () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 120_000, '先失败')
    const e2 = seedEvent(db, NOW - 60_000, '后一条')
    const m1 = seedMoment(db, { startTs: NOW - 120_000, title: '先失败', eventIds: [e1] })
    const m2 = seedMoment(db, { startTs: NOW - 60_000, title: '后一条', eventIds: [e2] })
    const first = seedTheme(db, { title: '先失败', metaJson: onlineMetaJson(true) })
    const second = seedTheme(db, { title: '后一条', metaJson: onlineMetaJson(true) })
    attachOwner(db, first, m1)
    attachOwner(db, second, m2)
    const client = new FakeLlmClient([new LlmHttpError(500)])
    const harness = makeHarness(db, { client })

    const result = await harness.runtime.runOnce()
    await harness.runtime.drain()
    expect(result.named).toBeGreaterThanOrEqual(1)
    expect(client.namingRequests).toHaveLength(1)
    const state = harness.runtime.getState()
    expect(state.failureStreak).toBe(1)
    expect(state.nextLlmAt).toBeGreaterThan(NOW)
    // 第一条已按本地兜底回写（请求真的失败过，不再无限重排）
    expect(String(node(db, first).meta_json)).toContain('"namePending":false')
    // 退避期内第二条不排队、不发
    await harness.runtime.runOnce()
    await harness.runtime.drain()
    expect(client.namingRequests).toHaveLength(1)
    expect(String(node(db, second).meta_json)).toContain('"namePending":true')
    db.close()
  })

  it('本地模型未就绪：不建主题 / 不算向量，但待命名照跑', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '待命名')
    const momentId = seedMoment(db, { startTs: NOW - 90_000, title: '待命名', eventIds: [eventId] })
    const pendingEvent = seedEvent(db, NOW - 120_000, '更早的待命名')
    const pendingMoment = seedMoment(db, {
      startTs: NOW - 120_000,
      title: '更早的待命名',
      eventIds: [pendingEvent]
    })
    const themeId = seedTheme(db, { title: '待命名', metaJson: onlineMetaJson(true) })
    attachOwner(db, themeId, pendingMoment)
    const client = new FakeLlmClient([{ json: { title: '照样命名', summary: 'x', type: 'activity' } }])
    const harness = makeHarness(db, { client, embeddingsReady: false })

    const result = await harness.runtime.runOnce()
    await harness.runtime.drain()
    expect(result.created).toBe(0)
    expect(result.moments).toBe(0)
    expect(harness.embedder.calls).toBe(0)
    expect(client.namingRequests).toHaveLength(1)
    expect(node(db, themeId).title).toBe('照样命名')
    // 新时刻仍然没有归属（等模型就绪）
    expect(
      count(db, 'SELECT COUNT(*) AS c FROM theme_moments WHERE moment_id = ?', momentId)
    ).toBe(0)
    db.close()
  })

  it('开关关掉：整轮跳过，不归属也不出网', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '待命名')
    const momentId = seedMoment(db, { startTs: NOW - 90_000, title: '待命名', eventIds: [eventId] })
    const themeId = seedTheme(db, { title: '待命名', metaJson: onlineMetaJson(true) })
    attachOwner(db, themeId, momentId)
    const client = new FakeLlmClient([{ json: { title: '不该发', summary: 'x', type: 'activity' } }])
    const harness = makeHarness(db, { client, enabled: false })

    const result = await harness.runtime.runOnce()
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('disabled')
    expect(client.namingRequests).toHaveLength(0)
    expect(count(db, 'SELECT COUNT(*) AS c FROM nodes')).toBe(1)
    db.close()
  })

  it('批量归纳先处理过的时刻不再在线归属（共存口径）', async () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '已归纳')
    seedMoment(db, { startTs: NOW - 90_000, title: '已归纳', eventIds: [eventId] })
    seedTheme(db, { title: '批量路径建的', eventIds: [eventId], tsStart: NOW - 90_000, tsEnd: NOW })
    const harness = makeHarness(db)

    const result = await harness.runtime.runOnce()
    expect(result.moments).toBe(0)
    expect(result.created).toBe(0)
    expect(result.skippedCovered).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS c FROM nodes')).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS c FROM theme_moments')).toBe(0)
    db.close()
  })

  it('模糊确认结果落库：候选主题归属 + 待确认时刻不重复排', async () => {
    const db = openDatabase(':memory:')
    // 两个不同的主题（互不近重复）都像这个时刻 → ambiguous
    const themeA = seedTheme(db, { title: '主题 A' })
    const themeB = seedTheme(db, { title: '主题 B' })
    writeThemeCentroids(
      db,
      [
        { nodeId: themeA, vec: Float32Array.from([1, 0]), memberEvents: 1 },
        { nodeId: themeB, vec: Float32Array.from([0.8, 0.6]), memberEvents: 1 }
      ],
      { model: 'fake-bge', now: NOW }
    )
    const eventId = seedEvent(db, NOW - 90_000, '分不清')
    const momentId = seedMoment(db, { startTs: NOW - 90_000, title: '分不清', eventIds: [eventId] })
    writeEventVectors(db, [{ eventId, vec: Float32Array.from([0.95, 0.31]) }], {
      model: 'fake-bge',
      dim: 2,
      now: NOW
    })

    const confirm: ThemeOnlineRuntimeDeps['confirm'] = async () => {
      const outcome: ConfirmOutcome = {
        decisions: [{ momentId, themeIds: [themeA] }],
        failed: false,
        pendingMomentIds: [],
        errors: []
      }
      return outcome
    }
    const harness = makeHarness(db, { overrides: { confirm } })

    const result = await harness.runtime.runOnce()
    expect(result.ambiguous).toBe(1)
    await harness.runtime.drain()
    expect(
      db.prepare('SELECT theme_id, source FROM theme_moments WHERE moment_id = ?').get(momentId)
    ).toEqual({ theme_id: themeA, source: 'owner' })
    db.close()
  })
})
