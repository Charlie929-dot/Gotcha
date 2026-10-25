import { describe, expect, it } from 'vitest'
import { LlmAbortError, LlmHttpError, FakeLlmClient } from '../../src/understand/cloud/llm-client'
import type { RedactableMoment } from '../../src/understand/cloud/redact'
import type { ConfirmMoment, ConfirmOutcome, ConfirmTheme } from '../../src/understand/theme-confirm'
import {
  createThemeQueue,
  THEME_QUEUE_DEFAULTS,
  type ConfirmAssignmentsFn,
  type NameThemeFn
} from '../../src/understand/theme-queue'
import type { ThemeNamingOutcome } from '../../src/understand/theme-naming'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function moment(momentId: number, overrides: Partial<ConfirmMoment> = {}): ConfirmMoment {
  return {
    momentId,
    app: 'chrome.exe',
    title: `标题 ${momentId}`,
    ocr: '正文',
    candidateThemeIds: [1],
    ...overrides
  }
}

function theme(themeId: number, overrides: Partial<ConfirmTheme> = {}): ConfirmTheme {
  return { themeId, title: `主题 ${themeId}`, summary: '摘要', ...overrides }
}

function nameMoment(eventId: number): RedactableMoment {
  return {
    app: 'chrome.exe',
    title: `标题 ${eventId}`,
    startTs: eventId,
    endTs: eventId,
    ocr: '正文',
    eventIds: [eventId]
  }
}

function llmName(title = '模型标题'): ThemeNamingOutcome {
  return {
    name: { title, summary: '模型摘要', type: 'activity' },
    source: 'llm',
    blockedEventIds: []
  }
}

describe('createThemeQueue · 串行与顺序（S5）', () => {
  it('同一时刻只有一个任务在途，按入队顺序执行', async () => {
    const order: number[] = []
    let concurrent = 0
    let maxConcurrent = 0
    const name: NameThemeFn = async (_client, moments) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      order.push(moments[0]!.eventIds[0]!)
      await Promise.resolve()
      await Promise.resolve()
      concurrent -= 1
      return llmName()
    }
    const queue = createThemeQueue({ resolveClient: () => new FakeLlmClient(), name })

    queue.enqueueNaming(1, [nameMoment(11)])
    queue.enqueueNaming(2, [nameMoment(22)])
    queue.enqueueNaming(3, [nameMoment(33)])
    await queue.drain()

    expect(order).toEqual([11, 22, 33])
    expect(maxConcurrent).toBe(1)
    expect(queue.getState().calls).toBe(3)
    expect(queue.getState().pendingMoments).toBe(0)
  })

  it('回调抛错不拖垮后面的任务', async () => {
    const client = new FakeLlmClient([
      { json: { assignments: [{ moment_id: 1, theme_ids: [1] }] } },
      { json: { assignments: [{ moment_id: 2, theme_ids: [1] }] } }
    ])
    const queue = createThemeQueue({
      resolveClient: () => client,
      onConfirm: () => {
        throw new Error('写库失败了')
      }
    })

    queue.enqueueConfirm([moment(1)], [theme(1)])
    queue.enqueueConfirm([moment(2)], [theme(1)])
    await queue.drain()

    expect(client.assignmentRequests).toHaveLength(2)
    expect(queue.getState().pendingMoments).toBe(0)
  })
})

