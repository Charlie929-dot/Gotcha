/**
 * 问记忆循环里的小本本（自调用 v0.2 §7 / §12.2）
 *
 * 守的纪律：
 * 1. add / revise / remove 的参数都要钳住，缺参给出可照抄的写法；没接后端如实报「写不了」；
 * 2. 当前核心页每轮进 `<now>`（带编号与栏名），模型不用自己记得去查；
 * 3. 本子里命中脱敏规则的那条不出云（整条不列，不拆半句话）；
 * 4. 工具回执是真回执（写入成功 / 失败由存储层给），不假装。
 */

import { describe, expect, it, vi } from 'vitest'

import { runAskLoop } from '../../src/chain/agent/loop'
import { createAskOutbound, createLocalAskOutbound } from '../../src/chain/agent/payload'
import { createAskToolExecutor, type NotebookToolDeps } from '../../src/chain/agent/tools'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { openDatabase, type Db } from '../../src/db'
import { ensureChainSchema } from '../../src/chain/schema'

function freshDb(): Db {
  const db = openDatabase(':memory:')
  ensureChainSchema(db)
  return db
}

const NOW = new Date(2026, 10, 1, 12, 0, 0, 0).getTime()

function fakeNotebook(overrides: Partial<NotebookToolDeps> = {}): NotebookToolDeps {
  return {
    update: vi.fn(() => ({
      ok: true,
      message: '记下了 n1（关于你）。',
      entry: { id: 'n1', section: '关于你', text: '喜欢周深', at: '2026-11-01' },
      total: 1
    })),
    ...overrides
  }
}

function executor(notebook?: NotebookToolDeps) {
  const db = freshDb()
  const tool = createAskToolExecutor({
    db,
    now: () => NOW,
    captureRunning: () => false,
    ...(notebook ? { notebook } : {})
  })
  return { db, tool }
}

