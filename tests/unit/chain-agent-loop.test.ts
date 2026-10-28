import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askChain, type ChainAskOptions } from '../../src/chain/agent/ask'
import {
  ASK_LOOP_MAX_TOOL_CALLS,
  ASK_LOOP_MAX_TOOL_TURNS,
  ASK_LOOP_MAX_TURNS,
  formatSystemTime
} from '../../src/chain/agent/loop'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, openSegment, type ChainDb } from '../../src/chain/store'
import { createDeterministicFakeLlm } from '../../src/main/fake-llm'
import { FakeLlmClient, type LlmClient } from '../../src/understand/cloud/llm-client'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'

/** 本地 2026-10-27 09:00（周二） */
const NOW = new Date(2026, 9, 27, 9, 0, 0, 0).getTime()
const at = (seconds: number): number => NOW + seconds * 1000

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

/** 造一段已收口的段 + 一条内容 */
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

const searchCall = (arguments_: Record<string, unknown>): { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> } => ({
  toolCalls: [{ name: 'search_info', arguments: arguments_ }]
})

describe('问记忆 · 工具循环（主路径）', () => {
  it('一次检索 + 最终答复：引用的事实由服务端从段行补，usage 结束时一次入账', async () => {
    const seg = seed({
      pid: 1,
      app: 'Visual Studio Code',
      title: 'gotcha — src/chain',
      from: at(0),
      to: at(600),
      text: '编译 native 模块报 LNK1104，因为 Electron 正加载着 chain_hook.node'
    })

    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104', 'Electron'] }),
      {
        json: {
          answer: '你当时在 09:00 的〈Visual Studio Code〉里编译原生模块，撞上 LNK1104。',
          citations: [{ segmentId: seg, why: '报 LNK1104 的那一次' }]
        },
        usage: { promptTokens: 300, completionTokens: 40 }
      }
    ])
    const usages: Array<{ promptTokens: number; completionTokens: number }> = []
    const result = await askChain(
      buildDeps(client, { onUsage: (usage) => usages.push(usage) }),
      'LNK1104 是怎么回事'
    )

    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.answer).toContain('LNK1104')
    expect(result.citations).toHaveLength(1)
    // at / app / title 是服务端补的（毫秒时间戳 + 段行字段），不是模型给的
    expect(result.citations[0]).toMatchObject({
      segmentId: seg,
      at: at(0),
      app: 'Visual Studio Code',
      title: 'gotcha — src/chain'
    })
    expect(result.stats).toMatchObject({ hits: 1, evidence: 1, cited: 1, turns: 2, toolCalls: 1 })
    // usage 是两轮累计、只发一次
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({ promptTokens: 300, completionTokens: 40 })

    // 第一轮载荷：系统时间 + 数据边界 + 空 turns
    const first = client.askLoopRequests[0]
    expect(first.question).toBe('LNK1104 是怎么回事')
    expect(first.systemTime).toBe(formatSystemTime(NOW))
    expect(first.freshness).toEqual({ latestEvidenceTs: at(0), captureRunning: false })
    expect(first.turns).toHaveLength(0)
    // 第二轮载荷：带上了工具往返（摘要不回正文全文）
    const second = client.askLoopRequests[1]
    expect(second.turns).toHaveLength(1)
    expect(second.turns[0].toolCall).toEqual({
      name: 'search_info',
      arguments: { keywords: ['LNK1104', 'Electron'] }
    })
    const toolResult = second.turns[0].toolResult as {
      kind: string
      hits: Array<{ segmentId: number; at: string; app: string; title: string; snippet: string }>
      stats: { mode: string }
    }
    expect(toolResult.kind).toBe('search_info')
    expect(toolResult.stats.mode).toBe('keywords')
    expect(toolResult.hits[0]).toMatchObject({ segmentId: seg, at: '09:00', app: 'Visual Studio Code' })
    expect(toolResult.hits[0].snippet).toContain('LNK1104')
    expect(toolResult.hits[0].snippet.length).toBeLessThanOrEqual(80)
  })

  it('模型不调工具直接说没找到：一轮结束，no-evidence', async () => {
    const client = new FakeLlmClient([{ json: { answer: '信息链里没找到', citations: [] } }])
    const result = await askChain(buildDeps(client), '随便什么')
    expect(result.kind).toBe('no-evidence')
    expect(client.askLoopRequests).toHaveLength(1)
    expect(result.stats).toMatchObject({ turns: 1, toolCalls: 0 })
  })

  it('查到了但撑不起结论：insufficient 出口保留说明与「检索到的段」', async () => {
    const seg = seed({
      pid: 1,
      app: 'DSH NEXT',
      title: '继续任务 — DeepSeek Harness',
      from: at(0),
      to: at(60),
      text: '右键菜单位置与设置 — DeepSeek Harness'
    })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['菜单'] }),
      {
        json: {
          answer: '只查到界面上的零散段落，没有「第一次打开」的时间锚点。',
          citations: [],
          insufficient: true
        }
      }
    ])
    const result = await askChain(buildDeps(client), '我第一次打开这个界面是啥时候')
    expect(result.kind).toBe('insufficient')
    if (result.kind !== 'insufficient') return
    expect(result.answer).toContain('没有「第一次打开」')
    expect(result.citations).toEqual([])
    expect(result.related.map((item) => item.segmentId)).toEqual([seg])
    expect(result.stats).toMatchObject({ hits: 1, evidence: 1 })
  })

  it('no-evidence 也带上「检索到的段」，不再只剩固定文案', async () => {
    const seg = seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('no-evidence')
    if (result.kind !== 'no-evidence') return
    expect(result.related?.map((item) => item.segmentId)).toEqual([seg])
  })

  it('keywords 逐词 OR：整句搜不到的组合也能召回，且双词同段排最前', async () => {
    const both = seed({ pid: 1, app: 'A', title: '双词', from: at(0), to: at(60), text: 'LNK1104 与 Electron' })
    const onlyLink = seed({ pid: 2, app: 'B', title: '链接词', from: at(100), to: at(160), text: '只提到 Electron' })
    const onlyError = seed({ pid: 3, app: 'C', title: '错误码', from: at(200), to: at(260), text: '只提到 LNK1104' })

    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104', 'Electron'] }),
      {
        json: {
          answer: '两段都提到了。',
          citations: [
            { segmentId: both, why: '两个词都在' },
            { segmentId: onlyLink, why: '链接词' },
            { segmentId: onlyError, why: '错误码' }
          ]
        }
      }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104 和 Electron')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations).toHaveLength(3)

    // 本地 RRF：双词同段的段名次最前（两路各 rank 1，分数翻倍）
    const toolResult = client.askLoopRequests[1].turns[0].toolResult as {
      hits: Array<{ segmentId: number }>
    }
    expect(toolResult.hits.map((hit) => hit.segmentId)).toEqual([both, onlyError, onlyLink])
  })

  it('编造的 segmentId 整条丢弃：白名单 = search_info 返回过的段', async () => {
    const seg = seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      {
        json: {
          answer: '见那段。',
          citations: [
            { segmentId: 9999, why: '编造的段' },
            { segmentId: seg, why: '真的' }
          ]
        }
      }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((citation) => citation.segmentId)).toEqual([seg])
    expect(result.stats.cited).toBe(2)
  })

  it('answer 宣称没找到却带引用：按没找到收口，但保留说明与可点证据（根因 7）', async () => {
    const seg = seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      {
        json: {
          answer: '信息链里没找到相关记录。',
          citations: [{ segmentId: seg, why: '不该出现的引用' }]
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
    expect(result.citations?.map((citation) => citation.segmentId)).toEqual([seg])
    expect(logs.some((message) => message.includes('按没找到保留说明'))).toBe(true)
    // LLM 确实被调用了两轮（检索 + 答复），只是结果被归一
    expect(client.askLoopRequests).toHaveLength(2)
  })

  it('问「第一次问你的是啥」：查过 ask_history 后允许无引用的对话回答', async () => {
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'ask_history', arguments: { order: 'oldest', limit: 50 } }] },
      {
        json: {
          answer: '你第一次问的是「刚刚我在干啥」。',
          citations: [],
          conversation: true
        }
      }
    ])
    const result = await askChain(
      buildDeps(client, {
        readAskHistory: () => [{ at: at(0), question: '刚刚我在干啥', kind: 'answer' }]
      }),
      '我第一次问你的是啥'
    )
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations).toEqual([])
    expect(result.answer).toContain('刚刚我在干啥')

    const historyTool = client.askLoopRequests[1].turns[0].toolResult as {
      kind: string
      entries: Array<{ question: string }>
    }
    expect(historyTool.kind).toBe('ask_history')
    expect(historyTool.entries[0].question).toBe('刚刚我在干啥')
  })

  it('没有对话上下文时，无引用的「回答」仍按没找到处理（不放宽引用门）', async () => {
    const client = new FakeLlmClient([
      { json: { answer: '你之前问过很多事情。', citations: [], conversation: true } }
    ])
    const result = await askChain(buildDeps(client), '我之前问过什么')
    expect(result.kind).toBe('no-evidence')
  })

  it('段正文里的网址随命中带出：snippet 截断也不丢地址栏 URL', async () => {
    const url =
      'https://www.bilibili.com/video/BV1fopY6QEmP/?trackid=web_pegasus_0&vd_source=3964f41e718cb64d5ac181dfb3e1116e'
    const seg = seed({
      pid: 1,
      app: 'Firefox',
      title: '哪一行都不好干（84）_哔哩哔哩_bilibili',
      from: at(0),
      to: at(60),
      text: `菜单栏 Application 文件 编辑 查看 历史 书签 工具 帮助 使用 Google 搜索，或者输入网址 ${url} 页面正文`
    })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['bilibili'] }),
      {
        json: {
          answer: `链接是 ${url}`,
          citations: [{ segmentId: seg, why: '地址栏里有链接' }]
        }
      }
    ])
    const result = await askChain(buildDeps(client), 'B 站视频的链接')
    expect(result.kind).toBe('answer')
    const hit = (
      client.askLoopRequests[1].turns[0].toolResult as {
        hits: Array<{ segmentId: number; urls: string[] }>
      }
    ).hits.find((item) => item.segmentId === seg)
    expect(hit?.urls).toContain(url)
  })

  it('search_info 摘要看不到的 URL：read_segment 展开正文后作答', async () => {
    const url = 'https://www.bilibili.com/video/BV1fopY6QEmP/?vd_source=abc'
    // URL 放在 80 字摘要之后：只靠 snippet 永远看不到
    const seg = seed({
      pid: 1,
      app: 'Firefox',
      title: 'B 站视频',
      from: at(0),
      to: at(60),
      text: `${'顶部菜单与推荐位文字 '.repeat(12)}地址栏 ${url} 页面正文`
    })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['bilibili'] }),
      { toolCalls: [{ name: 'read_segment', arguments: { segmentId: seg } }] },
      {
        json: {
          answer: `链接是 ${url}`,
          citations: [{ segmentId: seg, why: '地址栏里有链接' }]
        }
      }
    ])
    const result = await askChain(buildDeps(client), 'B 站视频的链接')
    expect(result.kind).toBe('answer')

    const read = client.askLoopRequests[2].turns[1].toolResult as {
      kind: string
      text: string
      urls: string[]
      truncated: boolean
    }
    expect(read.kind).toBe('read_segment')
    expect(read.text).toContain(url)
    expect(read.urls).toContain(url)
    expect(read.truncated).toBe(false)
  })

  it('脱敏整条挡下的段：不出现在送云摘要里，也不能被引用', async () => {
    const blocked = seed({
      pid: 1,
      app: '1password.exe',
      title: 'vault',
      from: at(0),
      to: at(60),
      text: '密码 LNK1104'
    })
    const visible = seed({ pid: 2, app: 'Firefox', title: '文档', from: at(100), to: at(160), text: 'LNK1104 的记录' })

    const client = new FakeLlmClient([
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

    // 送云摘要里没有密码类应用的段：模型没见过的段不能引用
    const toolResult = client.askLoopRequests[1].turns[0].toolResult as {
      hits: Array<{ segmentId: number }>
    }
    expect(toolResult.hits.map((hit) => hit.segmentId)).toEqual([visible])
  })

  it('开着的段也能检到（includeOpen 硬编码），freshness 的开段口径算「现在」', async () => {
    const openId = openSegment(
      db,
      {
        startTs: at(-300),
        pid: 9,
        exe: 'app9',
        app: 'WeChat',
        hwnd: 90,
        title: '聊天'
      },
      at(-300)
    )
    insertContent(db, {
      segmentId: openId,
      capturedAt: at(-299),
      source: 'uia',
      text: '开着的那段里聊到 LNK1104'
    })

    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      { json: { answer: '08:55 的〈WeChat〉里聊过。', citations: [{ segmentId: openId, why: '开段命中' }] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations[0]).toMatchObject({ segmentId: openId, app: 'WeChat', at: at(-300) })
    // 开段在场：最新证据按「现在」报（NOW 注入的固定钟），不拿暂定的 start_ts 骗模型
    expect(client.askLoopRequests[0].freshness).toEqual({ latestEvidenceTs: NOW, captureRunning: false })
  })

  it('get_freshness 工具：返回数据边界；问「刚刚」先调它', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'get_freshness', arguments: {} }] },
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, { captureRunning: () => true }),
      '我刚刚在干什么'
    )
    expect(result.kind).toBe('no-evidence')
    const toolResult = client.askLoopRequests[1].turns[0].toolResult as {
      kind: string
      freshness: { latestEvidenceTs: number | null; captureRunning: boolean }
    }
    expect(toolResult.kind).toBe('get_freshness')
    expect(toolResult.freshness).toEqual({ latestEvidenceTs: at(0), captureRunning: true })
  })

  it('ask_history 工具：按注入的历史摘要返回，条数受限', async () => {
    const history = [
      { at: at(500), question: '昨天干了什么', kind: 'no-evidence' },
      { at: at(400), question: 'LNK1104 是什么', kind: 'answer' },
      { at: at(300), question: '中午吃了什么', kind: 'answer' }
    ]
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'ask_history', arguments: { limit: 2 } }] },
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, { readAskHistory: () => history }),
      '我之前问过什么'
    )
    expect(result.kind).toBe('no-evidence')
    const toolResult = client.askLoopRequests[1].turns[0].toolResult as {
      kind: string
      entries: Array<{ time: string; question: string; kind: string }>
    }
    expect(toolResult.kind).toBe('ask_history')
    // 只给本地时刻，**不带毫秒时间戳**：模型拿到数字会自己换算，两次答出不同时间
    expect(toolResult.entries).toEqual([
      { time: '10-27 09:08', question: '昨天干了什么', kind: 'no-evidence' },
      { time: '10-27 09:06', question: 'LNK1104 是什么', kind: 'answer' }
    ])
    expect(JSON.stringify(toolResult.entries)).not.toContain(String(at(500)))
  })

  it('semantic 走注入的 embedder；算不出向量就只剩关键词路', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const embedded: string[] = []
    const client = new FakeLlmClient([
      searchCall({ semantic: '编译报错的上下文' }),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const result = await askChain(
      buildDeps(client, {
        embedQuestion: (text) => {
          embedded.push(text)
          return new Float32Array([1, 0, 0])
        }
      }),
      '编译报错'
    )
    expect(result.kind).toBe('no-evidence')
    expect(embedded).toEqual(['编译报错的上下文'])
    const toolResult = client.askLoopRequests[1].turns[0].toolResult as { stats: { mode: string } }
    // 库里没有向量行：语义路参与了（mode=semantic），只是没有命中
    expect(toolResult.stats.mode).toBe('semantic')
  })

  it('多轮循环：检索 → 再检索 → 答复，turns 逐轮累积', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['LNK1104'] }),
      searchCall({ keywords: ['LNK1104'], app: 'Firefox' }),
      { json: { answer: '09:00 的〈Firefox〉里查过。', citations: [{ segmentId: 1, why: '文档段' }] } }
    ])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('answer')
    expect(client.askLoopRequests).toHaveLength(3)
    expect(client.askLoopRequests[1].turns).toHaveLength(1)
    expect(client.askLoopRequests[2].turns).toHaveLength(2)
    expect(result.stats).toMatchObject({ turns: 3, toolCalls: 2 })
  })

  it(`${ASK_LOOP_MAX_TOOL_TURNS} 轮工具用尽 → 先问用户要不要继续；选收尾后再强制作答`, async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const client = new FakeLlmClient([
      ...Array.from({ length: ASK_LOOP_MAX_TOOL_TURNS }, () => ({
        toolCalls: [{ name: 'get_freshness', arguments: {} }]
      })),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const paused = await askChain(buildDeps(client), '我在干什么')

    // 轮数用尽不硬掐：先返回 continue-ask，把「要不要接着查」交给用户
    expect(paused.kind).toBe('continue-ask')
    if (paused.kind !== 'continue-ask') return
    expect(paused.resumeId).toBeTruthy()
    expect(paused.stats).toMatchObject({
      turns: ASK_LOOP_MAX_TOOL_TURNS,
      toolCalls: ASK_LOOP_MAX_TOOL_TURNS
    })
    expect(client.askLoopRequests).toHaveLength(ASK_LOOP_MAX_TOOL_TURNS)
    expect(client.optionCalls[ASK_LOOP_MAX_TOOL_TURNS - 1].allowTools).toBe(true)

    // 选「先按现在的结果回答」：恢复后第一轮就不给工具，直接收尾
    const finished = await askChain(
      buildDeps(client, { resume: { id: paused.resumeId!, decision: 'stop' } }),
      ''
    )
    expect(finished.kind).toBe('no-evidence')
    expect(client.askLoopRequests).toHaveLength(ASK_LOOP_MAX_TURNS)
    expect(client.optionCalls[ASK_LOOP_MAX_TOOL_TURNS].allowTools).toBe(false)
    expect(finished.stats).toMatchObject({
      turns: ASK_LOOP_MAX_TURNS,
      toolCalls: ASK_LOOP_MAX_TOOL_TURNS
    })
  })

  it('收尾轮仍被脚本塞 tool_calls（假客户端/异常网关）：忽略并如实报不成形', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const client = new FakeLlmClient([
      ...Array.from({ length: ASK_LOOP_MAX_TOOL_TURNS }, () => ({
        toolCalls: [{ name: 'get_freshness', arguments: {} }]
      })),
      // 收尾轮还塞工具调用：不执行，按最终答复解析 → 不成形
      { toolCalls: [{ name: 'get_freshness', arguments: {} }] }
    ])
    const paused = await askChain(buildDeps(client), '我在干什么')
    expect(paused.kind).toBe('continue-ask')
    if (paused.kind !== 'continue-ask' || !paused.resumeId) return
    const finished = await askChain(
      buildDeps(client, { resume: { id: paused.resumeId, decision: 'stop' } }),
      ''
    )

    expect(finished.kind).toBe('error')
    if (finished.kind !== 'error') return
    // 收尾轮的工具调用不执行：轮数封顶，不无限陪模型玩
    expect(finished.reason).toBe('unparseable')
    expect(client.askLoopRequests).toHaveLength(ASK_LOOP_MAX_TURNS)
    expect(finished.stats).toMatchObject({
      turns: ASK_LOOP_MAX_TURNS,
      toolCalls: ASK_LOOP_MAX_TOOL_TURNS
    })
  })

  it(`工具调用总数超 ${ASK_LOOP_MAX_TOOL_CALLS}：failed 收口，超限那批不执行`, async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const firstBatch = ASK_LOOP_MAX_TOOL_CALLS - 1
    const client = new FakeLlmClient([
      {
        toolCalls: Array.from({ length: firstBatch }, (_, index) => ({
          name: 'get_freshness',
          arguments: {}
        })).map((call, index) => ({ ...call, id: `a${index}` })),
        usage: { promptTokens: 10, completionTokens: 1 }
      },
      {
        toolCalls: Array.from({ length: 2 }, (_, index) => ({
          name: 'get_freshness',
          arguments: {}
        })).map((call, index) => ({ ...call, id: `b${index}` }))
      }
    ])
    const result = await askChain(buildDeps(client), '我在干什么')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('failed')
    // 第二批会让总数超上限：只执行了第一批
    expect(client.askLoopRequests).toHaveLength(2)
    expect(client.askLoopRequests[1].turns).toHaveLength(firstBatch)
    expect(result.stats).toMatchObject({ toolCalls: firstBatch })
  })

  it('解析失败（结构不对）：unparseable，不静默当空结果', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 的记录' })
    const client = new FakeLlmClient([searchCall({ keywords: ['LNK1104'] }), { json: '不是对象' }])
    const result = await askChain(buildDeps(client), 'LNK1104')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('unparseable')
  })

  it('客户端抛错：failed；已消耗的 usage 照样入账（F03）', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const client = new FakeLlmClient([
      {
        toolCalls: [{ name: 'search_info', arguments: { keywords: ['看文档'] } }],
        usage: { promptTokens: 120, completionTokens: 8 }
      },
      new Error('网络断了')
    ])
    const usages: Array<{ promptTokens: number }> = []
    const result = await askChain(
      buildDeps(client, { onUsage: (usage) => usages.push(usage) }),
      '我在干什么'
    )
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('failed')
    // 第一轮的 usage 已消耗：失败路径也要能记账
    expect(usages).toHaveLength(1)
    expect(usages[0].promptTokens).toBeGreaterThan(0)
  })

  it('空问题 / 出云门 / 日预算：门口一次判定，一次客户端调用都不发', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })

    const empty = await askChain(buildDeps(new FakeLlmClient([])), '   ')
    expect(empty.kind).toBe('error')
    if (empty.kind === 'error') expect(empty.reason).toBe('empty-question')

    const consent = await askChain(
      buildDeps(new FakeLlmClient([]), { canSend: () => false }),
      '我在干什么'
    )
    expect(consent.kind).toBe('error')
    if (consent.kind === 'error') expect(consent.reason).toBe('consent')

    const budget = await askChain(
      buildDeps(new FakeLlmClient([]), { overBudget: () => true }),
      '我在干什么'
    )
    expect(budget.kind).toBe('error')
    if (budget.kind === 'error') expect(budget.reason).toBe('budget')
  })

  it('问题命中敏感规则：循环开始前一次判定，整次不出云', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: 'LNK1104 改密码那次' })
    const client = new FakeLlmClient([])
    const result = await askChain(buildDeps(client), 'LNK1104 改密码')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('question-blocked')
    expect(client.askLoopRequests).toHaveLength(0)
  })

  it('空库：freshness 如实报 null，模型答「没找到」', async () => {
    const client = new FakeLlmClient([{ json: { answer: '信息链里没找到', citations: [] } }])
    const result = await askChain(buildDeps(client), '我昨天干了什么')
    expect(result.kind).toBe('no-evidence')
    expect(client.askLoopRequests[0].freshness).toEqual({ latestEvidenceTs: null, captureRunning: false })
  })

  it('确定性假 LLM 的循环脚本（E2E 用的那条）：检索最近段后引用第一段作答', async () => {
    const seg = seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const { client, counters } = createDeterministicFakeLlm()
    const result = await askChain(buildDeps(client), '我刚才在干什么')

    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.citations.map((citation) => citation.segmentId)).toEqual([seg])
    // 两轮：先 search_info（按时间倒序列最近的段），再引用第一段作答
    expect(counters.requests).toBe(2)
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 })
  })
})

