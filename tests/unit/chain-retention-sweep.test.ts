import Database from 'better-sqlite3'
import { dirname, join, basename } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildArchive, extractArchiveEntry } from '../../src/chain/archive'
import { containerName, type RetentionEncoding, type RetentionParams } from '../../src/chain/retention'
import { ensureChainSchema } from '../../src/chain/schema'
import {
  closeSegment,
  dayKeyOf,
  insertEvent,
  insertShot,
  listShots,
  openSegment,
  type ChainDb
} from '../../src/chain/store'
import {
  createChainRetention,
  type ImageEncoder,
  type RetentionFs
} from '../../src/main/chain-retention'

/** 本地 2026-10-26 12:00 */
const NOW = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const DAY = 86_400_000
const SHOTS_DIR = 'C:/userData/chain-shots'

/** 编码结果是输入的确定函数：断言解出来的字节就是它 */
function encodedBytes(inputLength: number, encoding: RetentionEncoding): Buffer {
  return Buffer.from(`J${encoding.quality}:${encoding.maxWidth ?? 'native'}:${inputLength}`)
}

const encode: ImageEncoder = (input, encoding) => ({
  bytes: encodedBytes(input.length, encoding),
  width: encoding.maxWidth ?? 3840,
  height: 2042
})

/** 内存 fs：路径与大小都记在 Map 里，断言「写了什么、删了什么」 */
function memoryFs(initial: Record<string, Buffer> = {}): RetentionFs & { files: Map<string, Buffer> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readFileSync: (path) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT: ${path}`)
      return bytes
    },
    writeFileSync: (path, data) => {
      files.set(path, data)
    },
    renameSync: (from, to) => {
      const bytes = files.get(from)
      if (!bytes) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, bytes)
    },
    unlinkSync: (path) => {
      if (!files.delete(path)) throw new Error(`ENOENT: ${path}`)
    },
    mkdirSync: () => {},
    existsSync: (path) => files.has(path),
    statSync: (path) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT: ${path}`)
      return { size: bytes.length }
    },
    readdirSync: (path) => [...files.keys()].filter((key) => dirname(key) === path).map((key) => basename(key))
  }
}

let db: ChainDb
let sequence = 0

function addShot(options: {
  ts: number
  tier: 'hot' | 'warm' | 'cold' | 'archive'
  path: string | null
  container?: string | null
  bytes?: number
}): { shotId: number; segmentId: number } {
  sequence += 1
  const segmentId = openSegment(
    db,
    { startTs: options.ts, pid: 1000 + sequence, hwnd: 2000 + sequence, exe: 'app.exe', app: 'App', title: '窗口' },
    options.ts
  )
  const eventId = insertEvent(db, { segmentId, ts: options.ts, kind: 'enter' })
  closeSegment(db, segmentId, {
    startTs: options.ts,
    endTs: options.ts + 5_000,
    activeMs: 5_000,
    idleMs: 0,
    pid: 1000 + sequence,
    exe: 'app.exe',
    app: 'App',
    hwnd: 2000 + sequence,
    titleFirst: '窗口',
    titleLast: '窗口'
  })
  const shotId = insertShot(db, {
    segmentId,
    eventId,
    ts: options.ts,
    path: options.path,
    container: options.container ?? null,
    width: 3840,
    height: 2042,
    bytes: options.bytes ?? 1_000_000,
    source: 'enter',
    tier: options.tier
  })
  return { shotId, segmentId }
}

function shotPath(n: number, ts: number, ext = 'jpg'): string {
  return join(SHOTS_DIR, dayKeyOf(ts), `shot-${n}.${ext}`)
}

function build(options: { fs: RetentionFs; params?: RetentionParams; encode?: ImageEncoder; maxPerRun?: number }) {
  return createChainRetention({
    db,
    shotsDir: SHOTS_DIR,
    encode: options.encode ?? encode,
    params: options.params,
    fs: options.fs,
    now: () => NOW,
    intervalMs: 0,
    maxPerRun: options.maxPerRun,
    log: () => {}
  })
}

function singleShot(segmentId: number) {
  const shots = listShots(db, segmentId)
  expect(shots).toHaveLength(1)
  return shots[0]
}

beforeEach(() => {
  db = new Database(':memory:')
  ensureChainSchema(db)
})

afterEach(() => {
  db.close()
})

