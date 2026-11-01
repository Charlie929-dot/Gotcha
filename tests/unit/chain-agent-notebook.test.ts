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

  it('缺 action / 缺 section / 缺 text / 缺 id 都拒，不调存储层', async () => {
    const notebook = fakeNotebook()
    const { tool } = executor(notebook)
    for (const args of [
      {},
      { action: 'add', text: '喜欢周深' },
      { action: 'add', section: 'about_you' },
      { action: 'revise', text: '改一下' },
      { action: 'remove' },
      { action: 'add', section: '不存在的栏', text: 'x' }
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

describe('小本本进 <now>', () => {
  it('每轮带编号与栏名；模型据此改 / 删', async () => {
    const client = new FakeLlmClient([{ json: { answer: '嗯，我记得。', citations: [] } }])
    await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: createLocalAskOutbound(),
        now: () => NOW,
        captureRunning: () => false,
        tools: [],
        notebook: {
          read: () => [
            { id: 'n1', section: '关于你', text: '喜欢周深' },
            { id: 'n2', section: '我们之间', text: '约好睡前说一声' }
          ],
          update: fakeNotebook().update
        }
      },
      '在吗'
    )
    const text = JSON.stringify(client.askLoopRequests.at(-1))
    expect(text).toContain('小本本')
    expect(text).toContain('n1（关于你）喜欢周深')
    expect(text).toContain('n2（我们之间）约好睡前说一声')
    expect(text).toContain('过时了就改')
  })

  it('本子里命中脱敏规则的那条不列出来（其余照常）', async () => {
    const blocking = createAskOutbound({
      redact: (text: string) =>
        text.includes('hunter2')
          ? { text: '', redacted: true, blocked: true }
          : { text, redacted: false, blocked: false }
    })
    const client = new FakeLlmClient([{ json: { answer: '嗯。', citations: [] } }])
    await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: blocking,
        now: () => NOW,
        captureRunning: () => false,
        tools: [],
        notebook: {
          read: () => [
            { id: 'n1', section: '关于你', text: '密码是 hunter2' },
            { id: 'n2', section: '关于你', text: '喜欢周深' }
          ],
          update: fakeNotebook().update
        }
      },
      '在吗'
    )
    const text = JSON.stringify(client.askLoopRequests.at(-1))
    expect(text).not.toContain('hunter2')
    expect(text).toContain('喜欢周深')
  })

  it('空本子不写这一节（不出现空标题）', async () => {
    const client = new FakeLlmClient([{ json: { answer: '嗯。', citations: [] } }])
    await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: createLocalAskOutbound(),
        now: () => NOW,
        captureRunning: () => false,
        tools: [],
        notebook: { read: () => [], update: fakeNotebook().update }
      },
      '在吗'
    )
    expect(JSON.stringify(client.askLoopRequests.at(-1))).not.toContain('小本本')
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
