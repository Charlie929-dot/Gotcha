import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS_DDL } from '../../src/db/schema'
import { ensureChainSchema } from '../../src/chain/schema'
import {
  closeSegment,
  getSegmentDetail,
  insertContent,
  openSegment,
  querySegments,
  type ChainDb
} from '../../src/chain/store'
import type { DesktopEventSource, RawDesktopEvent } from '../../src/chain/hook/types'
import type { ShotStats } from '../../src/chain/recorder'
import { NativeDesktopSource } from '../../src/chain/hook/native'
import { LlmAbortError, type LlmClient } from '../../src/understand/cloud/llm-client'
import {
  createChainRecording,
  loadChainEventSource,
  type ChainContentWiring,
  type ChainRecordingHandle,
  type ChainRecordingOptions
} from '../../src/main/chain-recording'
import type { ChainShotFs, ChainShotWindow } from '../../src/main/chain-shot'

/** 本地 2026-10-26 12:00 */
const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const at = (seconds: number): number => T0 + seconds * 1000

class FakeSource implements DesktopEventSource {
  tick = at(0)
  handler: ((event: RawDesktopEvent) => void) | null = null
  starts = 0
  stops = 0
  readonly sourceInfo = { kind: 'fake' as const, detail: 'fake-source' }
  start(onEvent: (event: RawDesktopEvent) => void): void {
    this.handler = onEvent
    this.starts += 1
  }
  stop(): void {
    this.handler = null
    this.stops += 1
  }
  lastInputTickMs(): number {
    return this.tick
  }
  emit(event: RawDesktopEvent): void {
    this.handler?.(event)
  }
}

const WINDOW: ChainShotWindow = {
  pid: 4242,
  hwnd: 42_424,
  title: '文章 A - Firefox',
  executable: 'firefox.exe',
  bounds: { x: 10, y: 20, width: 1_000, height: 800 }
}

function foreground(seconds: number, overrides: Partial<ChainShotWindow> = {}): RawDesktopEvent {
  const win = { ...WINDOW, ...overrides }
  return {
    type: 'foreground',
    ts: at(seconds),
    pid: win.pid,
    hwnd: win.hwnd,
    exe: win.executable,
    title: win.title,
    app: 'Firefox'
  }
}

function click(seconds: number): RawDesktopEvent {
  return { type: 'click', ts: at(seconds), x: 100, y: 200, button: 'left' }
}

/** 假 fs：只记操作，不真写盘 */
function fakeFs(size = 4_096): ChainShotFs & { moves: Array<[string, string]> } {
  const moves: Array<[string, string]> = []
  return {
    moves,
    mkdirSync: () => {},
    renameSync: (from, to) => {
      moves.push([from, to])
    },
    statSync: () => ({ size }),
    rmSync: () => {}
  }
}

function build(
  options: {
    source?: DesktopEventSource | null
    window?: () => Promise<ChainShotWindow | null>
    content?: ChainContentWiring
    derive?: ChainRecordingOptions['derive']
  } = {}
) {
  let frameTs = 0
  const shots: ShotStats[] = []
  const handle = createChainRecording({
    db,
    source: options.source === undefined ? new FakeSource() : options.source,
    screen: {
      capture: async (_bounds, _tempDir, ts) => {
        frameTs = ts
        return { imagePath: `C:/tmp-chain/frame-${ts}.png`, width: 1_000, height: 800 }
      }
    },
    userDataDir: 'C:/userData',
    // 时钟固定在「所有事件之后」：stop 收口时段的结束时刻不会早于子行（契约 §3 第 3 条）
    now: () => at(60),
    getWindow: options.window ?? (async () => WINDOW),
    isBlacklisted: () => false,
    content: options.content,
    derive: options.derive,
    log: (_level, _msg, data) => {
      if (data && typeof data.shots === 'object' && data.shots !== null) {
        shots.push(data.shots as ShotStats)
      }
    },
    fs: fakeFs()
  })
  return { handle, frameTs: () => frameTs, loggedShots: shots }
}

let db: ChainDb

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SETTINGS_DDL)
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

describe('原生事件源加载', () => {
  it('没有可用的 .node 就返回 null，不抛错、不假装能采', () => {
    const source = loadChainEventSource({ repoRoot: 'C:/repo', exists: () => false })
    expect(source).toBeNull()
  })

  it('加载成功就包成原生事件源，自述带上版本', () => {
    const binding = { start: () => {}, stop: () => {}, lastInputTickMs: () => 0, version: '0.1.0' }
    const source = loadChainEventSource({
      repoRoot: 'C:/repo',
      exists: () => true,
      load: () => binding
    })
    expect(source).toBeInstanceOf(NativeDesktopSource)
    expect(source?.sourceInfo).toEqual({ kind: 'native', detail: 'chain_hook 0.1.0' })
  })

  it('加载抛错也降级成 null（ABI 不对 / 被拦）', () => {
    const source = loadChainEventSource({
      repoRoot: 'C:/repo',
      exists: () => true,
      load: () => {
        throw new Error('was compiled against a different Node.js version')
      }
    })
    expect(source).toBeNull()
  })
})

