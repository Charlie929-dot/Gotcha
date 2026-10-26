import Database from 'better-sqlite3'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import { openSegment, type ChainDb } from '../../src/chain/store'
import type { ShotRequest } from '../../src/chain/recorder'
import {
  chainShotFileName,
  createChainShotSource,
  sameWindow,
  type ChainShotFs,
  type ChainShotWindow
} from '../../src/main/chain-shot'

/** 本地 2026-10-26 12:00 */
const T0 = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const at = (seconds: number): number => T0 + seconds * 1000

let db: ChainDb
let segmentId: number

const WINDOW: ChainShotWindow = {
  pid: 4242,
  hwnd: 42_424,
  title: '文章 A - Firefox',
  executable: 'firefox.exe',
  bounds: { x: 10, y: 20, width: 1_000, height: 800 }
}

/** 记下文件操作的假 fs：断言「搬到了哪、字节数从哪来」 */
function fakeFs(size = 12_345): ChainShotFs & { moves: Array<[string, string]>; dirs: string[]; removed: string[] } {
  const moves: Array<[string, string]> = []
  const dirs: string[] = []
  const removed: string[] = []
  return {
    moves,
    dirs,
    removed,
    mkdirSync: (path) => {
      dirs.push(path)
    },
    renameSync: (from, to) => {
      moves.push([from, to])
    },
    statSync: () => ({ size }),
    rmSync: (path) => {
      removed.push(path)
    }
  }
}

function request(seconds = 1, overrides: Partial<ShotRequest> = {}): ShotRequest {
  return {
    segmentId,
    eventId: 7,
    at: at(seconds),
    kind: 'click_left',
    source: 'event',
    x: 100,
    y: 200,
    delta: null,
    ...overrides
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
  segmentId = openSegment(
    db,
    { startTs: at(0), pid: WINDOW.pid, exe: WINDOW.executable, app: 'Firefox', hwnd: WINDOW.hwnd, title: '文章 A' },
    at(0)
  )
})

afterEach(() => {
  db.close()
})

function build(overrides: {
  window?: ChainShotWindow | null
  /** 前台窗口的依次返回值（模拟抓帧期间切窗口）：用完后一直返回最后一个 */
  windows?: Array<ChainShotWindow | null>
  blacklisted?: boolean
  capture?: () => Promise<{ imagePath: string; width: number; height: number }>
  fs?: ChainShotFs
} = {}) {
  const captured: Array<{ bounds: unknown; tempDir: string; ts: number }> = []
  const sequence = overrides.windows ?? null
  let step = 0
  const source = createChainShotSource({
    db,
    shotsDir: 'C:/userData/chain-shots',
    tempDir: 'C:/userData/tmp-chain',
    screen: {
      capture: async (bounds, tempDir, ts) => {
        captured.push({ bounds, tempDir, ts })
        if (overrides.capture) return await overrides.capture()
        return { imagePath: `C:/userData/tmp-chain/frame-${ts}.png`, width: 1_000, height: 800 }
      }
    },
    getWindow: async () => {
      if (sequence) {
        const value = sequence[Math.min(step, sequence.length - 1)]
        step += 1
        return value
      }
      return overrides.window === undefined ? WINDOW : overrides.window
    },
    isBlacklisted: () => overrides.blacklisted === true,
    fs: overrides.fs ?? fakeFs()
  })
  return { source, captured }
}

