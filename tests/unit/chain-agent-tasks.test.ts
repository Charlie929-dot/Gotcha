/**
 * 问记忆循环里的任务工具（自调用 v0.2 §6）
 *
 * 守的纪律：
 * 1. 四个工具都要能用「模型给的人话参数」跑通，时间格式不对要给出可照抄的格式；
 * 2. 没接任务库时如实回「记不下」，绝不假装记下；
 * 3. 到点的任务进 `<now>`（合流），但不是命令——它只是几条事实。
 */

import { describe, expect, it, vi } from 'vitest'

import { createAskOutbound, createLocalAskOutbound } from '../../src/chain/agent/payload'
import { runAskLoop } from '../../src/chain/agent/loop'
import { createAskToolExecutor, type TaskToolDeps } from '../../src/chain/agent/tools'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'
import { openDatabase, type Db } from '../../src/db'
import { ensureChainSchema } from '../../src/chain/schema'

function freshDb(): Db {
  const db = openDatabase(':memory:')
  ensureChainSchema(db)
  return db
}

const NOW = new Date(2026, 10, 1, 12, 0, 0, 0).getTime()

function fakeTasks(overrides: Partial<TaskToolDeps> = {}): TaskToolDeps {
  return {
    schedule: vi.fn(() => ({
      ok: true,
      message: '记下了共建计划 #3：11-02 09:30 写周报',
      task: {
        id: 3,
        when: '11-02 09:30',
        repeat: '',
        origin: 'user',
        delivery: 'auto',
        state: 'active',
        instruction: '写周报',
        sync: 'synced'
      }
    })),
    search: vi.fn(() => ({
      tasks: [
        {
          id: 3,
          when: '11-02 09:30',
          repeat: '',
          origin: 'user',
          delivery: 'auto',
          state: 'active',
          instruction: '写周报'
        }
      ],
      total: 1,
      truncated: false
    })),
    update: vi.fn(() => ({ ok: true, message: '改好了 #3', task: null })),
    cancel: vi.fn(() => ({ ok: true, message: '取消了 #3', task: null })),
    ...overrides
  }
}

function executor(tasks?: TaskToolDeps) {
  const db = freshDb()
  const tool = createAskToolExecutor({
    db,
    now: () => NOW,
    captureRunning: () => false,
    ...(tasks ? { tasks } : {})
  })
  return { db, tool }
}

describe('schedule_task', () => {
  it('把人话时间解析成本地毫秒时间戳再交给任务库', async () => {
    const tasks = fakeTasks()
    const { tool } = executor(tasks)
    const outcome = await tool.execute({
      name: 'schedule_task',
      arguments: {
        instruction: '写周报',
        when: '2026-11-02 09:30',
        origin: 'user',
        delivery: 'foreground'
      }
    })
    expect(outcome.result).toMatchObject({ kind: 'schedule_task', ok: true })
    const call = (tasks.schedule as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      when: number
      origin: string
      delivery: string
      instruction: string
    }
    expect(call.when).toBe(new Date(2026, 10, 2, 9, 30, 0, 0).getTime())
    expect(call.origin).toBe('user')
    expect(call.delivery).toBe('foreground')
    expect(call.instruction).toBe('写周报')
  })

  it('时间格式不对：报错并给出可照抄的写法，不落库', async () => {
    const tasks = fakeTasks()
    const { tool } = executor(tasks)
    const outcome = await tool.execute({
      name: 'schedule_task',
      arguments: { instruction: '写周报', when: '明天九点', origin: 'user' }
    })
    expect(outcome.result.kind).toBe('error')
    expect(JSON.stringify(outcome.result)).toContain('YYYY-MM-DD HH:mm')
    expect(tasks.schedule).not.toHaveBeenCalled()
  })

  it('2 月 30 号这种不存在的日期也拒', async () => {
    const tasks = fakeTasks()
    const { tool } = executor(tasks)
    const outcome = await tool.execute({
      name: 'schedule_task',
      arguments: { instruction: '假的日期', when: '2026-02-30 09:00', origin: 'agent' }
    })
    expect(outcome.result.kind).toBe('error')
    expect(tasks.schedule).not.toHaveBeenCalled()
  })

  it('不给 instruction 直接拒', async () => {
    const { tool } = executor(fakeTasks())
    const outcome = await tool.execute({
      name: 'schedule_task',
      arguments: { when: '2026-11-02 09:30', origin: 'agent' }
    })
    expect(outcome.result.kind).toBe('error')
  })

  it('没接任务库：如实说记不下', async () => {
    const { tool } = executor()
    const outcome = await tool.execute({
      name: 'schedule_task',
      arguments: { instruction: '写周报', when: '2026-11-02 09:30', origin: 'user' }
    })
    expect(outcome.result.kind).toBe('error')
    expect(JSON.stringify(outcome.result)).toContain('记不下')
  })

  it('不传 when = 只记着（next_due_at 为 null）', async () => {
    const tasks = fakeTasks()
    const { tool } = executor(tasks)
    await tool.execute({
      name: 'schedule_task',
      arguments: { instruction: '以后别老追问', origin: 'agent' }
    })
    const call = (tasks.schedule as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      when: number | null
    }
    expect(call.when).toBeNull()
  })
})

