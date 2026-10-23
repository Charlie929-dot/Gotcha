import { describe, expect, it, vi } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { getSetting } from '../../src/db/settings'
import { FakeLlmClient, LlmAbortError, type LlmClient } from '../../src/understand/cloud/llm-client'
import { createInductionRuntime, type ClientResolution } from '../../src/main/induction-runtime'
import { GRAPH_SETTING_KEYS } from '../../src/main/graph-settings'

const NOW = new Date(2026, 9, 22, 12, 0, 0, 0).getTime()

function seed(db: Db): number {
  return insertEvent(db, {
    ts: NOW - 10 * 60_000,
    app: 'notepad',
    windowTitle: '会议纪要',
    ocrText: '项目计划'
  })
}

function clientOk(events: number[]): FakeLlmClient {
  return new FakeLlmClient([
    {
      json: {
        nodes: [
          { title: '项目计划', summary: '计划与待办', type: 'knowledge', event_ids: events }
        ],
        edges: []
      },
      usage: { promptTokens: 10, completionTokens: 5 }
    }
  ])
}

function runtimeFor(
  db: Db,
  resolveClient: () => ClientResolution,
  overrides: Partial<Parameters<typeof createInductionRuntime>[0]> = {}
) {
  return createInductionRuntime({
    getDb: () => db,
    resolveClient,
    now: () => NOW,
    firstDelayMs: 60 * 60_000,
    ...overrides
  })
}

function countNodes(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n
}

describe('InductionRuntime：出网确认门（D24）', () => {
  it('未确认：采集 running 也不启动调度，runOnce 返回 consent 且零请求', async () => {
    const db = openDatabase(':memory:')
    const id = seed(db)
    const client = clientOk([id])
    const runtime = runtimeFor(db, () => ({ ok: true, client }))

    runtime.onCaptureStatus('running')
    expect(runtime.getSnapshot()).toMatchObject({
      consent: false,
      captureRunning: true,
      status: 'stopped'
    })

    const outcome = await runtime.runOnce({ manual: true })
    expect(outcome).toEqual({ status: 'skipped', reason: 'consent' })
    expect(client.requests).toHaveLength(0)
    expect(countNodes(db)).toBe(0)
    runtime.dispose()
    db.close()
  })

  it('grantConsent：写 settings；running 下即可手动归纳并落库 + 记账', async () => {
    const db = openDatabase(':memory:')
    const id = seed(db)
    const client = clientOk([id])
    const snapshots: unknown[] = []
    const runtime = runtimeFor(db, () => ({ ok: true, client }), {
      onSnapshot: (snapshot) => snapshots.push(snapshot)
    })

    runtime.onCaptureStatus('running')
    runtime.grantConsent()
    expect(getSetting(db, GRAPH_SETTING_KEYS.outboundConsent)).toBe('1')
    expect(runtime.getSnapshot()).toMatchObject({ consent: true, captureRunning: true })
    expect(snapshots.length).toBeGreaterThan(0)

    const outcome = await runtime.runOnce({ manual: true })
    expect(outcome).toMatchObject({ status: 'ok', nodes: 1, edges: 0, consumed: 1 })
    expect(client.requests).toHaveLength(1)
    expect(countNodes(db)).toBe(1)
    runtime.dispose()
    db.close()
  })

  it('采集暂停时即使已确认也零请求（手动归纳也跳过）', async () => {
    const db = openDatabase(':memory:')
    const id = seed(db)
    const client = clientOk([id])
    const runtime = runtimeFor(db, () => ({ ok: true, client }))
    runtime.grantConsent()
    runtime.onCaptureStatus('running')
    runtime.onCaptureStatus('paused')

    const outcome = await runtime.runOnce({ manual: true })
    expect(outcome).toEqual({ status: 'skipped', reason: 'paused' })
    expect(client.requests).toHaveLength(0)
    runtime.dispose()
    db.close()
  })

  it('撤销确认门：停调度、写回 0，runOnce 回到 consent 跳过', async () => {
    const db = openDatabase(':memory:')
    const id = seed(db)
    const client = clientOk([id])
    const runtime = runtimeFor(db, () => ({ ok: true, client }))
    runtime.grantConsent()
    runtime.onCaptureStatus('running')

    runtime.setConsent(false)
    expect(getSetting(db, GRAPH_SETTING_KEYS.outboundConsent)).toBe('0')
    const outcome = await runtime.runOnce({ manual: true })
    expect(outcome).toEqual({ status: 'skipped', reason: 'consent' })
    expect(client.requests).toHaveLength(0)
    runtime.dispose()
    db.close()
  })
})

describe('InductionRuntime：供应商状态与暂停取消', () => {
  it('未配置供应商：快照带原因，runOnce 不抛错（skipped not-configured）', async () => {
    const db = openDatabase(':memory:')
    seed(db)
    const runtime = runtimeFor(db, () => ({
      ok: false,
      reason: 'missing-key',
      apiKeyEnv: 'DEEPSEEK_API_KEY'
    }))
    runtime.grantConsent()
    runtime.onCaptureStatus('running')

    expect(runtime.getSnapshot().client).toEqual({
      ok: false,
      reason: 'missing-key',
      apiKeyEnv: 'DEEPSEEK_API_KEY'
    })
    const outcome = await runtime.runOnce({ manual: true })
    expect(outcome).toEqual({ status: 'skipped', reason: 'not-configured' })
    runtime.dispose()
    db.close()
  })

  it('暂停中止在途请求：结果丢弃、不落库（D18）', async () => {
    const db = openDatabase(':memory:')
    seed(db)
    let requests = 0
    const client: LlmClient = {
      completeJson: async (_payload, options) => {
        requests += 1
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100)
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new LlmAbortError())
            },
            { once: true }
          )
        })
        return { json: { nodes: [], edges: [] }, usage: { promptTokens: 1, completionTokens: 1 } }
      }
    }
    const runtime = runtimeFor(db, () => ({ ok: true, client }))
    runtime.grantConsent()
    runtime.onCaptureStatus('running')

    const pending = runtime.runOnce({ manual: true })
    setTimeout(() => runtime.onCaptureStatus('paused'), 10)
    const outcome = await pending

    expect(outcome).toEqual({ status: 'aborted' })
    expect(requests).toBe(1)
    expect(countNodes(db)).toBe(0)
    runtime.dispose()
    db.close()
  })
})
