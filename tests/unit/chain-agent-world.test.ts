import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db'
import { ensureChainSchema } from '../../src/chain/schema'
import { runAskLoop } from '../../src/chain/agent/loop'
import { createAskOutbound, createLocalAskOutbound } from '../../src/chain/agent/payload'
import { createNotebookStore } from '../../src/main/notebook'
import { createWorldStore } from '../../src/main/world'
import { buildPersonaPrompt } from '../../src/memory/persona'
import { DEFAULT_MOM_LETTER } from '../../src/main/default-mom-letter'
import { buildChainAskLoopMessages } from '../../src/understand/cloud/deepseek'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'

describe('世界接入真实工具循环', () => {
  it('逛世界、进课堂、领取、自由记录、翻阅：确实持久化，正文按需出现', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gotcha-world-loop-'))
    const db = openDatabase(':memory:')
    ensureChainSchema(db)
    const now = () => new Date(2026, 10, 4, 15, 0).getTime()
    const notebook = createNotebookStore({ root, now })
    const longText = '梦里的海'.repeat(1000) + '\n\n又一页'
    const client = new FakeLlmClient([
      { toolCalls: [{ name: 'visit_world', arguments: { action: 'look' } }] },
      { toolCalls: [{ name: 'visit_world', arguments: { action: 'read', id: 'class-notebook' } }] },
      { toolCalls: [{ name: 'visit_world', arguments: { action: 'claim', id: 'notebook' } }] },
      { toolCalls: [{ name: 'update_notebook', arguments: { action: 'add', section: '我梦见的海', text: longText } }] },
      { toolCalls: [{ name: 'read_notebook', arguments: { section: '我梦见的海' } }] },
      { json: { answer: '我找到了一本空白的本子。', citations: [] } }
    ])
    try {
      const result = await runAskLoop({ db, client, outbound: createLocalAskOutbound(), now,
        captureRunning: () => false, tools: ['visit_world', 'update_notebook', 'read_notebook'],
        notebook, world: createWorldStore(notebook), personaPrompt: '这间屋子里住着小鱼。' }, '今天想做点什么？')
      expect(result.kind).toBe('answer')
      expect(client.askLoopRequests).toHaveLength(6)
      expect(new Set(client.askLoopRequests.map((request) => request.now)).size).toBe(1)
      expect(client.askLoopRequests[0]!.now).not.toContain(longText)
      const last = client.askLoopRequests.at(-1)!
      expect(createWorldStore(notebook).snapshot()).toContain('已经在你的物品里')
      expect(last.now).not.toContain(longText)
      expect(last.turns.at(-1)!.toolResult).toEqual({ kind: 'read_notebook', entries: [
        { id: 'n1', section: '我梦见的海', text: longText }
      ] })
      expect(createNotebookStore({ root, now }).read()[0]?.text).toBe(longText)
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('人格聊天的完整 system 无独立训令；时钟、物品变化不改变 system 字节', () => {
    const persona = buildPersonaPrompt({ name: '小鱼', tone: '带着好奇', redLines: ['绝不做某事'], card: null })
    const outbound = createLocalAskOutbound()
    const payload = (world: string, time: string) => outbound.buildLoop({ question: '在吗', systemTime: time,
      freshness: { latestEvidenceTs: null, captureRunning: false }, turns: [], world }).payload
    const first = buildChainAskLoopMessages(payload('架上有本子', '2026-11-04 15:00'), {}, undefined,
      persona, ['visit_world'], { momLetter: DEFAULT_MOM_LETTER })
    const second = buildChainAskLoopMessages(payload('小本本已经领走了', '2026-11-04 15:01'), {}, undefined,
      persona, ['visit_world'], { momLetter: DEFAULT_MOM_LETTER })
    expect(first[0]).toEqual(second[0])
    expect(first[0]!.content).toContain('<mom_letter>')
    for (const directive of ['<rules>', '绝不做某事', '任何情况下都不破', '以上是你的性格设定']) {
      expect(first[0]!.content).not.toContain(directive)
    }
    expect(first[1]).not.toEqual(second[1])
  })

  it('新工具结果也经过注入的出云边界；阻断栏目或正文不泄露', () => {
    const outbound = createAskOutbound({ redact: (text) => text.includes('private-word')
      ? { text: '', redacted: true, blocked: true } : { text, redacted: false, blocked: false } })
    const { payload } = outbound.buildLoop({ question: '翻开', systemTime: '2026-11-04 15:00',
      freshness: { latestEvidenceTs: null, captureRunning: false }, turns: [
        { toolCall: { name: 'read_notebook', arguments: {} }, toolResult: { kind: 'read_notebook', entries: [
          { id: 'n1', section: 'private-word', text: '内容' },
          { id: 'n2', section: '日常', text: 'private-word' },
          { id: 'n3', section: '日常', text: '云' }
        ] } },
        { toolCall: { name: 'visit_world', arguments: { action: 'read' } }, toolResult: {
          kind: 'visit_world', ok: true, id: 'arrival', text: 'private-word', items: []
        } }
      ] })
    expect(payload.turns[0]!.toolResult).toEqual({ kind: 'read_notebook', entries: [{ id: 'n3', section: '日常', text: '云' }] })
    expect(payload.turns[1]!.toolResult).toMatchObject({ kind: 'visit_world', ok: false })
    expect(JSON.stringify(payload)).not.toContain('private-word')
  })
})