describe('search_task / update / cancel', () => {
  it('search_tasks 四种视图都要 view；day / about 缺参数直接拒', async () => {
    const tasks = fakeTasks()
    const { tool } = executor(tasks)
    const ok = await tool.execute({ name: 'search_tasks', arguments: { view: 'pending' } })
    expect(ok.result.kind).toBe('search_tasks')

    const noView = await tool.execute({ name: 'search_tasks', arguments: {} })
    expect(noView.result.kind).toBe('error')

    const noDay = await tool.execute({ name: 'search_tasks', arguments: { view: 'day' } })
    expect(noDay.result.kind).toBe('error')

    const noQuery = await tool.execute({ name: 'search_tasks', arguments: { view: 'about' } })
    expect(noQuery.result.kind).toBe('error')
    expect(tasks.search).toHaveBeenCalledTimes(1)
  })

  it('limit 钳到 50；超过就给 50', async () => {
    const tasks = fakeTasks()
    const { tool } = executor(tasks)
    await tool.execute({ name: 'search_tasks', arguments: { view: 'pending', limit: 999 } })
    const call = (tasks.search as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      limit: number
    }
    expect(call.limit).toBe(50)
  })

  it('update_task 只把给了的字段传下去', async () => {
    const tasks = fakeTasks()
    const { tool } = executor(tasks)
    await tool.execute({
      name: 'update_task',
      arguments: { id: 3, when: '2026-11-02 10:00' }
    })
    const call = (tasks.update as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    expect(call).toEqual({ id: 3, when: new Date(2026, 10, 2, 10, 0, 0, 0).getTime() })
  })

  it('update_task / cancel_task 都需要正整数 id', async () => {
    const { tool } = executor(fakeTasks())
    for (const name of ['update_task', 'cancel_task']) {
      const outcome = await tool.execute({ name, arguments: { id: 0 } })
      expect(outcome.result.kind).toBe('error')
    }
  })

  it('没接任务库时 update / cancel 也如实报错', async () => {
    const { tool } = executor()
    for (const name of ['update_task', 'cancel_task']) {
      const outcome = await tool.execute({ name, arguments: { id: 3 } })
      expect(outcome.result.kind).toBe('error')
    }
  })
})

describe('循环里的回执与合流', () => {
  it('工具结果回灌给模型时，回执文案在（模型据此知道记下了什么）', async () => {
    const client = new FakeLlmClient([
      {
        toolCalls: [
          { name: 'schedule_task', arguments: { instruction: '写周报', when: '2026-11-02 09:30', origin: 'user' } }
        ]
      },
      { json: { answer: '记下了，明天九点半提醒你写周报。', citations: [] } }
    ])
    const result = await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: createLocalAskOutbound(),
        now: () => NOW,
        captureRunning: () => false,
        tools: ['schedule_task'],
        tasks: fakeTasks()
      },
      '明天九点半提醒我写周报'
    )
    expect(result.kind).toBe('answer')
    const last = JSON.stringify(client.askLoopRequests.at(-1))
    expect(last).toContain('#3')
    expect(last).toContain('记下了共建计划')
  })

  it('到点的事进 `<now>`：只是几条事实，不是命令', async () => {
    const client = new FakeLlmClient([{ json: { answer: '嗯，我在。', citations: [] } }])
    await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: createLocalAskOutbound(),
        now: () => NOW,
        captureRunning: () => false,
        tools: ['search_tasks'],
        tasks: fakeTasks(),
        dueTasks: () => [
          { id: 3, when: '11-01 12:00', instruction: '问他吃没吃饭', origin: 'agent' }
        ]
      },
      '在吗'
    )
    const payload = client.askLoopRequests.at(-1)
    const text = JSON.stringify(payload)
    expect(text).toContain('到点的事')
    expect(text).toContain('问他吃没吃饭')
    expect(text).toContain('由你判断')
  })

  it('到点的事命中脱敏规则：整条不列（不拆半句话送出去）', async () => {
    const client = new FakeLlmClient([{ json: { answer: '嗯。', citations: [] } }])
    // 用一份「含 hunter2 就整条阻断」的策略，模拟云端脱敏墙的行为
    const blocking = createAskOutbound({
      redact: (text: string) =>
        text.includes('hunter2')
          ? { text: '', redacted: true, blocked: true }
          : { text, redacted: false, blocked: false }
    })
    await runAskLoop(
      {
        db: freshDb(),
        client,
        outbound: blocking,
        now: () => NOW,
        captureRunning: () => false,
        tools: ['search_tasks'],
        tasks: fakeTasks(),
        dueTasks: () => [
          { id: 9, when: '11-01 12:00', instruction: '密码是 hunter2 别记错', origin: 'agent' }
        ]
      },
      '在吗'
    )
    const text = JSON.stringify(client.askLoopRequests.at(-1))
    expect(text).not.toContain('hunter2')
    // 一条都没剩下：整个「到点的事」小节也不出现（不写一个空标题）
    expect(text).not.toContain('到点的事')
  })
})