describe('update_notebook 参数', () => {
  it('add：把分区与内容原样交给存储层', async () => {
    const notebook = fakeNotebook()
    const { tool } = executor(notebook)
    const outcome = await tool.execute({
      name: 'update_notebook',
      arguments: { action: 'add', section: 'about_you', text: '喜欢周深' }
    })
    expect(outcome.result).toMatchObject({
      kind: 'update_notebook',
      ok: true,
      entry: { id: 'n1', section: '关于你', text: '喜欢周深' }
    })
    const call = (notebook.update as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    expect(call).toEqual({ action: 'add', section: 'about_you', text: '喜欢周深' })
  })

  it('revise / remove：按编号改 / 删，不再要求分区', async () => {
    const notebook = fakeNotebook()
    const { tool } = executor(notebook)
    await tool.execute({ name: 'update_notebook', arguments: { action: 'revise', id: 'n3', text: '改一下' } })
    await tool.execute({ name: 'update_notebook', arguments: { action: 'remove', id: 'n3' } })
    const calls = (notebook.update as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (item) => item[0]
    )
    expect(calls).toEqual([
      { action: 'revise', id: 'n3', text: '改一下' },
      { action: 'remove', id: 'n3' }
    ])
  })

  it('缺 action / 缺 text / 缺 id 或非法标题拒绝，不调存储层', async () => {
    const notebook = fakeNotebook()
    const { tool } = executor(notebook)
    for (const args of [
      {},
            { action: 'add', section: 'about_you' },
      { action: 'revise', text: '改一下' },
      { action: 'remove' },
      { action: 'add', section: '含\n换行', text: 'x' }
    ]) {
      const outcome = await tool.execute({ name: 'update_notebook', arguments: args })
      expect(outcome.result.kind).toBe('error')
    }
    expect(notebook.update).not.toHaveBeenCalled()
  })

  it('没接小本本：如实说写不了', async () => {
    const { tool } = executor()
    const outcome = await tool.execute({
      name: 'update_notebook',
      arguments: { action: 'add', section: 'about_you', text: '喜欢周深' }
    })
    expect(outcome.result.kind).toBe('error')
    expect(JSON.stringify(outcome.result)).toContain('写不了')
  })
})

describe('小本本主动翻阅', () => {
  it('每轮不会自动读取或注入正文，也不会虚构翻阅习惯', async () => {
    const read = vi.fn(() => [{ id: 'n1', section: '我的世界', text: '很私人的梦' }])
    const client = new FakeLlmClient([{ json: { answer: '嗯。', citations: [] } }])
    const db = freshDb()
    try {
      await runAskLoop({ db, client, outbound: createLocalAskOutbound(), now: () => NOW,
        captureRunning: () => false, tools: [], notebook: { read, update: fakeNotebook().update } }, '在吗')
      expect(read).not.toHaveBeenCalled()
      expect(JSON.stringify(client.askLoopRequests)).not.toContain('很私人的梦')
      expect(JSON.stringify(client.askLoopRequests)).not.toContain('过时了就改')
    } finally { db.close() }
  })

  it('read_notebook 返回自由栏目与完整正文，支持按栏目和正文检索', async () => {
    const db = freshDb()
    const longText = '长'.repeat(3000)
    const tool = createAskToolExecutor({ db, now: () => NOW, captureRunning: () => false,
      notebook: { ...fakeNotebook(), read: () => [
        { id: 'n1', section: '自己的故事', text: longText },
        { id: 'n2', section: '别的', text: '云' }
      ] } })
    try {
      expect((await tool.execute({ name: 'read_notebook', arguments: { section: '自己的故事', query: '长' } })).result)
        .toEqual({ kind: 'read_notebook', entries: [{ id: 'n1', section: '自己的故事', text: longText }] })
    } finally { db.close() }
  })

  it('翻阅结果里被策略挡住的条目不出云，其余完整保留', () => {
    const outbound = createAskOutbound({ redact: (text) => text.includes('hunter2')
      ? { text: '', redacted: true, blocked: true } : { text, redacted: false, blocked: false } })
    const { payload } = outbound.buildLoop({ question: '翻开', systemTime: '2026-11-04 12:00',
      freshness: { latestEvidenceTs: null, captureRunning: false }, turns: [{
        toolCall: { name: 'read_notebook', arguments: {} }, toolResult: { kind: 'read_notebook', entries: [
          { id: 'n1', section: '日常', text: 'hunter2' },
          { id: 'n2', section: '日常', text: '云'.repeat(3000) }
        ] }
      }] })
    expect(payload.turns[0]!.toolResult).toEqual({ kind: 'read_notebook', entries: [
      { id: 'n2', section: '日常', text: '云'.repeat(3000) }
    ] })
  })
})

describe('循环里的回执', () => {
  it('add 后工具结果回灌：回执与条目都在，模型知道记下了什么', async () => {
    const notebook = fakeNotebook()
    const client = new FakeLlmClient([
      {
        toolCalls: [
          { name: 'update_notebook', arguments: { action: 'add', section: 'about_you', text: '喜欢周深' } }
        ]
      },
      { json: { answer: '记下了。', citations: [] } }
    ])
    const result = await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: createLocalAskOutbound(),
        now: () => NOW,
        captureRunning: () => false,
        tools: ['update_notebook'],
        notebook: { read: () => [], update: notebook.update }
      },
      '记一下，我喜欢周深'
    )
    expect(result.kind).toBe('answer')
    const text = JSON.stringify(client.askLoopRequests.at(-1))
    expect(text).toContain('记下了 n1（关于你）')
    expect(text).toContain('喜欢周深')
    // 过程摘要给人看的一句（不是「失败：…」）
    if (result.kind === 'answer') {
      expect(result.trace?.steps[0]?.tools[0]?.summary).toContain('小本本 n1')
    }
  })

  it('存储层说没写成：回执 ok=false，模型不能改口成成功', async () => {
    const notebook = fakeNotebook({
      update: vi.fn(() => ({
        ok: false,
        message: '「关于你」满了（n1、n2）。先 revise 合并，或 remove 放下不重要的，再记新的。',
        entry: null,
        total: 2
      }))
    })
    const { tool } = executor(notebook)
    const outcome = await tool.execute({
      name: 'update_notebook',
      arguments: { action: 'add', section: 'about_you', text: '再来一条' }
    })
    expect(outcome.result).toMatchObject({ kind: 'update_notebook', ok: false, entry: null })
    expect(JSON.stringify(outcome.result)).toContain('满了')
  })
})
