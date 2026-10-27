import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import { parseChainAnswer } from '../../src/chain/agent/parse'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, openSegment, type ChainDb } from '../../src/chain/store'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { buildChainAskPayload } from '../../src/understand/cloud/redact'

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

interface SeedOptions {
  pid: number
  app: string
  title: string
  from: number
  to: number
  text: string
}

/** 造一段已收口的段 + 一条内容（关键词检索就是读这张表） */
function seed(options: SeedOptions): number {
  const exe = `app${options.pid}`
  const id = openSegment(
    db,
    {
      startTs: options.from,
      pid: options.pid,
      exe,
      app: options.app,
      hwnd: options.pid * 10,
      title: options.title
    },
    options.from
  )
  insertContent(db, {
    segmentId: id,
    capturedAt: options.from + 1_000,
    source: 'uia',
    text: options.text
  })
  closeSegment(db, id, {
    startTs: options.from,
    endTs: options.to,
    activeMs: options.to - options.from,
    idleMs: 0,
    pid: options.pid,
    exe,
    app: options.app,
    hwnd: options.pid * 10,
    titleFirst: options.title,
    titleLast: options.title
  })
  return id
}

function buildDeps(client: FakeLlmClient, extra: Partial<ChainAskOptions> = {}): ChainAskOptions {
  return {
    db,
    resolveClient: () => ({ ok: true, client }),
    ...extra
  }
}

describe('问记忆：编排与白名单（S1）', () => {
  it('命中段 → 一段回答 + 引用，引用的事实由服务端从段行补', async () => {
    const vscode = seed({
      pid: 1,
      app: 'Visual Studio Code',
      title: 'gotcha — src/chain',
      from: at(0),
      to: at(600),
      text: '编译 native 模块报 LNK1104，因为 Electron 正加载着 chain_hook.node'
    })
    seed({
      pid: 2,
      app: 'Firefox',
      title: '哔哩哔哩',
      from: at(700),
      to: at(900),
      text: '看视频'
    })

    const client = new FakeLlmClient([
      {
        json: {
          answer: '你当时在 VSCode 里重新编译原生模块，撞上 LNK1104，是因为 Node 文件被运行中的 Electron 占着。',
          citations: [{ segmentId: vscode, why: '报 LNK1104 的那一次，正在改 chain 目录' }]
        },
        usage: { promptTokens: 300, completionTokens: 40 }
      }
    ])
    const usages: Array<{ promptTokens?: number }> = []
    const result = await askChain(
      buildDeps(client, { onUsage: (usage) => usages.push(usage) }),
      'LNK1104'
    )

    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.answer).toContain('LNK1104')
    expect(result.citations).toHaveLength(1)
    // at / app / title 是服务端补的，不是模型给的
    expect(result.citations[0]).toMatchObject({
      segmentId: vscode,
      at: at(0),
      app: 'Visual Studio Code',
      title: 'gotcha — src/chain',
      why: '报 LNK1104 的那一次，正在改 chain 目录'
    })
    expect(result.stats).toMatchObject({ hits: 1, evidence: 1, cited: 1 })
    // 载荷里带的是命中原文片段，不是整段库表
    const sent = client.askRequests[0]
    expect(sent.question).toBe('LNK1104')
    expect(sent.evidence[0].text).toContain('chain_hook.node')
    expect(usages).toHaveLength(1)
  })

  it('编造的 segmentId 整条丢弃，白名单外的引用进不来', async () => {
    const seg = seed({
      pid: 1,
      app: 'Firefox',
      title: '文档',
      from: at(0),
      to: at(60),
      text: '这里写了 LNK1104 的解决办法'
    })
    const client = new FakeLlmClient([
      {
        json: {
          answer: '见那一段。',
          citations: [
            { segmentId: 9999, why: '编造的段' },
            { segmentId: seg, why: '真的' },
            { segmentId: 9999, why: '重复的编造' }
          ]
        }
      }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((citation) => citation.segmentId)).toEqual([seg])
    expect(result.stats.cited).toBe(3) // 模型给了 3 条，剥完只剩 1 条
  })

  it('引用全被剥空 → 没找到证据（不当成空回答）', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([
      { json: { answer: '我猜你编译过什么东西。', citations: [{ segmentId: 424242, why: '编的' }] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('no-evidence')
    expect(client.askRequests).toHaveLength(1)
  })

  it('没命中：不调 LLM（不花钱、不编话）', async () => {
    seed({ pid: 1, app: 'Firefox', title: '视频', from: at(0), to: at(60), text: '看视频' })
    const client = new FakeLlmClient([{ json: { answer: '不该被问到', citations: [] } }])
    const result = await askChain(buildDeps(client), '完全不存在的东西')
    expect(result.kind).toBe('no-evidence')
    expect(result.stats.hits).toBe(0)
    expect(client.askRequests).toHaveLength(0)
  })

  it('answer 缺失 / 不是字符串 → 整次失败，不静默当空结果', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([{ json: { citations: [{ segmentId: 1, why: 'x' }] } }])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('unparseable')
  })

  it('出云门关着：一次调用都不发', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([])
    const result = await askChain(buildDeps(client, { canSend: () => false }), 'LNK1104')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('consent')
    expect(client.askRequests).toHaveLength(0)
  })

  it('客户端没有问答案能力：报 client，不静默降级', async () => {
    const fake = new FakeLlmClient([])
    const client = {
      completeJson: fake.completeJson.bind(fake),
      completeNaming: fake.completeNaming.bind(fake),
      completeAssignments: fake.completeAssignments.bind(fake),
      completeChainExtract: fake.completeChainExtract.bind(fake),
      completeChainMerge: fake.completeChainMerge.bind(fake)
    }
    const result = await askChain({ db, resolveClient: () => ({ ok: true, client }) }, '任何问题')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('client')
  })

  it('空问题不出门', async () => {
    const client = new FakeLlmClient([])
    const result = await askChain(buildDeps(client), '   ')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('empty-question')
    expect(client.askRequests).toHaveLength(0)
  })

  it('问题命中敏感规则：整次不出云', async () => {
    // 问题既要能命中（否则会先走「没找到」），又要带密码类词
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 改密码那次' })
    const client = new FakeLlmClient([])
    const result = await askChain(buildDeps(client), 'LNK1104 改密码')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('question-blocked')
    expect(client.askRequests).toHaveLength(0)
  })

  it('引用超过 6 条按上限截断', async () => {
    const ids = Array.from({ length: 8 }, (_, index) =>
      seed({
        pid: index + 1,
        app: `App${index}`,
        title: `标题 ${index}`,
        from: at(index * 100),
        to: at(index * 100 + 50),
        text: `第 ${index} 段里有 LNK1104`
      })
    )
    const client = new FakeLlmClient([
      { json: { answer: '都在这儿。', citations: ids.map((id) => ({ segmentId: id, why: `依据 ${id}` })) } }
    ])
    const result = await askChain(buildDeps(client, { limit: 10 }), 'LNK1104')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations).toHaveLength(6)
  })

  it('模型调用抛错：变成 failed，不把异常抛给调用方', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([new Error('屏幕流断了')])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('failed')
  })
})

