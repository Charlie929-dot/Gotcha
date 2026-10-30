/**
 * 问记忆读段（2026-10-29 拍板）：**OCR 不可信**。
 * - read_segment 只回 UIA 文字，OCR 正文一律不回；
 * - 该段最近一张截图随结果带出（主进程注入 readShot；没开历史截图就不带）；
 * - 图走 user 消息，payload 里挂在 turn.images 上；正文命中脱敏规则时不附图。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { buildAskLoopPayload, type AskOutbound } from '../../src/chain/agent/payload'
import { createAskToolExecutor } from '../../src/chain/agent/tools'
import { ensureChainSchema } from '../../src/chain/schema'
import { closeSegment, insertContent, insertShot, openSegment, type ChainDb } from '../../src/chain/store'

const NOW = new Date(2026, 9, 29, 22, 0, 0, 0).getTime()
const SHOT_PATH = 'C:\\shots\\a.jpg'
const DATA_URL = 'data:image/jpeg;base64,AAAA'

function seedSegment(db: ChainDb, options: { uia?: string; ocr?: string } = {}): number {
  const id = openSegment(
    db,
    { startTs: NOW, pid: 42, exe: 'app42', app: 'App', hwnd: 420, title: 'Title' },
    NOW
  )
  if (options.uia !== undefined) {
    insertContent(db, { segmentId: id, capturedAt: NOW + 1_000, source: 'uia', text: options.uia })
  }
  if (options.ocr !== undefined) {
    insertContent(db, { segmentId: id, capturedAt: NOW + 2_000, source: 'ocr', text: options.ocr })
  }
  insertShot(db, {
    segmentId: id,
    ts: NOW + 3_000,
    path: SHOT_PATH,
    width: 1920,
    height: 1080,
    bytes: 100,
    source: 'event',
    tier: 'hot'
  })
  closeSegment(db, id, {
    startTs: NOW,
    endTs: NOW + 4_000,
    activeMs: 4_000,
    idleMs: 0,
    pid: 42,
    exe: 'app42',
    app: 'App',
    hwnd: 420,
    titleFirst: 'Title',
    titleLast: 'Title'
  })
  return id
}

function executorFor(db: ChainDb, options: { readShot?: (path: string) => string | null } = {}) {
  return createAskToolExecutor({
    db,
    now: () => NOW,
    captureRunning: () => false,
    canReadSegment: () => true,
    ...(options.readShot ? { readShot: options.readShot } : {})
  })
}

describe('read_segment：只信 UIA + 截图', () => {
  it('回 UIA 文字、不回 OCR 正文，并带出最近一张截图', async () => {
    const db = new Database(':memory:')
    ensureChainSchema(db)
    const id = seedSegment(db, { uia: 'UIA 界面文字', ocr: 'OCR 糊成一团的字' })
    const read = optionsReadShot()
    const outcome = await executorFor(db, { readShot: read }).execute({
      name: 'read_segment',
      arguments: { segmentId: id }
    })
    const result = outcome.result as { kind: string; text?: string; shotCount?: number }
    expect(result.kind).toBe('read_segment')
    expect(result.text).toBe('UIA 界面文字')
    expect(result.text).not.toContain('OCR')
    expect(result.shotCount).toBe(1)
    expect(outcome.images).toEqual([DATA_URL])
    db.close()
  })

  it('只有 OCR / 截图、没有 UIA 时：文字为空但图照带（不再报「只有截图」之外的话）', async () => {
    const db = new Database(':memory:')
    ensureChainSchema(db)
    const id = seedSegment(db, { ocr: 'OCR 糊字' })
    const outcome = await executorFor(db, { readShot: () => DATA_URL }).execute({
      name: 'read_segment',
      arguments: { segmentId: id }
    })
    const result = outcome.result as { kind: string; text?: string; shotCount?: number }
    expect(result.kind).toBe('read_segment')
    expect(result.text).toBe('')
    expect(result.shotCount).toBe(1)
    expect(outcome.images).toEqual([DATA_URL])
    db.close()
  })

  it('没注入 readShot（历史截图关着）时不带图，只有 OCR 的段如实报错', async () => {
    const db = new Database(':memory:')
    ensureChainSchema(db)
    const id = seedSegment(db, { ocr: 'OCR 糊字' })
    const outcome = await executorFor(db).execute({
      name: 'read_segment',
      arguments: { segmentId: id }
    })
    expect(outcome.result.kind).toBe('error')
    expect(outcome.images).toBeUndefined()
    db.close()
  })
})

describe('载荷：截图只挂 turn.images，正文脱敏时不附图', () => {
  function loopInput(turn: Parameters<AskOutbound['buildLoop']>[0]['turns'][number]) {
    return {
      question: '看看这一段',
      systemTime: '2026-10-29 22:00 周四',
      freshness: { latestEvidenceTs: NOW, captureRunning: false },
      turns: [turn]
    }
  }

  it('图片挂在 turn 上，并在工具结果里报 shotCount', () => {
    const outbound: AskOutbound = {
      buildAsk: () => {
        throw new Error('not used')
      },
      buildLoop: (input) =>
        buildAskLoopPayload(input, { redact: (text) => ({ text, redacted: false, blocked: false }) }),
      buildSummary: (text) => ({ payload: { text }, chars: text.length, blocked: false })
    }
    const built = outbound.buildLoop(
      loopInput({
        toolCall: { name: 'read_segment', arguments: { segmentId: 7 } },
        toolResult: {
          kind: 'read_segment',
          freshness: { latestEvidenceTs: NOW, captureRunning: false },
          segmentId: 7,
          at: '22:00',
          app: 'App',
          title: 'Title',
          text: 'UIA 界面文字',
          urls: [],
          offset: 0,
          limit: 3000
        },
        images: [DATA_URL]
      })
    )
    const turn = built.payload.turns[0]
    expect(turn.images).toEqual([DATA_URL])
    expect((turn.toolResult as { shotCount: number }).shotCount).toBe(1)
  })

  it('正文命中脱敏规则时丢图（图没法脱敏，不让原图绕过去）', () => {
    const outbound: AskOutbound = {
      buildAsk: () => {
        throw new Error('not used')
      },
      buildLoop: (input) =>
        buildAskLoopPayload(input, {
          redact: (text) => ({
            text: text.replace('secret', '[已脱敏]'),
            redacted: text.includes('secret'),
            blocked: false
          })
        }),
      buildSummary: (text) => ({ payload: { text }, chars: text.length, blocked: false })
    }
    const built = outbound.buildLoop(
      loopInput({
        toolCall: { name: 'read_segment', arguments: { segmentId: 7 } },
        toolResult: {
          kind: 'read_segment',
          freshness: { latestEvidenceTs: NOW, captureRunning: false },
          segmentId: 7,
          at: '22:00',
          app: 'App',
          title: 'Title',
          text: 'secret 内容',
          urls: [],
          offset: 0,
          limit: 3000
        },
        images: [DATA_URL]
      })
    )
    const turn = built.payload.turns[0]
    expect(turn.images).toBeUndefined()
    expect((turn.toolResult as { shotCount: number }).shotCount).toBe(0)
  })
})

function optionsReadShot(): (path: string) => string | null {
  return (path) => (path === SHOT_PATH ? DATA_URL : null)
}