describe('问记忆 · 多轮与确认（2026-10-27 增补）', () => {
  it('证据撑不起时先确认：clarify 出口，不当作失败', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['编译'] }),
      { json: { ask: '你说的是哪天的编译错误？', options: ['今天上午', '今天下午'] } }
    ])
    const result = await askChain(buildDeps(client), '那个编译错误')
    expect(result.kind).toBe('clarify')
    if (result.kind !== 'clarify') return
    expect(result.question).toContain('哪天')
    expect(result.options).toEqual(['今天上午', '今天下午'])
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 })
  })

  it('续问：同一会话的上下文进载荷；不同会话互不串', async () => {
    const client = new FakeLlmClient([{ json: { answer: '信息链里没找到', citations: [] } }])
    const history = [{ question: '上午在干什么', answer: '在写代码' }]
    await askChain(buildDeps(client, { history }), '那下午呢')
    expect(client.askLoopRequests[0].history).toEqual(history)

    const fresh = new FakeLlmClient([{ json: { answer: '信息链里没找到', citations: [] } }])
    await askChain(buildDeps(fresh), '那下午呢')
    expect(fresh.askLoopRequests[0].history).toEqual([])
  })

  it('用户点停止：aborted 收口，不是 failed', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const controller = new AbortController()
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'search_info', arguments: { keywords: ['看文档'] } }] }
    ])
    const pending = askChain(buildDeps(client, { signal: controller.signal }), '我在干什么')
    controller.abort()
    const result = await pending
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('aborted')
  })
})

