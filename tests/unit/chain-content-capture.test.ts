import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ContentPayload } from '../../src/chain/recorder'
import { createChainContentCapture, type ChainContentShot } from '../../src/main/chain-content'

/** 本文件里创建的临时目录（afterEach 统一清掉） */
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

const SHOT: ChainContentShot = {
  segmentId: 1,
  eventId: 7,
  at: 1_000,
  hwnd: 42_424,
  executable: 'firefox.exe',
  framePath: 'C:/userData/chain-shots/2026-10-26/s1-e7-1000.png'
}

/** 可手动放行的 Promise（测「在途时 drain 会等」） */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function build(options: {
  read?: (input: { hwnd: number; executable: string; framePath: string | null }) => Promise<ContentPayload | null>
  minIntervalMs?: number
  inserted?: boolean
} = {}) {
  const clock = { value: 100_000 }
  const reads: Array<{ hwnd: number; executable: string; framePath: string | null }> = []
  const writes: Array<{ segmentId: number; at: number; payload: ContentPayload }> = []
  const capture = createChainContentCapture({
    reader: {
      read: async (input) => {
        reads.push(input)
        if (options.read) return await options.read(input)
        return { source: 'uia', text: '正文' }
      }
    },
    onContent: (segmentId, at, payload) => {
      writes.push({ segmentId, at, payload })
      return options.inserted ?? true
    },
    minIntervalMs: options.minIntervalMs ?? 15_000,
    now: () => clock.value
  })
  return { capture, reads, writes, clock }
}

describe('内容车道：抓帧落定后异步读，按段 15s 节流', () => {
  it('读一次：句柄与证据图都传下去，时刻用触发事件的时刻', async () => {
    const { capture, reads, writes } = build()
    capture.onShot(SHOT)
    await capture.drain()

    expect(reads).toEqual([{ hwnd: 42_424, executable: 'firefox.exe', framePath: SHOT.framePath }])
    expect(writes).toEqual([{ segmentId: 1, at: 1_000, payload: { source: 'uia', text: '正文' } }])
    expect(capture.stats).toMatchObject({ queued: 1, inserted: 1, throttled: 0, empty: 0, failed: 0 })
  })

  it('同一段 15s 内的第二张不读（节流），过了 15s 再读', async () => {
    const { capture, reads, clock } = build()
    capture.onShot(SHOT)
    await capture.drain()
    expect(reads).toHaveLength(1)

    clock.value += 5_000
    capture.onShot({ ...SHOT, eventId: 8, at: 6_000 })
    await capture.drain()
    expect(reads).toHaveLength(1)
    expect(capture.stats.throttled).toBe(1)

    clock.value += 10_000
    capture.onShot({ ...SHOT, eventId: 9, at: 16_000 })
    await capture.drain()
    expect(reads).toHaveLength(2)
  })

  it('换了一段：即使刚才读过也立即读（新窗口的内容是新的）', async () => {
    const { capture, reads } = build()
    capture.onShot(SHOT)
    await capture.drain()
    capture.onShot({ ...SHOT, segmentId: 2, eventId: 20, at: 2_000 })
    await capture.drain()
    expect(reads).toHaveLength(2)
    expect(capture.stats.throttled).toBe(0)
  })

  it('读到但正文没变：记 duplicates，不算失败', async () => {
    const { capture } = build({ inserted: false })
    capture.onShot(SHOT)
    await capture.drain()
    expect(capture.stats).toMatchObject({ inserted: 0, duplicates: 1 })
  })

  it('读不回来：记 empty，不写行、不抛错', async () => {
    const { capture } = build({ read: async () => null })
    capture.onShot(SHOT)
    await capture.drain()
    expect(capture.stats).toMatchObject({ empty: 1, inserted: 0 })
  })

  it('读取抛错：记 failed，车道继续跑后面的', async () => {
    let call = 0
    const { capture, writes } = build({
      read: async () => {
        call += 1
        if (call === 1) throw new Error('UIA 挂了')
        return { source: 'ocr', text: '第二条' }
      }
    })
    capture.onShot(SHOT)
    capture.onShot({ ...SHOT, segmentId: 2, eventId: 21, at: 2_000 })
    await capture.drain()
    expect(capture.stats).toMatchObject({ failed: 1, inserted: 1 })
    expect(writes).toEqual([{ segmentId: 2, at: 2_000, payload: { source: 'ocr', text: '第二条' } }])
  })

  it('串行：前一条没读完，后一条不并发（工作器一次只服务一个请求）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { capture } = build({
      read: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { source: 'uia', text: '正文' }
      }
    })
    capture.onShot(SHOT)
    capture.onShot({ ...SHOT, segmentId: 2 })
    await capture.drain()
    expect(maxInFlight).toBe(1)
  })

  it('drain 等在途读数落库（退出前不丢最后一条）', async () => {
    const gate = deferred<ContentPayload | null>()
    const { capture, writes } = build({
      read: () => gate.promise
    })
    capture.onShot(SHOT)
    expect(writes).toHaveLength(0)
    const drained = capture.drain()
    // 车道在微任务里才真正发起读；等它挂上再放行
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    gate.resolve({ source: 'uia', text: '慢读回来的' })
    await drained
    expect(writes).toHaveLength(1)
  })

  it('close 之后不再接收新截图（在途的仍由 drain 等）', async () => {
    const { capture, reads } = build()
    capture.onShot(SHOT)
    capture.close()
    capture.onShot({ ...SHOT, eventId: 8, at: 9_000 })
    await capture.drain()
    expect(reads).toHaveLength(1)
  })

  it('被节流 / 车道已关的帧也要删 OCR 中转图（否则 tmp-chain 按抓帧频率长胖）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-ocr-'))
    dirs.push(dir)
    const readOne = join(dir, 'ocr-1.png')
    const throttledOne = join(dir, 'ocr-2.png')
    const closedOne = join(dir, 'ocr-3.png')
    for (const path of [readOne, throttledOne, closedOne]) writeFileSync(path, 'x')

    const { capture, clock } = build()
    capture.onShot({ ...SHOT, ocrPath: readOne })
    await capture.drain()
    expect(existsSync(readOne)).toBe(false) // 读过的照旧删

    clock.value += 5_000
    capture.onShot({ ...SHOT, eventId: 8, at: 6_000, ocrPath: throttledOne })
    expect(capture.stats.throttled).toBe(1)
    expect(existsSync(throttledOne)).toBe(false) // 节流的这张没人读，必须当场删

    capture.close()
    capture.onShot({ ...SHOT, eventId: 9, at: 7_000, ocrPath: closedOne })
    expect(existsSync(closedOne)).toBe(false) // 车道关了也要删
  })
})
