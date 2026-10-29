import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import { parseChainReply } from '../../src/chain/agent/parse'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, openSegment, type ChainDb } from '../../src/chain/store'
import { FakeLlmClient, type LlmClient } from '../../src/understand/cloud/llm-client'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'
import { buildChainAskLoopPayload, buildChainAskPayload } from '../../src/understand/cloud/redact'

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

/**
 * 单发回退路径的客户端：FakeLlmClient 现在带 completeAskLoop（会走工具循环主路径），
 * 这里显式剥掉它，逼 askChain 落回保留的老单发管道。
 */
function legacyClient(fake: FakeLlmClient): LlmClient {
  return {
    completeJson: fake.completeJson.bind(fake),
    completeNaming: fake.completeNaming.bind(fake),
    completeAssignments: fake.completeAssignments.bind(fake),
    completeChainExtract: fake.completeChainExtract.bind(fake),
    completeChainMerge: fake.completeChainMerge.bind(fake),
    completeAsk: fake.completeAsk.bind(fake)
  }
}

function buildDeps(client: FakeLlmClient, extra: Partial<ChainAskOptions> = {}): ChainAskOptions {
  return {
    db,
    outbound: createCloudAskOutbound(),
    resolveClient: () => ({ ok: true, client: legacyClient(client) }),
    ...extra
  }
}