describe('信息链接进采集开关', () => {
  it('没有原生源：不启动、不建表、不写一行', async () => {
    const { handle } = build({ source: null })
    handle.start()
    expect(handle.status()).toMatchObject({ started: false, shots: null })
    await handle.stop()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chain_%'")
      .all() as Array<{ name: string }>
    // 表是 beforeEach 建的（模拟已开库）；关键是没写数据
    expect(tables.length).toBeGreaterThan(0)
    expect(querySegments(db)).toHaveLength(0)
  })

  it('start 订阅事件源，stop 收口开着的段并等在途截图落库', async () => {
    const source = new FakeSource()
    const { handle } = build({ source })
    handle.start()
    expect(source.starts).toBe(1)
    expect(handle.status().started).toBe(true)

    source.emit(foreground(0))
    source.emit(click(5))
    const openId = handle.status().openSegmentId
    expect(openId).not.toBeNull()
    // 抓帧是异步的：事件已在，截图还没落定
    expect(handle.status().shots).toMatchObject({ pending: 2, inserted: 0 })

    await handle.stop()
    expect(source.stops).toBe(1)
    expect(handle.status().started).toBe(false)

    const [segment] = querySegments(db)
    const detail = getSegmentDetail(db, segment.id)
    expect(detail?.events.map((row) => row.kind)).toEqual(['enter', 'click_left'])
    expect(detail?.shots.map((row) => row.source)).toEqual(['enter', 'event'])
    expect(detail?.shots.map((row) => row.ts)).toEqual([at(0), at(5)])
    expect(detail?.shots[0].path).toContain('chain-shots')
  })

  it('前台已经切走：截图记成没拍到，不拿别人的画面冒充', async () => {
    const source = new FakeSource()
    const { handle, loggedShots } = build({
      source,
      window: async () => ({ ...WINDOW, pid: 777, hwnd: 77_777 })
    })
    handle.start()
    source.emit(foreground(0))
    source.emit(click(5))
    await handle.stop()

    const [segment] = querySegments(db)
    const detail = getSegmentDetail(db, segment.id)
    expect(detail?.events).toHaveLength(2)
    expect(detail?.shots).toHaveLength(0)
    expect(loggedShots.at(-1)).toMatchObject({ inserted: 0, dropped: 2, failed: 0 })
  })

  it('重复 start / stop 都安全（状态切换会重入）', async () => {
    const source = new FakeSource()
    const { handle } = build({ source })
    handle.start()
    handle.start()
    expect(source.starts).toBe(1)
    await Promise.all([handle.stop(), handle.stop()])
    expect(source.stops).toBe(1)
  })

  it('status 的 shots 在没启动时是 null', () => {
    const { handle }: { handle: ChainRecordingHandle } = build()
    expect(handle.status().shots).toBeNull()
    expect(handle.status().source).toMatchObject({ kind: 'fake' })
  })
})

