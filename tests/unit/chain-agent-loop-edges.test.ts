/**
 * 问记忆 · 工具循环：边界、脱敏与路由回归（QA 补测）
 *
 * 判定口径只有三条，不看实现：
 * - 送云载荷（`FakeLlmClient.askLoopRequests` / `buildChainAskLoopPayload()` 的产出）里
 *   不该出现未经脱敏的屏幕文本；
 * - 结构化结果（`kind` / `reason` / `stats` / `citations`）该如实反映发生过的事；
 * - 客户端能力路由不该两条路径互串。
 *
 * 用例名带 `（回归）` 的是 2026-10-27 两轮验收获判源码 Bug 的回归用例：
 * 它们曾经是红的，修复后必须一直绿——不要在实现变化时改断言方向。
 *
 * 第 2 轮残余（工具参数的**键名**未脱敏）已随 `redactArgsKey()` 修复：
 * 键名用例本文件与 `chain-agent-ask.test.ts` 各有一条（本文件另覆盖键长截断与条数上限）。
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import { ASK_LOOP_MAX_TOOL_CALLS, ASK_LOOP_MAX_TOOL_TURNS } from '../../src/chain/agent/loop'
import { createAskToolExecutor } from '../../src/chain/agent/tools'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, openSegment, type ChainDb } from '../../src/chain/store'
import { appendAskHistory, readAskHistory } from '../../src/main/ask-history'
import {
  buildChainAskLoopMessages,
  createDeepSeekClient
} from '../../src/understand/cloud/deepseek'
import {
  FakeLlmClient,
  type LlmClient
} from '../../src/understand/cloud/llm-client'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'
import { buildChainAskLoopPayload } from '../../src/understand/cloud/redact'

/** 本地 2026-10-27 09:00（周二） */
const NOW = new Date(2026, 9, 27, 9, 0, 0, 0).getTime()
const at = (seconds: number): number => NOW + seconds * 1000
const SYSTEM_TIME = '2026-10-27 09:00 周二'
const NO_FRESHNESS = { latestEvidenceTs: null, captureRunning: false }

let db: ChainDb
const tempDirs: string[] = []

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* 造库辅助                                                            */
/* ------------------------------------------------------------------ */

interface SeedOptions {
  pid: number
  app: string
  title: string
  from: number
  to: number
  /** 段里的内容行；给多条就测「同一段不同关键词命中不同行」 */
  texts: readonly string[]
}