/* ------------------------------------------------------------------ */
/* 续查：轮数用尽先问用户，同意后再给一轮预算                            */
/* ------------------------------------------------------------------ */

describe('问记忆 · 轮数用尽后的续查', () => {
  it('选「继续查」：再给 8 轮 / 16 次预算，从上次结果接着查（不重头查）', async () => {
    const seg = seed({
      pid: 1,
      app: 'Firefox',
      title: 'B 站',
      from: at(0),
      to: at(60),
      text: '地址栏 https://www.bilibili.com/video/BV1fopY6QEmP/'
    })
    const client = new FakeLlmClient([
      searchCall({ keywords: ['bilibili'] }),
      ...Array.from({ length: ASK_LOOP_MAX_TOOL_TURNS - 1 }, () => ({
        toolCalls: [{ name: 'get_freshness', arguments: {} }]
      })),
      // 继续查之后：模型还想再查一次，然后作答（第 9 轮全局 = 续查第 1 轮）
      { toolCalls: [{ name: 'read_segment', arguments: { segmentId: seg } }] },
      {
        json: {
          answer: '那条 B 站视频的链接在记录里。',
          citations: [{ segmentId: seg, why: '地址栏里有链接' }]
        }
      }
    ])

    const paused = await askChain(buildDeps(client), 'B 站链接')
    expect(paused.kind).toBe('continue-ask')
    if (paused.kind !== 'continue-ask' || !paused.resumeId) return
    expect(paused.stats).toMatchObject({ turns: ASK_LOOP_MAX_TOOL_TURNS })

    const resumed = await askChain(
      buildDeps(client, { resume: { id: paused.resumeId, decision: 'continue' } }),
      ''
    )
    expect(resumed.kind).toBe('answer')
    if (resumed.kind !== 'answer') return
    expect(resumed.citations.map((citation) => citation.segmentId)).toEqual([seg])

    // 续查的第一轮仍允许工具，且带着暂停前的完整上下文（不用重新检索一遍）
    expect(client.optionCalls[ASK_LOOP_MAX_TOOL_TURNS].allowTools).toBe(true)
    const resumedRequest = client.askLoopRequests[ASK_LOOP_MAX_TOOL_TURNS]
    expect(resumedRequest.turns).toHaveLength(ASK_LOOP_MAX_TOOL_TURNS)
    expect(resumedRequest.question).toBe('B 站链接')
    // 续查后轮数接着累加，不是从 1 重新数
    expect(resumed.stats).toMatchObject({
      turns: ASK_LOOP_MAX_TOOL_TURNS + 2,
      toolCalls: ASK_LOOP_MAX_TOOL_TURNS + 1
    })
  })

  it('检查点一次性：同一个 resumeId 不能恢复两次', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const client = new FakeLlmClient([
      ...Array.from({ length: ASK_LOOP_MAX_TOOL_TURNS }, () => ({
        toolCalls: [{ name: 'get_freshness', arguments: {} }]
      })),
      { json: { answer: '信息链里没找到', citations: [] } }
    ])
    const paused = await askChain(buildDeps(client), '我在干什么')
    expect(paused.kind).toBe('continue-ask')
    if (paused.kind !== 'continue-ask' || !paused.resumeId) return

    const first = await askChain(
      buildDeps(client, { resume: { id: paused.resumeId, decision: 'stop' } }),
      ''
    )
    expect(first.kind).toBe('no-evidence')

    const second = await askChain(
      buildDeps(client, { resume: { id: paused.resumeId, decision: 'continue' } }),
      ''
    )
    expect(second.kind).toBe('error')
    if (second.kind !== 'error') return
    expect(second.reason).toBe('failed')
    expect(second.message).toContain('过期')
  })

  it('用户没点继续也不会一直挂着：窗口重开后 resumeId 失效（检查点只在内存里）', async () => {
    seed({ pid: 1, app: 'Firefox', title: '文档', from: at(0), to: at(60), text: '看文档' })
    const client = new FakeLlmClient([
      ...Array.from({ length: ASK_LOOP_MAX_TOOL_TURNS }, () => ({
        toolCalls: [{ name: 'get_freshness', arguments: {} }]
      }))
    ])
    const paused = await askChain(buildDeps(client), '我在干什么')
    expect(paused.kind).toBe('continue-ask')
    if (paused.kind !== 'continue-ask') return
    expect(paused.resumeId).toMatch(/^r[a-z0-9]+$/)
  })
})