describe('保留期扫描', () => {
  it('hot → warm：就地重编码，路径不变、字节与宽高按 warm 参数更新', async () => {
    const ts = NOW - 10 * DAY
    const path = shotPath(1, ts)
    const { segmentId } = addShot({ ts, tier: 'hot', path, bytes: 100 })
    const fs = memoryFs({ [path]: Buffer.from('x'.repeat(100)) })
    const runner = build({ fs })

    const stats = await runner.run()

    expect(stats).toMatchObject({ scanned: 1, encoded: 1, packed: 0, failed: 0, bytesBefore: 100 })
    const shot = singleShot(segmentId)
    expect(shot.tier).toBe('warm')
    expect(shot.path).toBe(path)
    expect(shot.container).toBeNull()
    expect((shot.bytes ?? 0)).toBe(encodedBytes(100, { maxWidth: 1920, quality: 85 }).length)
    expect(fs.files.get(path)?.equals(encodedBytes(100, { maxWidth: 1920, quality: 85 }))).toBe(true)
  })

  it('warm → cold：重编码 + 打进当天容器，原文件删掉、行里 path 置空', async () => {
    const ts = NOW - 40 * DAY
    const path = shotPath(2, ts)
    const { segmentId, shotId } = addShot({ ts, tier: 'warm', path, bytes: 200 })
    const fs = memoryFs({ [path]: Buffer.from('y'.repeat(200)) })
    const runner = build({ fs })

    const stats = await runner.run()

    expect(stats).toMatchObject({ encoded: 0, packed: 1, failed: 0, containers: 1 })
    const shot = singleShot(segmentId)
    const container = join(SHOTS_DIR, 'archive', containerName(dayKeyOf(ts), 'cold'))
    expect(shot.tier).toBe('cold')
    expect(shot.path).toBeNull()
    expect(shot.container).toBe(container)
    expect(fs.files.has(path)).toBe(false)
    const extracted = extractArchiveEntry(fs.files.get(container)!, shotId)
    expect(extracted?.bytes.equals(encodedBytes(200, { maxWidth: 1440, quality: 80 }))).toBe(true)
  })

  it('半年前：进 archive 容器（更小的一档）', async () => {
    const ts = NOW - 200 * DAY
    const path = shotPath(3, ts)
    const { segmentId, shotId } = addShot({ ts, tier: 'cold', path, bytes: 300 })
    const fs = memoryFs({ [path]: Buffer.from('z'.repeat(300)) })
    const runner = build({ fs })

    await runner.run()

    const shot = singleShot(segmentId)
    const container = join(SHOTS_DIR, 'archive', containerName(dayKeyOf(ts), 'archive'))
    expect(shot.tier).toBe('archive')
    expect(shot.container).toBe(container)
    expect(extractArchiveEntry(fs.files.get(container)!, shotId)?.bytes.equals(encodedBytes(300, { maxWidth: 1280, quality: 75 }))).toBe(true)
  })

  it('采集编码改 JPEG 之前的老行（hot + PNG）：归一化成 hot JPEG，老 PNG 删掉', async () => {
    const ts = NOW - 1 * DAY
    const png = shotPath(4, ts, 'png')
    const jpg = shotPath(4, ts, 'jpg')
    const { segmentId } = addShot({ ts, tier: 'hot', path: png, bytes: 50 })
    const fs = memoryFs({ [png]: Buffer.from('p'.repeat(50)) })

    await build({ fs }).run()

    const shot = singleShot(segmentId)
    expect(shot.tier).toBe('hot')
    expect(shot.path).toBe(jpg)
    expect(fs.files.has(png)).toBe(false)
    expect(fs.files.get(jpg)?.equals(encodedBytes(50, { maxWidth: null, quality: 85 }))).toBe(true)
  })

  it('幂等：第二遍什么都不做（不会二次压缩）', async () => {
    const ts = NOW - 40 * DAY
    const path = shotPath(5, ts)
    addShot({ ts, tier: 'warm', path, bytes: 100 })
    const fs = memoryFs({ [path]: Buffer.from('q'.repeat(100)) })
    const runner = build({ fs })

    await runner.run()
    const second = await runner.run()

    expect(second.encoded).toBe(0)
    expect(second.packed).toBe(0)
    expect(second.skipped).toBeGreaterThan(0)
  })

  it('重编码失败：只记 failed，行和文件都不动（宁可还是旧层，不写半截状态）', async () => {
    const ts = NOW - 10 * DAY
    const path = shotPath(6, ts)
    const { segmentId } = addShot({ ts, tier: 'hot', path, bytes: 77 })
    const fs = memoryFs({ [path]: Buffer.from('w'.repeat(77)) })
    const broken: ImageEncoder = () => {
      throw new Error('解码失败')
    }

    const stats = await build({ fs, encode: broken }).run()

    expect(stats.failed).toBe(1)
    const shot = singleShot(segmentId)
    expect(shot.tier).toBe('hot')
    expect(shot.path).toBe(path)
    expect(fs.files.get(path)?.length).toBe(77)
  })

  it('cold → archive：旧容器里已经 archive 的行原样带上，旧 cold 容器删掉', async () => {
    // 自定义时间窗：hot 1 天 / warm 2 天 / cold 3 天，两行落在同一天。
    // 今天 12:00 往前 3 天 = 那天 12:00：00:00–11:59 的画面已到 archive，
    // 12:00 之后还是 cold —— 这正是「跨层边界落在同一天」的现场。
    const params: RetentionParams = {
      hotDays: 1,
      warmDays: 2,
      coldDays: 3,
      hot: { maxWidth: null, quality: 85 },
      warm: { maxWidth: 1920, quality: 85 },
      cold: { maxWidth: 1440, quality: 80 },
      archive: { maxWidth: 1280, quality: 75 }
    }
    const archiveTs = NOW - 3.4 * DAY
    const coldTs = NOW - 3.01 * DAY
    expect(dayKeyOf(archiveTs)).toBe(dayKeyOf(coldTs))

    const day = dayKeyOf(archiveTs)
    const archiveContainer = join(SHOTS_DIR, 'archive', containerName(day, 'archive'))
    const coldContainer = join(SHOTS_DIR, 'archive', containerName(day, 'cold'))
    const archiveBytes = Buffer.from('archive-old')
    const coldBytes = Buffer.from('cold-old')

    // 先插老的那行（段不能重叠），已经升到 archive 的
    const older = addShot({ ts: archiveTs, tier: 'archive', path: null, container: archiveContainer })
    const newer = addShot({ ts: coldTs, tier: 'cold', path: null, container: coldContainer })

    const fs = memoryFs({
      [archiveContainer]: buildArchive([
        { shotId: older.shotId, bytes: archiveBytes, width: 1280, height: 681 }
      ]),
      [coldContainer]: buildArchive([
        { shotId: newer.shotId, bytes: coldBytes, width: 1440, height: 766 }
      ])
    })

    await build({ fs, params }).run()

    // 已经 archive 的那行：字节原样带过去，不二次压缩
    expect(extractArchiveEntry(fs.files.get(archiveContainer)!, older.shotId)?.bytes.equals(archiveBytes)).toBe(true)
    // 原来 cold 的那行：按 archive 参数重编码
    expect(
      extractArchiveEntry(fs.files.get(archiveContainer)!, newer.shotId)?.bytes.equals(
        encodedBytes(coldBytes.length, { maxWidth: 1280, quality: 75 })
      )
    ).toBe(true)
    expect(fs.files.has(coldContainer)).toBe(false)
    expect(singleShot(older.segmentId).tier).toBe('archive')
    expect(singleShot(newer.segmentId).tier).toBe('archive')
    expect(singleShot(newer.segmentId).container).toBe(archiveContainer)
  })

  it('上次崩溃留下的半截容器（.tmp）在扫描时清掉', async () => {
    const ts = NOW - 40 * DAY
    const path = shotPath(7, ts)
    addShot({ ts, tier: 'warm', path, bytes: 10 })
    const leftover = join(SHOTS_DIR, 'archive', '2026-01-01-cold.cgar.tmp')
    const fs = memoryFs({ [path]: Buffer.from('v'.repeat(10)), [leftover]: Buffer.from('half') })

    await build({ fs }).run()

    expect(fs.files.has(leftover)).toBe(false)
  })

  it('单次上限：超过 maxPerRun 的留到下一轮，且不会卡住', async () => {
    const first = NOW - 40 * DAY
    const second = NOW - 39 * DAY
    const firstPath = shotPath(8, first)
    const secondPath = shotPath(9, second)
    addShot({ ts: first, tier: 'warm', path: firstPath, bytes: 10 })
    addShot({ ts: second, tier: 'warm', path: secondPath, bytes: 10 })
    const fs = memoryFs({
      [firstPath]: Buffer.from('a'.repeat(10)),
      [secondPath]: Buffer.from('b'.repeat(10))
    })
    const runner = build({ fs, maxPerRun: 1 })

    const one = await runner.run()
    expect(one.packed).toBe(1)

    const two = await runner.run()
    expect(two.packed).toBe(1)

    const three = await runner.run()
    expect(three.packed).toBe(0)
  })
})