function seed(options: SeedOptions): number {
  const exe = `app${options.pid}`
  const id = openSegment(
    db,
    { startTs: options.from, pid: options.pid, exe, app: options.app, hwnd: options.pid * 10, title: options.title },
    options.from
  )
  options.texts.forEach((text, index) => {
    insertContent(db, {
      segmentId: id,
      capturedAt: options.from + 1_000 + index,
      source: 'uia',
      text
    })
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

function seedOne(pid: number, app: string, from: number, text: string): number {
  return seed({ pid, app, title: `标题 ${pid}`, from, to: from + 60_000, texts: [text] })
}

/** 循环路径的依赖：FakeLlmClient 自带 completeAskLoop，注入固定钟与采集态 */
function buildDeps(client: LlmClient, extra: Partial<ChainAskOptions> = {}): ChainAskOptions {
  return {
    db,
    outbound: createCloudAskOutbound(),
    resolveClient: () => ({ ok: true, client }),
    now: () => NOW,
    captureRunning: () => false,
    ...extra
  }
}

const searchCall = (
  arguments_: Record<string, unknown>
): { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> } => ({
  toolCalls: [{ name: 'search_info', arguments: arguments_ }]
})

const freshnessCalls = (
  count: number
): { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> } => ({
  toolCalls: Array.from({ length: count }, (_, index) => ({
    id: `fresh_${index}`,
    name: 'get_freshness',
    arguments: {}
  }))
})

/** 工具执行器（参数边界类用例直接测这一层，避免被循环轮数干扰） */
function executor(): ReturnType<typeof createAskToolExecutor> {
  return createAskToolExecutor({ db, now: () => NOW, captureRunning: () => false })
}

type SearchHits = Array<{ segmentId: number; snippet: string; at: string; urls?: string[] }>
type ToolResultView = { kind: string; message?: string; hits?: SearchHits; stats?: { mode: string } }

/**
 * 真客户端 + 假 fetch：第一次响应返回带指定参数串的 tool_call，第二次返回最终答复，
 * 返回**第二次请求的 wire body**（唯一出口的端到端口径：脱敏后的参数必须真的落在 body 里）。
 */
async function runWithToolArguments(toolArguments: string): Promise<string> {
  const bodies = [
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'search_info', arguments: toolArguments } }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }),
    JSON.stringify({
      choices: [{ message: { content: '{"answer":"信息链里没找到","citations":[]}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
  ]
  let served = 0
  const fetchImpl = vi.fn(
    async () =>
      new Response(bodies[Math.min(served++, bodies.length - 1)], {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  const client = createDeepSeekClient({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'test-key',
    sleep: async () => {},
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  await askChain(buildDeps(client), '那次我干了什么')
  const [, secondInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
  return String(secondInit.body)
}

/** 从 wire body 里取回填的 assistant tool_call 参数（已脱敏的那一份） */
function sentToolArguments(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as {
    messages: Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }>
  }
  const assistant = parsed.messages.find((message) => message.role === 'assistant' && message.tool_calls)
  const raw = assistant?.tool_calls?.[0]?.function.arguments ?? '{}'
  return JSON.parse(raw) as Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* 1. 送云脱敏（唯一出口纪律）                                          */
/* ------------------------------------------------------------------ */

describe('工具循环 · 送云脱敏', () => {
  const loopPayload = (arguments_: Record<string, unknown>, name = 'search_info') =>
    buildChainAskLoopPayload({
      question: '随便问问',
      systemTime: SYSTEM_TIME,
      freshness: NO_FRESHNESS,
      turns: [
        {
          toolCall: { name, arguments: arguments_ },
          toolResult: { kind: 'get_freshness', freshness: NO_FRESHNESS }
        }
      ]
    })

  it('字符串叶子逐个脱敏：命中密码类规则的值替换为空串（正面对照）', () => {
    const built = loopPayload({ keywords: ['密码 123456', '正常词'] })
    expect(built.payload.turns[0].toolCall.arguments.keywords).toEqual(['', '正常词'])
  })

  it('arguments 里的嵌套对象：字符串叶子也要脱敏（回归）', () => {
    // 模型输出不可信：schema 是平的，但 arguments 是任意 JSON 对象，解析层不校验形状
    const built = loopPayload({ keywords: [{ text: '密码 123456' }] })
    expect(JSON.stringify(built.payload.turns[0].toolCall.arguments)).not.toContain('123456')
  })

  it('arguments 的字符串数组里混对象：对象内文本也要脱敏（回归）', () => {
    const built = loopPayload({ keywords: ['正常词', { note: '密码 abc123' }] })
    expect(JSON.stringify(built.payload.turns[0].toolCall.arguments)).not.toContain('abc123')
  })

  it('嵌套结构的脱敏结果形状固定：叶子被替换而不是整条丢弃（回归）', () => {
    // 等式断言（比 not.toContain 更严）：既防「漏脱」，也防「过度丢弃参数」的回退
    const built = loopPayload({ keywords: [{ text: '密码 123456', keep: '正常词' }], limit: 5 })
    expect(built.payload.turns[0].toolCall.arguments).toEqual({
      keywords: [{ text: '', keep: '正常词' }],
      limit: 5
    })
  })

  it('超过深度上限的容器整体折叠（fail-safe，不原样放行）（回归）', () => {
    const built = loopPayload({ a: { b: { c: { d: { e: { f: '密码 777' } } } } } })
    expect(built.payload.turns[0].toolCall.arguments).toEqual({
      a: { b: { c: { d: { e: '[嵌套过深]' } } } }
    })
    expect(JSON.stringify(built.payload.turns[0].toolCall.arguments)).not.toContain('777')
  })

  it('工具名也过脱敏：blocked 折成 unknown、超长截断、正常名不变（回归）', () => {
    expect(loopPayload({}, '密码 999').payload.turns[0].toolCall.name).toBe('unknown')
    expect(loopPayload({}, 'x'.repeat(80)).payload.turns[0].toolCall.name).toHaveLength(40)
    expect(loopPayload({}, 'search_info').payload.turns[0].toolCall.name).toBe('search_info')
  })

  it('键名也过脱敏：blocked 键整条丢、超长键截断、条数封顶（回归）', () => {
    // 值脱敏之后，键名同样会出云（模型生成的 JSON 键是自由文本）
    expect(loopPayload({ '密码 123456': 1, ok: 2 }).payload.turns[0].toolCall.arguments).toEqual({ ok: 2 })
    expect(loopPayload({ keywords: { '密码 abc123': ['x'], fine: 1 } }).payload.turns[0].toolCall.arguments).toEqual({
      keywords: { fine: 1 }
    })
    const longKey = Object.keys(loopPayload({ ['k'.repeat(90)]: 1 }).payload.turns[0].toolCall.arguments)[0]
    expect(longKey).toHaveLength(64)
    // 超长参数不该撑爆载荷：数组 / 对象都封顶 32
    const many = loopPayload({ keywords: Array.from({ length: 50 }, (_, index) => `k${index}`) })
    expect(many.payload.turns[0].toolCall.arguments.keywords as string[]).toHaveLength(32)
  })

  it('参数键名命中密码类规则：整个键值对丢弃，wire body 里键和值都不出现（回归）', async () => {
    const body = await runWithToolArguments(JSON.stringify({ '密码 123456': 1, keywords: ['正常词'] }))
    expect(body).not.toContain('123456')
    expect(body).not.toContain('密码')
    // 正常键照常出云（不是整包丢弃）
    expect(body).toContain('正常词')
  })

  it('参数数组 / 对象超过 32 项：只保留前 32（wire body 断言）（回归）', async () => {
    const many = (prefix: string): string[] =>
      Array.from({ length: 40 }, (_, index) => `${prefix}${index}`)
    const args = {
      list: many('item'),
      map: Object.fromEntries(many('key').map((key) => [key, 1]))
    }
    const body = await runWithToolArguments(JSON.stringify(args))
    const sent = sentToolArguments(body) as { list: string[]; map: Record<string, unknown> }
    expect(sent.list).toHaveLength(32)
    expect(Object.keys(sent.map)).toHaveLength(32)
    expect(sent.list[31]).toBe('item31')
    expect(body).not.toContain('item39')
  })

  it('嵌套参数真的上了 wire：第二次请求体里看不到原文（回归）', async () => {
    // 端到端口径：真客户端 + 假 fetch，模型的 tool_call 参数里塞嵌套对象
    const bodies = [
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'search_info', arguments: '{"keywords":[{"text":"密码 123456"}]}' }
                }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }),
      JSON.stringify({
        choices: [{ message: { content: '{"answer":"信息链里没找到","citations":[]}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    ]
    let served = 0
    const fetchImpl = vi.fn(
      async () =>
        new Response(bodies[Math.min(served++, bodies.length - 1)], {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    const client = createDeepSeekClient({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'test-key',
      sleep: async () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const result = await askChain(buildDeps(client), '那次我干了什么')
    expect(result.kind).toBe('no-evidence')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [, secondInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(String(secondInit.body)).not.toContain('123456')
  })
})

/* ------------------------------------------------------------------ */
/* 2. 失败路径的诊断数                                                  */
/* ------------------------------------------------------------------ */

describe('工具循环 · 失败路径的统计口径', () => {
  it('客户端中途抛错：已经查到的命中数不该归零（回归）', async () => {
    seedOne(1, 'Visual Studio Code', at(0), '编译报 LNK1104')
    const client = new FakeLlmClient([searchCall({ keywords: ['LNK1104'] }), new Error('网络断了')])
    const result = await askChain(buildDeps(client), 'LNK1104')

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('failed')
    // 第一轮真的查到了 1 段、也真的给模型看过：失败收口也要留下这个事实
    expect(result.stats.hits).toBe(1)
    expect(result.stats.evidence).toBe(1)
  })

  it('收尾轮失败收口：之前查到过的命中数不该归零（回归）', async () => {
    seedOne(1, 'Visual Studio Code', at(0), '编译报 LNK1104')
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      ...Array.from({ length: ASK_LOOP_MAX_TOOL_TURNS - 1 }, () => freshnessCalls(1)),
      // 强制收尾轮，假客户端仍塞了工具调用：驱动层忽略 → 没有最终 JSON → unparseable
      freshnessCalls(1)
    ])
    const paused = await askChain(buildDeps(client), 'LNK1104')
    expect(paused.kind).toBe('continue-ask')
    if (paused.kind !== 'continue-ask' || !paused.resumeId) return
    // 选「先按现在的结果回答」：恢复后的收尾轮，假客户端仍塞工具调用 → 没有最终 JSON
    const result = await askChain(
      buildDeps(client, { resume: { id: paused.resumeId, decision: 'stop' } }),
      ''
    )

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('unparseable')
    expect(result.stats).toMatchObject({
      turns: ASK_LOOP_MAX_TOOL_TURNS + 1,
      toolCalls: ASK_LOOP_MAX_TOOL_TURNS
    })
    expect(result.stats.hits).toBe(1)
    expect(result.stats.evidence).toBe(1)
  })

  it('统计不是硬编码：抛错前检索到 2 段 → hits 2；一次都没检索就抛错 → hits 0', async () => {
    // 两段都命中同一个词（时间不重叠）
    seedOne(1, 'Firefox', at(0), 'LNK1104 的第一条记录')
    seedOne(2, 'Visual Studio Code', at(300), 'LNK1104 的第二条记录')

    const twoHits = new FakeLlmClient([searchCall({ keywords: ['LNK1104'] }), new Error('网络断了')])
    const withHits = await askChain(buildDeps(twoHits), 'LNK1104')
    expect(withHits.kind).toBe('error')
    // 两段都真的返回给了模型：hits=2、evidence=2（不是常量 1）
    expect(withHits.stats).toMatchObject({ hits: 2, evidence: 2 })

    // 对照组：一轮工具都没跑就抛错，必须如实为 0（不是常量非零）
    const noSearch = new FakeLlmClient([new Error('网络断了')])
    const withoutHits = await askChain(buildDeps(noSearch), 'LNK1104')
    expect(withoutHits.kind).toBe('error')
    expect(withoutHits.stats).toMatchObject({ hits: 0, evidence: 0, toolCalls: 0 })
  })

  it(`超调用数收口（第 ${ASK_LOOP_MAX_TOOL_CALLS + 1} 个被拒）：也要带上前一轮已经检索到的量`, async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      freshnessCalls(ASK_LOOP_MAX_TOOL_CALLS / 2),
      freshnessCalls(ASK_LOOP_MAX_TOOL_CALLS / 2 - 1),
      freshnessCalls(1)
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('failed')
    // 1 + 8 + 7 = 16 个已执行，第 17 个被拒
    expect(result.stats).toMatchObject({
      toolCalls: ASK_LOOP_MAX_TOOL_CALLS,
      hits: 1,
      evidence: 1
    })
  })
})

/* ------------------------------------------------------------------ */
/* 3. 同一轮多个 tool_calls                                            */
/* ------------------------------------------------------------------ */

describe('工具循环 · 一轮多个 tool_calls', () => {
  it('一轮两个调用：拆成两条 turn，消息 id 不冲突且 tool 消息对得上', async () => {
    const first = seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const second = seedOne(2, 'Visual Studio Code', at(120), 'Electron 的说明')

    const client = new FakeLlmClient([
      {
        toolCalls: [
          { id: 'real_id_a', name: 'search_info', arguments: { keywords: ['LNK1104'] } },
          { id: 'real_id_b', name: 'search_info', arguments: { keywords: ['Electron'] } }
        ]
      },
      {
        json: {
          answer: '两段都提到过。',
          citations: [
            { segmentId: first, why: '报错那段' },
            { segmentId: second, why: '说明那段' }
          ]
        }
      }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104 和 Electron')

    // 两个调用都执行了、都进了 turn（不是只留最后一个）
    const payload = client.askLoopRequests[1]
    expect(payload.turns).toHaveLength(2)
    // 白名单齐全：两边的段都能被引用
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((citation) => citation.segmentId)).toEqual([first, second])
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 2 })

    // 回填消息：assistant / tool 两边的 id 一一对应且不重复
    const messages = buildChainAskLoopMessages(payload)
    const assistantIds = messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.toolCalls?.[0]?.id)
    const toolIds = messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)
    expect(assistantIds).toEqual(['call_0', 'call_1'])
    expect(toolIds).toEqual(['call_0', 'call_1'])
    expect(new Set(assistantIds).size).toBe(2)
    // tool 消息内容就是对应的那一轮摘要（顺序不错位）
    const toolContents = messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content) as ToolResultView)
    expect(toolContents[0].hits?.map((hit) => hit.segmentId)).toEqual([first])
    expect(toolContents[1].hits?.map((hit) => hit.segmentId)).toEqual([second])
  })

  it('一轮三个调用（含一个未知工具）：未知工具回 error 摘要，其余照常执行', async () => {
    const seg = seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const client = new FakeLlmClient([
      {
        toolCalls: [
          { name: 'search_info', arguments: { keywords: ['LNK1104'] } },
          { name: 'delete_everything', arguments: {} },
          { name: 'get_freshness', arguments: {} }
        ]
      },
      { json: { answer: '找到了。', citations: [{ segmentId: seg, why: '记录' }] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('answer')
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 3 })

    const views = client.askLoopRequests[1].turns.map(
      (turn) => turn.toolResult as ToolResultView
    )
    expect(views.map((view) => view.kind)).toEqual(['search_info', 'error', 'get_freshness'])
    expect(views[1].message).toContain('未知工具')
  })
})

/* ------------------------------------------------------------------ */
/* 4. 工具参数边界                                                      */
/* ------------------------------------------------------------------ */

describe('工具循环 · 工具参数边界', () => {
  it('from > to：回 error 摘要，不抛异常，循环继续到最终答复', async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'], from: at(600), to: at(0) }),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('no-evidence')
    const view = client.askLoopRequests[1].turns[0].toolResult as ToolResultView
    expect(view.kind).toBe('error')
    expect(view.message).toContain('参数不合法')
  })

  it('keywords 空数组 / 完全空参数：报参数不合法（不把整库倒出来）', async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const tool = executor()

    const emptyKeywords = await tool.execute({ name: 'search_info', arguments: { keywords: [] } })
    expect(emptyKeywords.result.kind).toBe('error')
    expect(emptyKeywords.segments).toHaveLength(0)

    const noArgs = await tool.execute({ name: 'search_info', arguments: {} })
    expect(noArgs.result.kind).toBe('error')

    // 全是空白/非字符串的关键词也等于没有条件
    const blank = await tool.execute({ name: 'search_info', arguments: { keywords: ['  ', 42, null] } })
    expect(blank.result.kind).toBe('error')
  })

  it('keywords 超过 8 个：只取前 8 个（第 9 个词查不到）', async () => {
    seedOne(1, 'Firefox', at(0), 'NINTHWORD 的记录')
    const tool = executor()
    const keywords = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'NINTHWORD']

    const sliced = await tool.execute({ name: 'search_info', arguments: { keywords } })
    const slicedHits = (sliced.result as unknown as { kind: string; hits: SearchHits }).hits
    expect(slicedHits).toHaveLength(0)

    // 对照：把同一个词放到第 1 个位置就能命中（证明是「被切片丢掉了」而不是查不到）
    const kept = await tool.execute({ name: 'search_info', arguments: { keywords: ['NINTHWORD', ...keywords.slice(0, 8)] } })
    expect(((kept.result as unknown as { hits: SearchHits }).hits).map((hit) => hit.segmentId)).toEqual([1])
  })

  it('limit 钳制：缺省 8、100 → 20、0 → 1、2.7 → 3', async () => {
    // 25 段全部命中同一个词（时间不重叠，段之间必须递增）
    for (let index = 0; index < 25; index++) {
      seedOne(index + 1, `App${index}`, at(index * 300), `MAGICWORD 第 ${index} 段`)
    }
    const tool = executor()
    const hitsOf = async (limit?: number): Promise<number> => {
      const outcome = await tool.execute({
        name: 'search_info',
        arguments: limit === undefined ? { keywords: ['MAGICWORD'] } : { keywords: ['MAGICWORD'], limit }
      })
      return (outcome.result as unknown as { hits: SearchHits }).hits.length
    }

    expect(await hitsOf()).toBe(8)
    expect(await hitsOf(100)).toBe(20)
    expect(await hitsOf(0)).toBe(1)
    expect(await hitsOf(2.7)).toBe(3)
    expect(await hitsOf(-5)).toBe(1)
  })

  it('ask_history：from/to 过滤生效，limit 上限 50', async () => {
    const history = Array.from({ length: 60 }, (_, index) => ({
      at: at(index),
      question: `问题 ${index}`,
      kind: 'answer'
    }))
    const tool = createAskToolExecutor({
      db,
      now: () => NOW,
      captureRunning: () => false,
      readAskHistory: () => history
    })

    const ranged = await tool.execute({
      name: 'ask_history',
      arguments: { from: at(10), to: at(20), limit: 100 }
    })
    const rangedEntries = (ranged.result as unknown as { entries: Array<{ time: string }> }).entries
    expect(rangedEntries).toHaveLength(11)
    // 条目只带本地时刻（可读），不再带毫秒时间戳：模型自己换算是「时间变来变去」的根因
    expect(rangedEntries[0].time).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(rangedEntries[0]).not.toHaveProperty('at')

    const capped = await tool.execute({ name: 'ask_history', arguments: { limit: 100 } })
    expect((capped.result as unknown as { entries: unknown[] }).entries).toHaveLength(50)

    // 没接历史：返回空数组，不抛
    const bare = await executor().execute({ name: 'ask_history', arguments: {} })
    expect((bare.result as unknown as { entries: unknown[] }).entries).toEqual([])
  })

  it('ask_history order=oldest：按时间正序返回最早几条（问「第一次」用）', async () => {
    const history = Array.from({ length: 60 }, (_, index) => ({
      at: at(index),
      question: `问题 ${index}`,
      kind: 'answer'
    }))
    const tool = createAskToolExecutor({
      db,
      now: () => NOW,
      captureRunning: () => false,
      readAskHistory: () => history
    })

    const oldest = await tool.execute({
      name: 'ask_history',
      arguments: { order: 'oldest', limit: 5 }
    })
    const entries = (oldest.result as unknown as { entries: Array<{ question: string }> })
      .entries
    expect(entries.map((entry) => entry.question)).toEqual([
      '问题 0',
      '问题 1',
      '问题 2',
      '问题 3',
      '问题 4'
    ])
  })

  it('read_segment：展开完整正文与 urls，只能读检索过的段', async () => {
    const url = 'https://www.bilibili.com/video/BV1fopY6QEmP/?vd_source=abc'
    const seg = seed({
      pid: 1,
      app: 'Firefox',
      title: 'B 站视频',
      from: at(0),
      to: at(60_000),
      texts: ['顶部菜单与推荐位文字 ', `地址栏 ${url}`, '页面正文后半段']
    })
    const tool = createAskToolExecutor({
      db,
      now: () => NOW,
      captureRunning: () => false,
      canReadSegment: (id) => id === seg
    })

    const full = await tool.execute({ name: 'read_segment', arguments: { segmentId: seg } })
    const view = full.result as unknown as {
      kind: string
      text: string
      urls: string[]
      offset: number
      limit: number
    }
    expect(view.kind).toBe('read_segment')
    expect(view.text).toContain('顶部菜单')
    expect(view.text).toContain(url)
    expect(view.urls).toEqual([url])

    // 未在 search_info 里出现过的段：拒绝（不按段号扫库）
    const denied = await tool.execute({ name: 'read_segment', arguments: { segmentId: seg + 99 } })
    expect((denied.result as unknown as { kind: string }).kind).toBe('error')

    // 缺 segmentId / 非法 offset：变成 error，不抛
    const missing = await tool.execute({ name: 'read_segment', arguments: {} })
    expect((missing.result as unknown as { kind: string }).kind).toBe('error')
    const paged = await tool.execute({
      name: 'read_segment',
      arguments: { segmentId: seg, offset: 3, limit: 20 }
    })
    expect(paged.result).toMatchObject({ kind: 'read_segment', offset: 3, limit: 20 })
  })

  it('read_segment：正文几万字时用 query 直接跳到要找的地方，不是只读开头', async () => {
    // 真实记录：插件市场列表在段正文第 4 万字符附近，80 字摘要只截到侧栏
    const deep = '插件市场\ndsh-market\nv1.66.36\n全部 (7.2k)\nAGI 架构探索'
    const seg = seed({
      pid: 1,
      app: 'DSH NEXT',
      title: '工作区文档屏蔽插件 — DeepSeek Harness',
      from: at(0),
      to: at(60_000),
      texts: [`${'侧边栏与会话列表 '.repeat(3000)}${deep}`]
    })
    const tool = createAskToolExecutor({
      db,
      now: () => NOW,
      captureRunning: () => false,
      canReadSegment: (id) => id === seg
    })

    const opened = await tool.execute({
      name: 'read_segment',
      arguments: { segmentId: seg, query: 'dsh-market' }
    })
    expect((opened.result as unknown as { kind: string }).kind).toBe('read_segment')
    const built = buildChainAskLoopPayload({
      question: '插件市场里面有啥',
      systemTime: SYSTEM_TIME,
      freshness: NO_FRESHNESS,
      turns: [{ toolCall: { name: 'read_segment', arguments: { segmentId: seg, query: 'dsh-market' } }, toolResult: opened.result }]
    })
    const view = built.payload.turns[0].toolResult as unknown as { text: string; offset: number }
    expect(view.offset).toBeGreaterThan(0)
    expect(view.text).toContain('全部 (7.2k)')
    expect(view.text).toContain('AGI 架构探索')
  })

  it('read_segment 送云时按 offset/limit 切正文；命中密码类规则整段不展开', () => {
    const safe = buildChainAskLoopPayload({
      question: 'q',
      systemTime: SYSTEM_TIME,
      freshness: NO_FRESHNESS,
      turns: [
        {
          toolCall: { name: 'read_segment', arguments: { segmentId: 1, offset: 2, limit: 5 } },
          toolResult: {
            kind: 'read_segment',
            freshness: NO_FRESHNESS,
            segmentId: 1,
            at: '10-27 09:00',
            app: 'Firefox',
            title: 'B 站',
            text: '0123456789',
            urls: [],
            offset: 2,
            limit: 5
          }
        }
      ]
    })
    const safeView = safe.payload.turns[0].toolResult as unknown as {
      text: string
      offset: number
      totalChars: number
      truncated: boolean
    }
    expect(safeView.text).toBe('23456')
    expect(safeView).toMatchObject({ offset: 2, totalChars: 10, truncated: true })

    const blocked = buildChainAskLoopPayload({
      question: 'q',
      systemTime: SYSTEM_TIME,
      freshness: NO_FRESHNESS,
      turns: [
        {
          toolCall: { name: 'read_segment', arguments: { segmentId: 2, offset: 0, limit: 200 } },
          toolResult: {
            kind: 'read_segment',
            freshness: NO_FRESHNESS,
            segmentId: 2,
            at: '10-27 09:00',
            app: 'Firefox',
            title: '登录页',
            text: '请输入密码 hunter2 登录',
            urls: [],
            offset: 0,
            limit: 300
          }
        }
      ]
    })
    const blockedView = blocked.payload.turns[0].toolResult as unknown as {
      kind: string
      text?: string
    }
    expect(blockedView.kind).toBe('error')
    expect(blockedView.text).toBeUndefined()
  })

  it('search_info 带出段内网址（snippet 截断也不丢）', async () => {
    const safeUrl = 'https://www.bilibili.com/video/BV1fopY6QEmP/?vd_source=abc'
    const seg = seed({
      pid: 1,
      app: 'Firefox',
      title: 'B 站',
      from: at(0),
      to: at(60_000),
      texts: ['SAFEWORD 的页面正文', `地址栏 ${safeUrl}`]
    })

    const outcome = await executor().execute({
      name: 'search_info',
      arguments: { keywords: ['SAFEWORD'] }
    })
    const hit = (outcome.result as unknown as { hits: SearchHits }).hits.find(
      (item) => item.segmentId === seg
    )
    expect(hit?.urls).toEqual([safeUrl])
  })

  it('段内网址送云前逐条脱敏：命中密码类规则的整条丢弃，不连坐段', () => {
    const safeUrl = 'https://www.bilibili.com/video/BV1fopY6QEmP/?vd_source=abc'
    const blockedUrl = 'https://example.com/login?password=supersecret'
    const built = buildChainAskLoopPayload({
      question: '链接',
      systemTime: SYSTEM_TIME,
      freshness: NO_FRESHNESS,
      turns: [
        {
          toolCall: { name: 'search_info', arguments: { keywords: ['SAFEWORD'] } },
          toolResult: {
            kind: 'search_info',
            freshness: NO_FRESHNESS,
            hits: [
              {
                segmentId: 1,
                at: '09:00',
                app: 'Firefox',
                title: 'B 站',
                snippet: 'SAFEWORD 的页面正文',
                tags: [],
                links: [],
                urls: [safeUrl, blockedUrl]
              }
            ],
            stats: { mode: 'keywords', keywordRows: 1 }
          }
        }
      ]
    })
    const hits = (
      built.payload.turns[0].toolResult as { hits: Array<{ urls: string[] }> }
    ).hits
    expect(hits[0].urls).toEqual([safeUrl])
  })

  it('纯过滤检索（只给 app）：只列该应用的段，mode=filter', async () => {
    const firefox = seedOne(1, 'Firefox', at(0), '看文档')
    seedOne(2, 'Visual Studio Code', at(120), '写代码')

    const outcome = await executor().execute({ name: 'search_info', arguments: { app: 'Firefox' } })
    const view = outcome.result as unknown as { kind: string; hits: SearchHits; stats: { mode: string } }
    expect(view.stats.mode).toBe('filter')
    expect(view.hits.map((hit) => hit.segmentId)).toEqual([firefox])
    expect(outcome.segments.map((meta) => meta.segmentId)).toEqual([firefox])
  })

  it('只给语义短语但语义路不可用（没接 embedder）：退化成最近段倒序（现状记录）', async () => {
    seedOne(1, 'Firefox', at(0), '完全无关的内容 A')
    seedOne(2, 'Visual Studio Code', at(120), '完全无关的内容 B')

    // 现状：embedder 缺席时 semantic 被静默忽略，filterOnly 分支把最近段倒出来，
    // 模型会拿到一批「与问题无关但确实存在」的段（fails-safe 但不精准）。
    const outcome = await executor().execute({
      name: 'search_info',
      arguments: { semantic: '和这两段都无关的短语' }
    })
    const view = outcome.result as unknown as { kind: string; hits: SearchHits; stats: { mode: string } }
    expect(view.kind).toBe('search_info')
    expect(view.stats.mode).toBe('filter')
    expect(view.hits.map((hit) => hit.segmentId)).toEqual([2, 1])
  })
})

/* ------------------------------------------------------------------ */
/* 5. 轮数与调用数边界                                                  */
/* ------------------------------------------------------------------ */

describe('工具循环 · 轮数与调用数边界', () => {
  it(`最后一轮工具轮（第 ${ASK_LOOP_MAX_TOOL_TURNS} 轮）直接给最终答复：成功（不误判成超轮）`, async () => {
    const seg = seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      ...Array.from({ length: ASK_LOOP_MAX_TOOL_TURNS - 2 }, () => freshnessCalls(1)),
      { json: { answer: '最后一轮才给答复。', citations: [{ segmentId: seg, why: '记录' }] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('answer')
    expect(result.stats).toMatchObject({
      turns: ASK_LOOP_MAX_TOOL_TURNS,
      toolCalls: ASK_LOOP_MAX_TOOL_TURNS - 1
    })
    expect(client.askLoopRequests).toHaveLength(ASK_LOOP_MAX_TOOL_TURNS)
  })

  it(`累计第 ${ASK_LOOP_MAX_TOOL_CALLS} 个工具调用允许、第 ${ASK_LOOP_MAX_TOOL_CALLS + 1} 个拒绝`, async () => {
    // 上限内：允许收口到最终答复
    const allowed = new FakeLlmClient([
      freshnessCalls(ASK_LOOP_MAX_TOOL_CALLS / 2),
      freshnessCalls(ASK_LOOP_MAX_TOOL_CALLS / 2),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const allowedResult = await askChain(buildDeps(allowed), '我在干什么')
    expect(allowedResult.kind).toBe('no-evidence')
    expect(allowedResult.stats).toMatchObject({
      turns: 3,
      toolCalls: ASK_LOOP_MAX_TOOL_CALLS
    })

    // 超一个：第 3 轮那一个不执行，failed 收口
    const rejected = new FakeLlmClient([
      freshnessCalls(ASK_LOOP_MAX_TOOL_CALLS / 2),
      freshnessCalls(ASK_LOOP_MAX_TOOL_CALLS / 2),
      freshnessCalls(1)
    ])
    const rejectedResult = await askChain(buildDeps(rejected), '我在干什么')
    expect(rejectedResult.kind).toBe('error')
    if (rejectedResult.kind !== 'error') return
    expect(rejectedResult.reason).toBe('failed')
    expect(rejectedResult.message).toContain(String(ASK_LOOP_MAX_TOOL_CALLS))
    expect(rejectedResult.stats).toMatchObject({
      turns: 3,
      toolCalls: ASK_LOOP_MAX_TOOL_CALLS
    })
    // 超限那批不执行：第 3 轮请求看待执行的 turn 数仍在上限内
    expect(rejected.askLoopRequests[2].turns).toHaveLength(ASK_LOOP_MAX_TOOL_CALLS)
  })
})

/* ------------------------------------------------------------------ */
/* 6. 引用白名单收缩                                                    */
/* ------------------------------------------------------------------ */

describe('工具循环 · 引用白名单收缩', () => {
  it('被脱敏整条挡下的段：多轮里脱敏结果稳定，始终不出云、不可引用', async () => {
    const blocked = seedOne(1, '1password.exe', at(0), 'vault LNK1104')
    const visible = seedOne(2, 'Firefox', at(120), 'LNK1104 的记录')
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      searchCall({ keywords: ['LNK1104'] }),
      {
        json: {
          answer: '两段都算数。',
          citations: [
            { segmentId: blocked, why: '被挡的段' },
            { segmentId: visible, why: '可见的段' }
          ]
        }
      }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((citation) => citation.segmentId)).toEqual([visible])
    // 诊断口径的区分：hits = 各次 search_info 返回的命中总数（含被挡的，两轮各 2 条）；
    // evidence = 去重后真正给模型看过的段（被挡的 1password 段不在内）
    expect(result.stats).toMatchObject({ hits: 4, evidence: 1, cited: 2 })
    // 第二轮 / 第三轮的载荷里，被挡的段始终没有出现（同段同关键词 → 脱敏结果稳定）
    for (const payload of client.askLoopRequests.slice(1)) {
      const sentIds = payload.turns.flatMap((turn) => {
        const view = turn.toolResult as ToolResultView
        return (view.hits ?? []).map((hit) => hit.segmentId)
      })
      expect(sentIds).not.toContain(blocked)
    }
  })

  it('先被挡、后续轮次以干净摘要展示的段：可以引用（白名单按「当前载荷可见」收缩，非粘性）', async () => {
    // 同一段的两条内容行：关键词 PEAR 命中的那行带密码类词（整条被挡），
    // 关键词 APPLE 命中的那行是干净的（模型在后续轮次确实看到了这一段）。
    const seg = seed({
      pid: 1,
      app: 'Firefox',
      title: '笔记',
      from: at(0),
      to: at(60_000),
      texts: ['PEAR 之后改密码的步骤', 'APPLE 的报错记录']
    })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['PEAR'] }),
      searchCall({ keywords: ['APPLE'] }),
      { json: { answer: '09:00 的〈Firefox〉里记过。', citations: [{ segmentId: seg, why: '笔记那段' }] } }
    ])
    const result = await askChain(buildDeps(client), 'PEAR 和 APPLE')

    // 模型在第二轮确实看到了这一段（干净摘要进了载荷）
    const secondTurnHits = (client.askLoopRequests[2].turns[1].toolResult as ToolResultView).hits ?? []
    expect(secondTurnHits.map((hit) => hit.segmentId)).toEqual([seg])
    // 而且看到的是**干净那一条**内容行（APPLE），不是被挡的密码行
    expect(secondTurnHits[0].snippet).toContain('APPLE')
    expect(secondTurnHits[0].snippet).not.toContain('密码')
    // 第一轮那次「被挡」不会粘住白名单：后续轮次见过就能引用（曾经是 fail-safe 假阴性，
    // 已按 QA 建议改成「当前 build 里 payload 可见段 id 的并集」）
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((citation) => citation.segmentId)).toEqual([seg])
    // 安全方向不放松：被挡的那次命中始终不出现在送云载荷里
    const firstTurnHits = (client.askLoopRequests[1].turns[0].toolResult as ToolResultView).hits ?? []
    expect(firstTurnHits).toHaveLength(0)
    // 更强：被挡的那条内容行（含密码类词）在**所有**请求体里都没有出现过
    expect(JSON.stringify(client.askLoopRequests)).not.toContain('改密码')
  })
})

/* ------------------------------------------------------------------ */
/* 7. 对话记录兼容                                                      */
/* ------------------------------------------------------------------ */

describe('工具循环 · 对话记录兼容', () => {
  it('带 turns / toolCalls 的 stats 落盘后能原样读回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-ask-loop-'))
    tempDirs.push(dir)
    const path = join(dir, 'ask-history.jsonl')

    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 })

    appendAskHistory(path, {
      id: 'loop-1',
      at: NOW,
      question: 'LNK1104',
      kind:
        result.kind === 'error'
          ? 'error'
          : result.kind === 'continue-ask'
            ? 'clarify'
            : result.kind,
      citations: [],
      stats: result.stats
    })

    // isStats 只校验四个 number 键：多出来的诊断字段不该让整行作废
    const list = readAskHistory(path)
    expect(list).toHaveLength(1)
    expect(list[0].stats).toMatchObject({ hits: 1, evidence: 1, cited: 0, questionChars: 7, turns: 2, toolCalls: 1 })
  })
})

/* ------------------------------------------------------------------ */
/* 8. 客户端能力路由                                                    */
/* ------------------------------------------------------------------ */

/** 显式构造客户端（Class 方法在原型上，展开实例会丢方法） */
function bareClient(
  fake: FakeLlmClient,
  capabilities: { loop?: boolean; ask?: boolean } = {}
): LlmClient {
  const client: Record<string, unknown> = {
    completeJson: fake.completeJson.bind(fake),
    completeNaming: fake.completeNaming.bind(fake),
    completeAssignments: fake.completeAssignments.bind(fake),
    completeChainExtract: fake.completeChainExtract.bind(fake),
    completeChainMerge: fake.completeChainMerge.bind(fake)
  }
  if (capabilities.ask) client.completeAsk = fake.completeAsk.bind(fake)
  if (capabilities.loop) client.completeAskLoop = fake.completeAskLoop.bind(fake)
  return client as unknown as LlmClient
}

describe('工具循环 · 客户端能力路由', () => {
  it('两种能力都有：走循环，completeAsk 一次都不调', async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const fake = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const client = bareClient(fake, { loop: true, ask: true })
    const result = await askChain(buildDeps(client), 'LNK1104')

    expect(result.kind).toBe('no-evidence')
    expect(fake.askLoopRequests).toHaveLength(2)
    expect(fake.askRequests).toHaveLength(0)
  })

  it('只有 completeAsk：走单发回退（拼的仍是 ChainAskPayload，不是死代码）', async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const fake = new FakeLlmClient([{ json: { answer: '信息链里没找到', citations: [] } }])
    const client = bareClient(fake, { ask: true })
    const result = await askChain(buildDeps(client), 'LNK1104')

    expect(result.kind).toBe('no-evidence')
    expect(fake.askRequests).toHaveLength(1)
    // 单发载荷形状：question + evidence（buildChainAskPayload 的产物）
    expect(fake.askRequests[0].question).toBe('LNK1104')
    expect(fake.askRequests[0].evidence.length).toBeGreaterThan(0)
    expect(fake.askLoopRequests).toHaveLength(0)
  })

  it('completeAskLoop 显式为 undefined：落回单发', async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const fake = new FakeLlmClient([{ json: { answer: '信息链里没找到', citations: [] } }])
    const client = { ...bareClient(fake, { ask: true }), completeAskLoop: undefined } as LlmClient
    const result = await askChain(buildDeps(client), 'LNK1104')

    expect(result.kind).toBe('no-evidence')
    expect(fake.askRequests).toHaveLength(1)
    expect(fake.askLoopRequests).toHaveLength(0)
  })

  it('两种能力都没有 / 客户端解析失败：报 client，一次调用都不发', async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const fake = new FakeLlmClient([])

    const neither = await askChain(buildDeps(bareClient(fake)), 'LNK1104')
    expect(neither.kind).toBe('error')
    if (neither.kind === 'error') expect(neither.reason).toBe('client')

    const unresolved = await askChain(
      { db, outbound: createCloudAskOutbound(), resolveClient: () => ({ ok: false, reason: 'missing-key' }) },
      'LNK1104'
    )
    expect(unresolved.kind).toBe('error')
    if (unresolved.kind === 'error') {
      expect(unresolved.reason).toBe('client')
      expect(unresolved.message).toContain('missing-key')
    }
    expect(fake.askRequests).toHaveLength(0)
    expect(fake.askLoopRequests).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 9. 工具 schema 与执行器一致性                                        */
/* ------------------------------------------------------------------ */

describe('工具循环 · schema 与执行器一致性', () => {
  it('wire 层的三个工具名都能被执行器认；search_info 的参数与执行器解析的一一对应', async () => {
    seedOne(1, 'Firefox', at(0), 'LNK1104 的记录')
    const payload = buildChainAskLoopPayload({
      question: '随便问问',
      systemTime: SYSTEM_TIME,
      freshness: NO_FRESHNESS,
      turns: []
    }).payload

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"answer":"信息链里没找到","citations":[]}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    const client = createDeepSeekClient({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'test-key',
      sleep: async () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    await client.completeAskLoop?.(payload)

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      tools: Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>
      response_format?: unknown
    }
    // 带 tools 时不发 response_format（json_object 会禁掉 tool_calls）
    expect(body.response_format).toBeUndefined()
    expect(body.tools.map((tool) => tool.function.name)).toEqual([
      'search_info',
      'get_freshness',
      'read_segment',
      'ask_history'
    ])
    // search_info 的参数名必须与执行器解析的键完全一致（多一个 = 模型给了没人读，少一个 = 模型给不了）
    expect(Object.keys(body.tools[0].function.parameters.properties).sort()).toEqual([
      'app',
      'from',
      'keywords',
      'limit',
      'link',
      'order',
      'semantic',
      'tag',
      'to'
    ])

    // 每个 schema 里的工具名，执行器都要认（不许出现「未知工具」）
    const tool = executor()
    for (const entry of body.tools) {
      const name = entry.function.name
      const outcome = await tool.execute({
        name,
        arguments: name === 'search_info' ? { keywords: ['LNK1104'] } : {}
      })
      if (outcome.result.kind === 'error') {
        expect(outcome.result.message).not.toContain('未知工具')
      }
    }
  })

  it('收尾轮（allowTools:false）：不带 tools、改发 response_format，并在 system 里写明「收尾」', async () => {
    const payload = buildChainAskLoopPayload({
      question: '随便问问',
      systemTime: SYSTEM_TIME,
      freshness: NO_FRESHNESS,
      turns: []
    }).payload

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"answer":"信息链里没找到","citations":[]}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    const client = createDeepSeekClient({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'test-key',
      sleep: async () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    const result = await client.completeAskLoop?.(payload, { allowTools: false })

    // 收尾轮请求不带 tools：模型没有可调的工具，只能给最终 JSON
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      tools?: unknown
      response_format?: { type?: string }
      messages: Array<{ role: string; content: string }>
    }
    expect(body.tools).toBeUndefined()
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0].content).toContain('【收尾】')
    // 收尾轮答复照常解析成 JSON（与普通轮同形）
    expect(result?.json).toMatchObject({ answer: '信息链里没找到' })
  })
})