describe('内容来源接进采集（D43）', () => {
  it('证据落定后读文本并写进 chain_content；16s 内同段第二张被节流', async () => {
    const reads: Array<{ hwnd: number; executable: string; framePath: string | null }> = []
    const source = new FakeSource()
    const { handle } = build({
      source,
      content: {
        createReader: () => ({
          read: async (input) => {
            reads.push(input)
            return { source: 'uia', text: '正文 A' }
          },
          dispose: async () => {}
        })
      }
    })
    handle.start()
    source.emit(foreground(0))
    source.emit(click(5))
    await handle.stop()

    // 时钟固定在 at(60)：第一张入场帧读了，点击帧落在 15s 节流窗口内
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ hwnd: WINDOW.hwnd, executable: WINDOW.executable })
    expect(reads[0]?.framePath).toContain('chain-shots')

    const [segment] = querySegments(db)
    const contents = getSegmentDetail(db, segment.id)?.contents ?? []
    expect(contents).toHaveLength(1)
    expect(contents[0]).toMatchObject({ source: 'uia', text: '正文 A', captured_at: at(0) })
    expect(handle.status().content).toMatchObject({ queued: 1, inserted: 1, throttled: 1 })
  })

  it('关掉节流后每张证据都读；正文没变只落一行（指纹去重）', async () => {
    let calls = 0
    const source = new FakeSource()
    const { handle } = build({
      source,
      content: {
        minIntervalMs: 0,
        createReader: () => ({
          read: async () => {
            calls += 1
            return { source: 'uia', text: '同一段里没变的正文' }
          },
          dispose: async () => {}
        })
      }
    })
    handle.start()
    source.emit(foreground(0))
    source.emit(click(5))
    await handle.stop()

    expect(calls).toBe(2)
    const [segment] = querySegments(db)
    expect(getSegmentDetail(db, segment.id)?.contents).toHaveLength(1)
    expect(handle.status().content).toMatchObject({ queued: 2, inserted: 1, duplicates: 1 })
  })

  it('读不回来：不写内容行，截图照记', async () => {
    const source = new FakeSource()
    const { handle } = build({
      source,
      content: {
        createReader: () => ({
          read: async () => null,
          dispose: async () => {}
        })
      }
    })
    handle.start()
    source.emit(foreground(0))
    source.emit(click(5))
    await handle.stop()

    const [segment] = querySegments(db)
    expect(getSegmentDetail(db, segment.id)?.contents).toHaveLength(0)
    expect(getSegmentDetail(db, segment.id)?.shots).toHaveLength(2)
    expect(handle.status().content).toMatchObject({ empty: 1 })
  })

  it('stop 会关掉读取链（PowerShell 子进程不留在后台）', async () => {
    let disposed = 0
    const source = new FakeSource()
    const { handle } = build({
      source,
      content: {
        createReader: () => ({
          read: async () => ({ source: 'uia', text: '正文' }),
          dispose: async () => {
            disposed += 1
          }
        })
      }
    })
    handle.start()
    source.emit(foreground(0))
    await handle.stop()
    expect(disposed).toBe(1)
  })

  it('不给内容来源：内容列是 null，不读也不写', async () => {
    const source = new FakeSource()
    const { handle } = build({ source })
    handle.start()
    source.emit(foreground(0))
    await handle.stop()
    expect(handle.status().content).toBeNull()
    const [segment] = querySegments(db)
    expect(getSegmentDetail(db, segment.id)?.contents).toHaveLength(0)
  })
})

describe('派生层接进采集（v0.8 / D45）', () => {
  const embedder = {
    model: 'fake-embedding-v1',
    dim: 4,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array([1, 0, 0, 0]))
    }
  }

  /** 预置一个已收口、有内容的段（派生扫描的输入） */
  function seededSegment(): number {
    const startTs = at(-3_600)
    const segmentId = openSegment(
      db,
      { startTs, pid: 9, exe: 'firefox', app: 'Firefox', hwnd: 90, title: '旧页面' },
      startTs
    )
    closeSegment(db, segmentId, {
      startTs,
      endTs: startTs + 60_000,
      activeMs: 60_000,
      idleMs: 0,
      pid: 9,
      exe: 'firefox',
      app: 'Firefox',
      hwnd: 90,
      titleFirst: '旧页面',
      titleLast: '旧页面'
    })
    insertContent(db, {
      segmentId,
      capturedAt: startTs + 1_000,
      source: 'uia',
      text: '记忆球 内容'
    })
    return segmentId
  }

  async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
    const started = Date.now()
    while (!check()) {
      if (Date.now() - started > timeoutMs) throw new Error('等待超时')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('没接派生层：status().derive 是 null', async () => {
    const source = new FakeSource()
    const { handle } = build({ source })
    handle.start()
    source.emit(foreground(0))
    await handle.stop()
    expect(handle.status().derive).toBeNull()
  })

  it('接了派生层：跟采集一起启动，暂停即停（统计保留）', async () => {
    const source = new FakeSource()
    const { handle } = build({
      source,
      derive: {
        resolveClient: () => ({ ok: false, reason: 'missing-key' }),
        readConsent: () => false,
        loadEmbedder: async () => embedder
      }
    })
    handle.start()
    expect(handle.status().derive?.started).toBe(true)
    source.emit(foreground(0))
    await handle.stop()
    expect(handle.status().derive?.started).toBe(false)
  })

  it('暂停时中止在途抽取请求', async () => {
    seededSegment()
    let extractCalls = 0
    let aborted = 0
    const client: LlmClient = {
      completeJson: async () => {
        throw new Error('unused: completeJson')
      },
      completeNaming: async () => {
        throw new Error('unused: completeNaming')
      },
      completeAssignments: async () => {
        throw new Error('unused: completeAssignments')
      },
      completeChainExtract: (_payload, options) =>
        new Promise((_resolve, reject) => {
          extractCalls += 1
          options?.signal?.addEventListener('abort', () => {
            aborted += 1
            reject(new LlmAbortError())
          })
        }),
      completeChainMerge: async () => {
        throw new Error('unused: completeChainMerge')
      }
    }
    const source = new FakeSource()
    const { handle } = build({
      source,
      derive: {
        resolveClient: () => ({ ok: true, client }),
        readConsent: () => true,
        loadEmbedder: async () => embedder
      }
    })
    handle.start()
    await waitFor(() => extractCalls === 1)
    await handle.stop()
    expect(aborted).toBe(1)
    expect(handle.status().derive?.started).toBe(false)
  })
})