describe('问记忆：单发回退路径（客户端没有 completeAskLoop 时保留的老管道）', () => {
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

  it('answer 宣称没找到却带引用 → 仍按没找到收口，但保留说明与引用（根因 7）', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([
      {
        json: {
          answer: '信息链里没找到相关记录。',
          citations: [{ segmentId: 1, why: '不该出现的引用' }]
        }
      }
    ])
    const logs: string[] = []
    const result = await askChain(
      buildDeps(client, { log: (_level, message) => logs.push(message) }),
      'LNK1104'
    )
    expect(result.kind).toBe('no-evidence')
    if (result.kind !== 'no-evidence') return
    expect(result.note).toBe('信息链里没找到相关记录。')
    expect(result.citations?.map((citation) => citation.segmentId)).toEqual([1])
    expect(logs.some((message) => message.includes('按没找到保留说明'))).toBe(true)
    // 模型确实被问过了（回退路径照常出云），只是结果被归一
    expect(client.askRequests).toHaveLength(1)
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

  it('日预算用完：报 budget，不出云', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([])
    const result = await askChain(buildDeps(client, { overBudget: () => true }), 'LNK1104')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('budget')
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
    const result = await askChain(
      { db, outbound: createCloudAskOutbound(), resolveClient: () => ({ ok: true, client }) },
      '任何问题'
    )
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
    expect(parseChainReply({ answer: '有', citations: 'nope' }, meta)).toMatchObject({
      ok: false,
      reason: 'shape'
    })
    expect(parseChainReply({ answer: '   ', citations: [] }, meta)).toMatchObject({
      ok: false,
      reason: 'shape'
    })
  })

  it('解析：{"ask":...} 走确认出口；候选去空 / 去重 / 截断', () => {
    const meta = new Map([[1, { segmentId: 1, at: 0, app: 'A', title: 'T' }]])
    const parsed = parseChainReply(
      { ask: '  想找上午还是下午的？ ', options: ['上午', '上午', '', 42, '下午'] },
      meta
    )
    expect(parsed).toMatchObject({
      ok: true,
      kind: 'clarify',
      question: '想找上午还是下午的？',
      options: ['上午', '下午']
    })
    // ask 是空白 → 仍按答复解析，answer 缺失就是结构不对
    expect(parseChainReply({ ask: '   ' }, meta)).toMatchObject({ ok: false, reason: 'shape' })
  })

  it('解析：citations 为空但写了说明 → insufficient（说明不再被丢掉）', () => {
    const meta = new Map([[1, { segmentId: 1, at: 0, app: 'A', title: 'T' }]])
    const parsed = parseChainReply(
      { answer: '查到了 10-27 的 DSH 段，但都没有「第一次打开」的锚点。', citations: [] },
      meta
    )
    expect(parsed).toMatchObject({
      ok: true,
      kind: 'insufficient',
      answer: '查到了 10-27 的 DSH 段，但都没有「第一次打开」的锚点。',
      citations: []
    })
  })

  it('解析：只靠日记回答时 citations 可以省略（模型漏字段不该整次失败）', () => {
    const memoryMeta = new Map([
      [4460, { itemId: 4460, day: '2026-10-02', section: 'Diary', text: '完成比完美更重要' }]
    ])
    // 真机 2026-10-29：模型给了 memories、没给 citations → 旧实现报「citations 不是数组」
    const parsed = parseChainReply(
      { answer: '最近主要在说完成比完美更重要。', memories: [{ itemId: 4460, why: '10-02 的想法' }] },
      new Map(),
      { memoryMeta }
    )
    expect(parsed).toMatchObject({ ok: true, kind: 'answer', citations: [] })
    if (!parsed.ok || parsed.kind !== 'answer') throw new Error('expected answer')
    expect(parsed.memories).toHaveLength(1)
    expect(parsed.memories[0]?.day).toBe('2026-10-02')
  })

  it('解析：显式 insufficient + 引用 → 保留说明与引用', () => {
    const meta = new Map([[1, { segmentId: 1, at: 0, app: 'A', title: 'T' }]])
    const parsed = parseChainReply(
      { answer: '这些只是相关', citations: [{ segmentId: 1, why: '相关' }], insufficient: true },
      meta
    )
    expect(parsed).toMatchObject({ ok: true, kind: 'insufficient' })
    if (parsed.ok && parsed.kind === 'insufficient') {
      expect(parsed.citations.map((citation) => citation.segmentId)).toEqual([1])
    }
  })

  it('解析：只有一句「信息链里没找到」时仍按没找到收口', () => {
    const meta = new Map([[1, { segmentId: 1, at: 0, app: 'A', title: 'T' }]])
    expect(parseChainReply({ answer: '信息链里没找到', citations: [] }, meta)).toMatchObject({
      ok: false,
      reason: 'no-citations'
    })
    expect(parseChainReply({ answer: '信息链里没找到。', citations: [] }, meta)).toMatchObject({
      ok: false,
      reason: 'no-citations'
    })
  })

  it('循环载荷：连续追问的历史会重新脱敏（命中密码类整轮丢，正常轮保留）', () => {
    const built = buildChainAskLoopPayload({
      question: '那下午呢',
      systemTime: '2026-10-27 09:00 周二',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      history: [
        { question: '密码 123456 是哪次', answer: '在写代码' },
        { question: '上午在干什么', answer: '密码 abc123 那次' },
        { question: '上午在干什么', answer: '在写代码' }
      ]
    })
    // 前两轮都命中敏感规则整轮丢；第三轮原样留下
    expect(built.payload.history).toEqual([{ question: '上午在干什么', answer: '在写代码' }])
  })

  it('循环载荷：历史轮数有上限（只带最近 4 轮）', () => {
    const built = buildChainAskLoopPayload({
      question: '继续',
      systemTime: '2026-10-27 09:00 周二',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      history: Array.from({ length: 7 }, (_, index) => ({ question: `问 ${index}`, answer: `答 ${index}` }))
    })
    expect(built.payload.history.map((turn) => turn.question)).toEqual(['问 3', '问 4', '问 5', '问 6'])
  })

  it('循环载荷：最近一段的应用命中密码类词 → 整条不带（不出云）', () => {
    const built = buildChainAskLoopPayload({
      question: '这个界面',
      systemTime: '2026-10-27 09:00 周二',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [],
      recent: { app: '1Password.exe', title: 'Vault', at: 0 }
    })
    expect(built.payload.recent).toBeUndefined()
  })

  it('循环载荷：工具参数的键名也过脱敏（blocked 键整条丢，正常键原样）', () => {
    const built = buildChainAskLoopPayload({
      question: '随便问问',
      systemTime: '2026-10-27 09:00 周二',
      freshness: { latestEvidenceTs: null, captureRunning: false },
      turns: [
        {
          toolCall: {
            name: 'search_info',
            arguments: {
              '密码 123456': 1,
              'keywords': [{ '密码 abc123': ['x'], 'text': '正常值' }]
            }
          },
          toolResult: { kind: 'get_freshness', freshness: { latestEvidenceTs: null, captureRunning: false } }
        }
      ]
    })
    const args = built.payload.turns[0].toolCall.arguments
    const wire = JSON.stringify(args)
    // 键名命中密码类词：整条丢掉 / 不写入（不留键、不留值）
    expect(wire).not.toContain('123456')
    expect(wire).not.toContain('abc123')
    // 正常键与数字值原样（别把 limit / 布尔脱成字符串）
    expect(args.keywords).toEqual([{ text: '正常值' }])
  })
})
