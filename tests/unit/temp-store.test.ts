import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHAIN_FRAME_FILE_PATTERN,
  cleanStaleFrames,
  createTempJanitor,
  FRAME_FILE_PATTERN,
  OCR_FILE_PATTERN
} from '../../src/capture/temp-store'

describe('cleanStaleFrames · 启动清理临时帧（F06）', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-tmp-'))
    dirs.push(dir)
    return dir
  }

  it('只删本应用的 frame-<ts>.png，目录里其它文件一律不动', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'frame-1698000000000.png'), 'x')
    writeFileSync(join(dir, 'frame-1698000000001.png'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'keep')
    writeFileSync(join(dir, 'frame-abc.png'), 'keep')

    expect(cleanStaleFrames(dir)).toEqual({ removed: 2, failed: 0 })
    expect(existsSync(join(dir, 'frame-1698000000000.png'))).toBe(false)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(existsSync(join(dir, 'frame-abc.png'))).toBe(true)
  })

  it('目录不存在时返回 0，不抛错（启动路径不被清理失败中断）', () => {
    const missing = join(tmpdir(), 'gotcha-definitely-missing', 'tmp')
    expect(cleanStaleFrames(missing)).toEqual({ removed: 0, failed: 0 })
  })

  it('文件名白名单不接受任意 png', () => {
    expect(FRAME_FILE_PATTERN.test('frame-1698000000000.png')).toBe(true)
    expect(FRAME_FILE_PATTERN.test('frame-1698000000000.PNG')).toBe(false)
    expect(FRAME_FILE_PATTERN.test('photo.png')).toBe(false)
    expect(FRAME_FILE_PATTERN.test('frame-1.jpg')).toBe(false)
  })

  it('tmp-chain 模式表：ocr-*.png / frame-*.jpg 都算残留，别的文件不动（P0-4）', () => {
    const dir = makeDir()
    for (const name of ['ocr-1698000000000.png', 'frame-1698000000001.jpg', 'keep.txt', 'ocr-abc.png']) {
      writeFileSync(join(dir, name), 'x')
    }
    expect(
      cleanStaleFrames(dir, { patterns: [CHAIN_FRAME_FILE_PATTERN, OCR_FILE_PATTERN] })
    ).toEqual({ removed: 2, failed: 0 })
    expect(existsSync(join(dir, 'ocr-1698000000000.png'))).toBe(false)
    expect(existsSync(join(dir, 'frame-1698000000001.jpg'))).toBe(false)
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true)
    expect(existsSync(join(dir, 'ocr-abc.png'))).toBe(true)
  })

  it('最小年龄：只删老文件，刚写的临时帧留着（启动清理不误删在途帧）', () => {
    const dir = makeDir()
    const now = Date.now()
    const old = new Date(now - 10 * 60 * 60 * 1000)
    writeFileSync(join(dir, 'ocr-1.png'), 'x')
    writeFileSync(join(dir, 'ocr-2.png'), 'x')
    utimesSync(join(dir, 'ocr-1.png'), old, old)

    expect(
      cleanStaleFrames(dir, {
        patterns: [OCR_FILE_PATTERN],
        olderThanMs: 6 * 60 * 60 * 1000,
        now: () => now
      })
    ).toEqual({ removed: 1, failed: 0 })
    expect(existsSync(join(dir, 'ocr-1.png'))).toBe(false)
    expect(existsSync(join(dir, 'ocr-2.png'))).toBe(true)
  })
})

describe('createTempJanitor · 长会话周期清理', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-janitor-'))
    dirs.push(dir)
    return dir
  }

  it('每个目标按自己的年龄阈值删，并汇总数量（ocr 15 分钟 / frame 1 小时）', () => {
    const dir = makeDir()
    const now = Date.now()
    const minutesAgo = (m: number): Date => new Date(now - m * 60_000)
    writeFileSync(join(dir, 'ocr-1698000000000.png'), 'x')
    writeFileSync(join(dir, 'ocr-1698000000001.png'), 'x')
    writeFileSync(join(dir, 'frame-1698000000002.jpg'), 'x')
    utimesSync(join(dir, 'ocr-1698000000000.png'), minutesAgo(20), minutesAgo(20))
    utimesSync(join(dir, 'frame-1698000000002.jpg'), minutesAgo(20), minutesAgo(20))

    const janitor = createTempJanitor({
      now: () => now,
      targets: [
        { dir, patterns: [OCR_FILE_PATTERN], olderThanMs: 15 * 60_000 },
        { dir, patterns: [CHAIN_FRAME_FILE_PATTERN], olderThanMs: 60 * 60_000 }
      ]
    })

    // 20 分钟前的 ocr 该删；同样 20 分钟前的 frame 还没到 1h，留着
    expect(janitor.run()).toEqual({ removed: 1, failed: 0 })
    expect(existsSync(join(dir, 'ocr-1698000000000.png'))).toBe(false)
    expect(existsSync(join(dir, 'ocr-1698000000001.png'))).toBe(true)
    expect(existsSync(join(dir, 'frame-1698000000002.jpg'))).toBe(true)
  })

  it('start 只挂一个定时器，stop 之后不再扫；没事不写日志', () => {
    let scheduled = 0
    let cancelled = 0
    const logs: string[] = []
    const ticks: Array<() => void> = []
    const dir = makeDir()

    const janitor = createTempJanitor({
      targets: [{ dir, patterns: [OCR_FILE_PATTERN], olderThanMs: 15 * 60_000 }],
      intervalMs: 1_000,
      schedule: (fn) => {
        scheduled += 1
        ticks.push(fn)
        return {}
      },
      cancel: () => {
        cancelled += 1
      },
      log: (level, message) => logs.push(`${level}:${message}`)
    })

    janitor.start()
    janitor.start() // 重复 start 不叠加
    expect(scheduled).toBe(1)
    expect(ticks).toHaveLength(1)

    ticks[0]() // 空目录：什么都不删，也不写日志
    expect(logs).toHaveLength(0)

    writeFileSync(join(dir, 'ocr-1.png'), 'x')
    utimesSync(join(dir, 'ocr-1.png'), new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000))
    ticks[0]()
    expect(logs).toEqual(['info:temp frames janitor'])

    janitor.stop()
    janitor.stop()
    expect(cancelled).toBe(1)
  })
})
