import { describe, expect, it } from 'vitest'
import { createDeterministicFakeLlm } from '../../src/main/fake-llm'
import { buildCloudMomentPayload, type RedactableMoment } from '../../src/understand/cloud/redact'
import { LlmAbortError } from '../../src/understand/cloud/llm-client'
import { validateInduction } from '../../src/understand/structure/schema'

const MOMENTS: RedactableMoment[] = [
  {
    app: 'chrome.exe',
    title: '示例页面',
    startTs: 1_700_000_000_000,
    endTs: 1_700_000_030_000,
    ocr: '页面内容',
    eventIds: [1, 2]
  },
  {
    app: 'notepad.exe',
    title: '会议纪要',
    startTs: 1_700_000_100_000,
    endTs: 1_700_000_120_000,
    ocr: '待办事项',
    eventIds: [3]
  }
]

describe('createDeterministicFakeLlm', () => {
  it('输出覆盖全部输入 id 且能通过结构校验', async () => {
    const { client, counters } = createDeterministicFakeLlm()
    const built = buildCloudMomentPayload(MOMENTS)
    const allowed = new Set(built.payload.events.flatMap((event) => [...event.eventIds]))

    const result = await client.completeJson(built.payload)
    const validation = validateInduction(result.json, allowed)

    expect(validation.ok).toBe(true)
    expect(counters.requests).toBe(1)
    expect(counters.lastEventIds.sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(result.usage.promptTokens).toBeGreaterThan(0)
  })

  it('abort 时抛 LlmAbortError 并计数（暂停取消断言）', async () => {
    const { client, counters } = createDeterministicFakeLlm({ delayMs: 50 })
    const built = buildCloudMomentPayload(MOMENTS)
    const controller = new AbortController()
    const pending = client.completeJson(built.payload, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(LlmAbortError)
    expect(counters.aborted).toBe(1)
  })
})
