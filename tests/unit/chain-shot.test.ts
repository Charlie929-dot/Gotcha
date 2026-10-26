import Database from 'better-sqlite3'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureChainSchema } from '../../src/chain/schema'
import { openSegment, type ChainDb } from '../../src/chain/store'
import type { ShotRequest } from '../../src/chain/recorder'
import {
  chainShotFileName,
  createChainShotSource,
  EVIDENCE_CAPTURE_OPTIONS,
  sameWindow,
  SLOW_SHOT_MS,
  type ChainShotCaptureOptions,
  type ChainShotCommitted,
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
  capture?: () => Promise<{ imagePath: string; width: number; height: number; ocrPath?: string }>
  fs?: ChainShotFs
  committed?: ChainShotCommitted[]
  onShot?: (committed: ChainShotCommitted) => void
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  now?: () => number
} = {}) {
  const captured: Array<{
    bounds: unknown
    tempDir: string
    ts: number
    options?: ChainShotCaptureOptions
  }> = []
  const sequence = overrides.windows ?? null
  let step = 0
  const source = createChainShotSource({
    db,
    shotsDir: 'C:/userData/chain-shots',
    tempDir: 'C:/userData/tmp-chain',
    screen: {
      capture: async (bounds, tempDir, ts, options) => {
        captured.push({ bounds, tempDir, ts, options })
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
    log: overrides.log,
    now: overrides.now,
    onShot: overrides.onShot ?? (overrides.committed ? (committed) => overrides.committed!.push(committed) : undefined),
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
    // 证据图走「不放大 + JPEG + 附带 OCR 副图」的口径，不复制 OCR 那条 2× 主图路径
    expect(captured[0].options).toEqual(EVIDENCE_CAPTURE_OPTIONS)
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

  it('单张从抓帧到落盘超过 300ms 记一条 warn（回看采集是否拖慢机器）', async () => {
    const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = []
    let clock = 1_000
    const { source } = build({
      log: (level, msg, data) => logs.push({ level, msg, data }),
      now: () => clock,
      capture: async () => {
        clock += SLOW_SHOT_MS + 50
        return { imagePath: `C:/userData/tmp-chain/frame-${at(1)}.png`, width: 1_920, height: 1_080 }
      }
    })

    expect((await source(request(1)))?.shot.width).toBe(1_920)
    const slow = logs.filter((entry) => entry.msg === 'chain shot slow')
    expect(slow).toHaveLength(1)
    expect(slow[0].level).toBe('warn')
    expect(slow[0].data).toMatchObject({ segmentId, eventId: 7, ms: SLOW_SHOT_MS + 50 })
  })

  it('正常速度不记慢日志（日志只在超阈值时出现，不刷屏）', async () => {
    const logs: Array<{ level: string; msg: string }> = []
    let clock = 5_000
    const { source } = build({
      log: (level, msg) => logs.push({ level, msg }),
      now: () => clock,
      capture: async () => {
        clock += 40
        return { imagePath: `C:/userData/tmp-chain/frame-${at(1)}.png`, width: 1_000, height: 800 }
      }
    })

    await source(request(1))
    expect(logs.filter((entry) => entry.msg === 'chain shot slow')).toHaveLength(0)
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

describe('证据落定后的旁路（内容来源 D43）', () => {
  it('落进证据目录后回调一次：带上段 / 事件 / 句柄 / 落定的图', async () => {
    const committed: ChainShotCommitted[] = []
    const { source } = build({ committed })

    await source(request(3))

    const expectedPath = join('C:/userData/chain-shots', chainShotFileName(request(3)))
    expect(committed).toEqual([
      {
        segmentId,
        eventId: 7,
        at: at(3),
        hwnd: WINDOW.hwnd,
        executable: WINDOW.executable,
        framePath: expectedPath
      }
    ])
  })

  it('没拍成的不回调（身份不对 / 黑名单 / 抓帧失败都一样）', async () => {
    const committed: ChainShotCommitted[] = []
    const { source: changed } = build({ windows: [WINDOW, { ...WINDOW, hwnd: 12_345 }], committed })
    expect(await changed(request(1))).toBeNull()

    const { source: blocked } = build({ blacklisted: true, committed })
    expect(await blocked(request(1))).toBeNull()

    const { source: broken } = build({
      committed,
      capture: async () => {
        throw new Error('屏幕流断了')
      }
    })
    expect(await broken(request(1))).toBeNull()

    expect(committed).toHaveLength(0)
  })

  it('旁路抛错不影响这张证据算数（内容坏了不该毁掉截图）', async () => {
    const { source } = build({
      onShot: () => {
        throw new Error('内容车道挂了')
      }
    })
    const result = await source(request(1))
    expect(result?.shot.path).toBe(join('C:/userData/chain-shots', chainShotFileName(request(1))))
  })
})

describe('证据图落盘口径（v0.11：渲染端直接出 JPEG）', () => {
  it('口径是平铺字段（曾经写成嵌套 target，tsc 放行、真机继续按 2× 放大）', () => {
    expect(EVIDENCE_CAPTURE_OPTIONS).toEqual({
      upscale: 1,
      maxWidth: 1_920,
      format: 'jpeg',
      withOcrImage: true
    })
  })

  it('屏幕流给的是 JPEG：落盘就是 .jpg，主进程不做解码 / 重编码', async () => {
    const fs = fakeFs(4_321)
    const jpgPath = `C:/userData/tmp-chain/frame-${at(1)}.jpg`
    const result = await build({
      fs,
      capture: async () => ({ imagePath: jpgPath, width: 1_920, height: 1_021 })
    }).source(request(1))

    const expectedPath = join('C:/userData/chain-shots', chainShotFileName(request(1), 'jpg'))
    expect(result?.shot).toEqual({ path: expectedPath, width: 1_920, height: 1_021, bytes: 4_321 })
    expect(fs.moves).toEqual([[jpgPath, expectedPath]])
    expect(fs.removed).toEqual([])
  })

  it('屏幕流给 PNG（降级路径）：落盘仍是 .png', async () => {
    const fs = fakeFs()
    const result = await build({ fs }).source(request(1))
    expect(result?.shot.path).toBe(join('C:/userData/chain-shots', chainShotFileName(request(1))))
    expect(result?.shot.path?.endsWith('.png')).toBe(true)
  })

  it('OCR 副图路径透传给内容车道（读完由车道删，不在抓帧里删）', async () => {
    const committed: ChainShotCommitted[] = []
    const ocrPath = `C:/userData/tmp-chain/ocr-${at(1)}.png`
    const fs = fakeFs()
    const result = await build({
      fs,
      committed,
      capture: async () => ({
        imagePath: `C:/userData/tmp-chain/frame-${at(1)}.jpg`,
        width: 1_920,
        height: 1_021,
        ocrPath
      })
    }).source(request(1))

    expect(committed[0].ocrPath).toBe(ocrPath)
    expect(committed[0].framePath).toBe(result?.shot.path)
    // 抓帧不删副图（内容车道还没读），只搬走证据图
    expect(fs.removed).toEqual([])
  })

  it('丢掉那一帧：OCR 副图一起删，不留孤儿临时文件', async () => {
    const fs = fakeFs()
    const jpgPath = `C:/userData/tmp-chain/frame-${at(1)}.jpg`
    const ocrPath = `C:/userData/tmp-chain/ocr-${at(1)}.png`
    const { source } = build({
      fs,
      windows: [WINDOW, { ...WINDOW, hwnd: 12_345, pid: 999 }],
      capture: async () => ({ imagePath: jpgPath, width: 1_920, height: 1_021, ocrPath })
    })

    expect(await source(request(1))).toBeNull()
    expect(fs.removed).toEqual([jpgPath, ocrPath])
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