describe('createThemeQueue · 暂停零出网与恢复补发（D18）', () => {
  it('暂停期间确认任务只入队不发；恢复后按批补发并记账用量', async () => {
    const client = new FakeLlmClient([
      {
        json: { assignments: [{ moment_id: 1, theme_ids: [1] }] },
        usage: { promptTokens: 100, completionTokens: 5 }
      }
    ])
    const confirmed: ConfirmOutcome[] = []
    const queue = createThemeQueue({
      resolveClient: () => client,
      onConfirm: (outcome) => confirmed.push(outcome)
    })

    queue.pause()
    const result = queue.enqueueConfirm([moment(1), moment(2)], [theme(1)])
    expect(result.status).toBe('queued')
    expect(result.accepted).toBe(2)
    await queue.drain()

    expect(client.assignmentRequests).toHaveLength(0)
    expect(confirmed).toHaveLength(0)
    expect(queue.getState().pendingMoments).toBe(2)

    queue.resume()
    await queue.drain()

    expect(client.assignmentRequests).toHaveLength(1)
    expect(client.assignmentRequests[0]!.moments.map((item) => item.momentId)).toEqual([1, 2])
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.pendingMomentIds).toEqual([2])
    expect(queue.getState()).toMatchObject({
      pendingMoments: 0,
      calls: 1,
      promptTokens: 100,
      completionTokens: 5
    })
  })

  it('暂停时 abort 在途请求：结果丢弃、任务回到队首，恢复后重做', async () => {
    const started = deferred()
    let attempt = 0
    const named: ThemeNamingOutcome[] = []
    const name: NameThemeFn = async (_client, _moments, options) => {
      attempt += 1
      if (attempt === 1) {
        started.resolve()
        await new Promise<never>((_resolve, reject) => {
          const signal = options.signal
          if (signal?.aborted) {
            reject(new LlmAbortError())
            return
          }
          signal?.addEventListener('abort', () => reject(new LlmAbortError()), { once: true })
        })
      }
      return llmName(`第 ${attempt} 次`)
    }
    const queue = createThemeQueue({
      resolveClient: () => new FakeLlmClient(),
      name,
      onNaming: (_themeId, outcome) => named.push(outcome)
    })

    queue.enqueueNaming(1, [nameMoment(1)])
    await started.promise
    queue.pause()
    await queue.drain()

    expect(named).toHaveLength(0) // 结果丢弃，没有写库
    expect(queue.getState()).toMatchObject({ pendingMoments: 1, abortedCalls: 1 })

    queue.resume()
    await queue.drain()

    expect(attempt).toBe(2)
    expect(named).toHaveLength(1)
    expect(named[0]!.name.title).toBe('第 2 次')
    expect(queue.getState().pendingMoments).toBe(0)
  })

  it('暂停 + 第三个任务排进来：恢复后仍按入队顺序补', async () => {
    const order: number[] = []
    const name: NameThemeFn = async (_client, moments) => {
      order.push(moments[0]!.eventIds[0]!)
      return llmName()
    }
    const queue = createThemeQueue({ resolveClient: () => new FakeLlmClient(), name })

    queue.pause()
    queue.enqueueNaming(1, [nameMoment(1)])
    queue.enqueueNaming(2, [nameMoment(2)])
    queue.enqueueNaming(3, [nameMoment(3)])
    await queue.drain()
    expect(order).toEqual([])

    queue.resume()
    await queue.drain()
    expect(order).toEqual([1, 2, 3])
  })
})

describe('createThemeQueue · 合并与去重', () => {
  it('同一主题的命名任务合并：只保留最后一次代表时刻，只发一次', async () => {
    const sent: number[][] = []
    const name: NameThemeFn = async (_client, moments) => {
      sent.push(moments.map((item) => item.eventIds[0]!))
      return llmName()
    }
    const queue = createThemeQueue({ resolveClient: () => new FakeLlmClient(), name })

    queue.pause()
    expect(queue.enqueueNaming(7, [nameMoment(1)]).status).toBe('queued')
    const merged = queue.enqueueNaming(7, [nameMoment(2), nameMoment(3)])
    expect(merged.status).toBe('merged')
    expect(merged.accepted).toBe(2)
    expect(queue.getState().pendingJobs).toBe(1)

    queue.resume()
    await queue.drain()

    expect(sent).toEqual([[2, 3]])
    expect(queue.getState().mergedJobs).toBe(1)
  })

  it('同一个时刻不重复排队（排队中的并进同一批，在途的直接忽略）', async () => {
    const client = new FakeLlmClient([{ json: { assignments: [] } }])
    const queue = createThemeQueue({ resolveClient: () => client })

    queue.pause()
    expect(queue.enqueueConfirm([moment(5)], [theme(1)]).accepted).toBe(1)
    const merged = queue.enqueueConfirm([moment(5), moment(6)], [theme(1)])
    expect(merged.status).toBe('merged')
    expect(merged.accepted).toBe(1)
    expect(merged.skipped).toBe(1)

    queue.resume()
    await queue.drain()
    expect(client.assignmentRequests).toHaveLength(1)
    expect(client.assignmentRequests[0]!.moments.map((item) => item.momentId)).toEqual([5, 6])
  })

  it('在途时刻再排队被忽略：等结果回来再决定，不并发写同一个时刻', async () => {
    const started = deferred()
    const gate = deferred()
    const confirm: ConfirmAssignmentsFn = async (_client, moments) => {
      started.resolve()
      await gate.promise
      return { decisions: [], failed: false, pendingMomentIds: [5], errors: [] }
    }
    const queue = createThemeQueue({ resolveClient: () => new FakeLlmClient(), confirm })

    queue.enqueueConfirm([moment(5)], [theme(1)])
    await started.promise

    const duplicate = queue.enqueueConfirm([moment(5)], [theme(1)])
    expect(duplicate.status).toBe('duplicate')
    expect(duplicate.skipped).toBe(1)

    gate.resolve()
    await queue.drain()
    expect(queue.getState().pendingMoments).toBe(0)
  })

  it('确认批按 20 条拆成多次请求', async () => {
    const ids = Array.from({ length: 25 }, (_value, index) => index + 1)
    const reply = (batch: number[]): { json: unknown } => ({
      json: { assignments: batch.map((id) => ({ moment_id: id, theme_ids: [1] })) }
    })
    const client = new FakeLlmClient([reply(ids.slice(0, 20)), reply(ids.slice(20))])
    const queue = createThemeQueue({ resolveClient: () => client })

    queue.enqueueConfirm(
      ids.map((id) => moment(id)),
      [theme(1)]
    )
    await queue.drain()

    expect(client.assignmentRequests.map((payload) => payload.moments.length)).toEqual([20, 5])
    expect(queue.getState().calls).toBe(2)
  })
})

