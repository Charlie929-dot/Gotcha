import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import { getSegmentDetail, querySegments, type ChainDb } from '../../src/chain/store'
import type { DesktopEventSource, RawDesktopEvent } from '../../src/chain/hook/types'
import type { ShotStats } from '../../src/chain/recorder'
import { NativeDesktopSource } from '../../src/chain/hook/native'
import {
  createChainRecording,
  loadChainEventSource,
  type ChainRecordingHandle
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

function build(options: { source?: DesktopEventSource | null; window?: () => Promise<ChainShotWindow | null> } = {}) {
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
