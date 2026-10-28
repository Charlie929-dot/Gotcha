import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import {
  closeSegment,
  insertContent,
  openSegment,
  type ChainDb
} from '../../src/chain/store'
import {
  createSearchWorkerHandler,
  SEARCH_WORKER_MAX_TEXTS,
  type SearchRequestMessage,
  type SearchResponseMessage
} from '../../src/chain/query-remote'

const T0 = new Date(2026, 9, 26, 9, 0, 0, 0).getTime()

let db: ChainDb

function makeDb(): ChainDb {
  const memory = new Database(':memory:')
  ensureChainSchema(memory)
  return memory as unknown as ChainDb
}

function seed(target: ChainDb): { segmentId: number } {
  const segmentId = openSegment(
    target,
    { startTs: T0, pid: 10, exe: 'app.exe', app: 'App', hwnd: 20, title: '标题' },
    T0
  )
  closeSegment(target, segmentId, {
    startTs: T0,
    endTs: T0 + 30_000,
    activeMs: 30_000,
    idleMs: 0,
    pid: 10,
    exe: 'app.exe',
    app: 'App',
    hwnd: 20,
    titleFirst: '标题',
    titleLast: '标题'
  })
  insertContent(target, { segmentId, capturedAt: T0 + 1_000, source: 'uia', text: '记忆球 性能优化' })
  return { segmentId }
}

function request(overrides: Partial<SearchRequestMessage> = {}): SearchRequestMessage {
  return {
    type: 'search',
    id: 1,
    dbPath: '/tmp/whatever.db',
    query: { texts: ['记忆球'], limit: 8, includeOpen: true },
    ...overrides
  }
}

afterEach(() => {
  db?.close()
})

describe('检索工作进程协议（§5.11）', () => {
  it('合法请求：回 ok + 命中（与进程内同口径）', async () => {
    db = makeDb()
    const { segmentId } = seed(db)
    const handler = createSearchWorkerHandler({ open: () => db })
    const response = (await handler.handle(request())) as SearchResponseMessage
    expect(response.ok).toBe(true)
    expect(response.result?.hitsPerText[0]?.map((hit) => hit.segment.id)).toContain(segmentId)
    expect(response.result?.stats.mode).toBe('keyword')
  })

  it('不是检索消息 / id 不合法：返回 null（worker 入口直接丢）', async () => {
    const handler = createSearchWorkerHandler({ open: () => db })
    await expect(handler.handle({ type: 'embed', id: 1 })).resolves.toBeNull()
    await expect(handler.handle({ type: 'search', id: 0 })).resolves.toBeNull()
    await expect(handler.handle('nope')).resolves.toBeNull()
  })

  it('参数越界（空 texts / 词太多 / 缺库路径）：ok:false + invalid-input，不碰库', async () => {
    let opened = 0
    const handler = createSearchWorkerHandler({
      open: () => {
        opened += 1
        return db
      }
    })
    const empty = (await handler.handle(request({ query: { texts: [] } }))) as SearchResponseMessage
    expect(empty).toMatchObject({ ok: false, code: 'invalid-input' })
    const tooMany = (await handler.handle(
      request({ query: { texts: Array.from({ length: SEARCH_WORKER_MAX_TEXTS + 1 }, () => 'x') } })
    )) as SearchResponseMessage
    expect(tooMany).toMatchObject({ ok: false, code: 'invalid-input' })
    const noPath = (await handler.handle(request({ dbPath: '' }))) as SearchResponseMessage
    expect(noPath).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(opened).toBe(0)
  })

  it('库打不开 / 查询抛错：ok:false + query-failed，message 截断到 200 字', async () => {
    const handler = createSearchWorkerHandler({
      open: () => {
        throw new Error('x'.repeat(500))
      }
    })
    const response = (await handler.handle(request())) as SearchResponseMessage
    expect(response.ok).toBe(false)
    expect(response.code).toBe('query-failed')
    expect((response.message ?? '').length).toBeLessThanOrEqual(201)
  })
})