describe('createThemeQueue · 上限与客户端状态', () => {
  it('队列上限：只收放得下的时刻，其余如实报告 dropped', async () => {
    const queue = createThemeQueue({
      resolveClient: () => new FakeLlmClient(),
      maxPendingMoments: 2
    })

    queue.pause()
    expect(queue.enqueueConfirm([moment(1), moment(2)], [theme(1)]).accepted).toBe(2)
    const over = queue.enqueueConfirm([moment(3)], [theme(1)])

    expect(over.status).toBe('full')
    expect(over.accepted).toBe(0)
    expect(over.dropped).toBe(1)
    expect(queue.getState()).toMatchObject({ pendingMoments: 2, droppedMoments: 1 })
    expect(THEME_QUEUE_DEFAULTS.maxPendingMoments).toBe(200)
  })

  it('没有客户端（D24 门 / 缺 key）：留住任务零请求，wake 之后补发', async () => {
    let client: FakeLlmClient | null = null
    const queue = createThemeQueue({ resolveClient: () => client })

    queue.enqueueConfirm([moment(1)], [theme(1)])
    await queue.drain()

    expect(queue.getState()).toMatchObject({ waitingClient: true, pendingMoments: 1, calls: 0 })

    client = new FakeLlmClient([
      { json: { assignments: [{ moment_id: 1, theme_ids: [1] }] } }
    ])
    queue.wake()
    await queue.drain()

    expect(client.assignmentRequests).toHaveLength(1)
    expect(queue.getState()).toMatchObject({ waitingClient: false, pendingMoments: 0, calls: 1 })
  })

  it('请求失败只影响这一条：命名兜底照样回调，后面的任务继续跑', async () => {
    const client = new FakeLlmClient([
      new LlmHttpError(500),
      { json: { title: '真名', summary: '真摘要', type: 'activity' } }
    ])
    const named: Array<[number, string, string | undefined]> = []
    const queue = createThemeQueue({
      resolveClient: () => client,
      onNaming: (themeId, outcome) =>
        named.push([themeId, outcome.source, outcome.reason as string | undefined])
    })

    queue.enqueueNaming(1, [nameMoment(1)])
    queue.enqueueNaming(2, [nameMoment(2)])
    await queue.drain()

    expect(named).toEqual([
      [1, 'fallback', 'llm-error'],
      [2, 'llm', undefined]
    ])
    expect(queue.getState()).toMatchObject({ calls: 2, failures: 1, pendingMoments: 0 })
  })

  it('销毁后不再接任务、不再发请求', async () => {
    const client = new FakeLlmClient([{ json: { assignments: [] } }])
    const queue = createThemeQueue({ resolveClient: () => client })

    queue.pause()
    queue.enqueueConfirm([moment(1)], [theme(1)])
    queue.dispose()
    queue.resume()
    await queue.drain()

    expect(queue.getState()).toMatchObject({ disposed: true, pendingMoments: 0, calls: 0 })
    expect(client.assignmentRequests).toHaveLength(0)
    expect(queue.enqueueConfirm([moment(2)], [theme(1)]).status).toBe('disposed')
  })
})