/* ------------------------------------------------------------------ */
/* search_info 的执行体注入（§5.11：主进程把它塞进 worker）            */
/* ------------------------------------------------------------------ */

describe('search_info · 检索执行体注入', () => {
  it('注入 searchBatch 时走它（不碰进程内同步查），参数口径与工具一致', async () => {
    seedOne(901, 'Firefox', at(60), '记忆球 性能优化')
    const calls: Array<{ texts: readonly string[]; limit?: number; includeOpen?: boolean }> = []
    const executor = createAskToolExecutor({
      db,
      now: () => NOW,
      captureRunning: () => false,
      searchBatch: async (query) => {
        calls.push({ texts: query.texts, limit: query.limit, includeOpen: query.includeOpen })
        // 故意返回一个空结果：能证明「结果来自注入的执行体」而不是进程内查出来的
        return {
          hitsPerText: query.texts.map(() => []),
          stats: { mode: 'keyword', vectors: 0, skippedVectors: 0, keywordRows: 0 }
        }
      }
    })
    const outcome = await executor.execute({
      name: 'search_info',
      arguments: { keywords: ['记忆球', '性能优化'], limit: 5 }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ texts: ['记忆球', '性能优化'], limit: 5, includeOpen: true })
    expect(outcome.result).toMatchObject({ kind: 'search_info', hits: [] })
    expect(outcome.segments).toEqual([])
  })

  it('不注入时仍走进程内同步查（老路径 / 单测不受影响）', async () => {
    const segmentId = seedOne(902, 'Firefox', at(60), '记忆球 性能优化')
    const executor = createAskToolExecutor({ db, now: () => NOW, captureRunning: () => false })
    const outcome = await executor.execute({
      name: 'search_info',
      arguments: { keywords: ['记忆球'], limit: 5 }
    })
    const view = outcome.result as unknown as { hits: Array<{ segmentId: number }> }
    expect(view.hits.map((hit) => hit.segmentId)).toEqual([segmentId])
  })
})