describe('问记忆：载荷脱敏与解析纪律', () => {
  it('载荷：问题被脱敏挡下时 question 为空、evidence 保留', () => {
    const built = buildChainAskPayload('我的密码是多少', [
      { segmentId: 1, app: 'Firefox', title: '文档', startTs: 0, endTs: 1, text: '正文' }
    ])
    expect(built.questionBlocked).toBe(true)
    expect(built.payload.question).toBe('')
    expect(built.payload.evidence).toHaveLength(1)
  })

  it('载荷：命中密码类应用名的段整段不出云', () => {
    const built = buildChainAskPayload('那次我在干什么', [
      { segmentId: 1, app: '1password.exe', title: 'vault', startTs: 0, endTs: 1, text: '正文' },
      { segmentId: 2, app: 'Firefox', title: '文档', startTs: 2, endTs: 3, text: '正文' }
    ])
    expect(built.payload.evidence.map((segment) => segment.segmentId)).toEqual([2])
    expect(built.blockedSegmentIds).toEqual([1])
  })

  it('载荷：标签 / 双链按条数与长度截断', () => {
    const built = buildChainAskPayload('问题', [
      {
        segmentId: 1,
        app: 'Firefox',
        title: '文档',
        startTs: 0,
        endTs: 1,
        text: '正文',
        tags: Array.from({ length: 12 }, (_, index) => `标签${index}`),
        links: ['x'.repeat(100)]
      }
    ])
    const evidence = built.payload.evidence[0]
    expect(evidence.tags).toHaveLength(8)
    expect(evidence.links[0]).toHaveLength(40)
  })

  it('解析：citations 不是数组 / answer 为空都算结构不对', () => {
    const meta = new Map([[1, { segmentId: 1, at: 0, app: 'A', title: 'T' }]])
    expect(parseChainAnswer({ answer: '有', citations: 'nope' }, meta)).toMatchObject({
      ok: false,
      reason: 'shape'
    })
    expect(parseChainAnswer({ answer: '   ', citations: [] }, meta)).toMatchObject({
      ok: false,
      reason: 'shape'
    })
  })
})