describe('事件触发现抓一帧', () => {
  it('身份对得上：抓当前窗口那一块，搬进证据目录并报回宽高与字节', async () => {
    const fs = fakeFs(9_876)
    const { source, captured } = build({ fs })
    const expectedPath = join('C:/userData/chain-shots', chainShotFileName(request(1)))

    const result = await source(request(1))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ bounds: WINDOW.bounds, tempDir: 'C:/userData/tmp-chain', ts: at(1) })
    expect(result?.shot).toEqual({
      path: expectedPath,
      width: 1_000,
      height: 800,
      bytes: 9_876
    })
    // 搬走：从临时目录 rename 到按日期分层的证据目录
    expect(fs.moves).toEqual([[`C:/userData/tmp-chain/frame-${at(1)}.png`, expectedPath]])
    expect(expectedPath).toContain('2026-10-26')
    expect(expectedPath).toContain('s1-e7-')
  })

  it('前台已经切走：不拍，返回 null（错证据比没证据更糟）', async () => {
    const { source, captured } = build({ window: { ...WINDOW, hwnd: 99_999, pid: 555 } })
    expect(await source(request(1))).toBeNull()
    expect(captured).toHaveLength(0)
  })

  it('黑名单窗口：不拍', async () => {
    const { source, captured } = build({ blacklisted: true })
    expect(await source(request(1))).toBeNull()
    expect(captured).toHaveLength(0)
  })

  it('没有前台窗口（锁屏过渡）：不拍', async () => {
    const { source, captured } = build({ window: null })
    expect(await source(request(1))).toBeNull()
    expect(captured).toHaveLength(0)
  })

  it('段行不存在：不拍，也不去抓帧', async () => {
    const { source, captured } = build()
    expect(await source(request(1, { segmentId: 9_999 }))).toBeNull()
    expect(captured).toHaveLength(0)
  })

  it('抓帧失败：返回 null 不抛错（记录器计入 dropped）', async () => {
    const { source } = build({
      capture: async () => {
        throw new Error('屏幕流断了')
      }
    })
    await expect(source(request(1))).resolves.toBeNull()
  })

  it('抓帧期间前台换了：丢掉这一帧（拍到的会是别人的画面）', async () => {
    const fs = fakeFs()
    // 第一次（抓帧前）对得上，第二次（抓帧后）已经是别的窗口
    const { source } = build({
      windows: [WINDOW, { ...WINDOW, hwnd: 12_345, pid: 999 }],
      fs
    })

    expect(await source(request(1))).toBeNull()
    // 没搬进证据目录，临时帧被删掉
    expect(fs.moves).toHaveLength(0)
    expect(fs.removed).toEqual([`C:/userData/tmp-chain/frame-${at(1)}.png`])
  })

  it('抓帧期间读不到前台窗口（锁屏 / 切桌面）：同样丢掉', async () => {
    const fs = fakeFs()
    const { source } = build({ windows: [WINDOW, null], fs })
    expect(await source(request(1))).toBeNull()
    expect(fs.moves).toHaveLength(0)
    expect(fs.removed).toHaveLength(1)
  })

  it('抓帧前后都对得上：正常落证据目录', async () => {
    const fs = fakeFs()
    const { source } = build({ windows: [WINDOW, WINDOW], fs })
    const result = await source(request(1))
    expect(result?.shot.path).toBe(join('C:/userData/chain-shots', chainShotFileName(request(1))))
    expect(fs.removed).toHaveLength(0)
  })

  it('两次抓帧串行：屏幕流不会同时被要两帧', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { source } = build({
      capture: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { imagePath: 'C:/userData/tmp-chain/frame.png', width: 10, height: 10 }
      }
    })
    await Promise.all([source(request(1)), source(request(2))])
    expect(maxInFlight).toBe(1)
  })
})

describe('sameWindow', () => {
  it('两边都有 hwnd 就比 hwnd', () => {
    expect(sameWindow({ pid: 1, hwnd: 10 }, { ...WINDOW, hwnd: 10, pid: 999 })).toBe(true)
    expect(sameWindow({ pid: 1, hwnd: 10 }, { ...WINDOW, hwnd: 11 })).toBe(false)
  })

  it('缺 hwnd 才退回比 pid；两边都缺一律不算对上', () => {
    expect(sameWindow({ pid: 4242, hwnd: null }, WINDOW)).toBe(true)
    expect(sameWindow({ pid: 1, hwnd: null }, WINDOW)).toBe(false)
    expect(sameWindow({ pid: null, hwnd: null }, WINDOW)).toBe(false)
  })
})
