import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/db'
import type { CapturePipeline } from '../../src/capture/pipeline'
import { zeroStats } from '../../src/capture/stats'
import {
  CaptureController,
  CaptureDbConnections,
  createCaptureSession,
  type CaptureSession,
  type CaptureSessionDeps,
  type CaptureStatus,
  type CaptureStream
} from '../../src/main/capture-controller'

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface FakeSession {
  session: CaptureSession
  calls: string[]
  halt: ReturnType<typeof vi.fn>
  stopTimers: ReturnType<typeof vi.fn>
  flushStats: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  disposeScreenStream: ReturnType<typeof vi.fn>
  disposeOcr: ReturnType<typeof vi.fn>
}

function makeFakeSession(): FakeSession {
  const calls: string[] = []
  const halt = vi.fn(() => {
    calls.push('halt')
  })
  const flush = vi.fn(async () => {
    calls.push('flush')
  })
  const stopTimers = vi.fn(() => {
    calls.push('stopTimers')
  })
  const flushStats = vi.fn(() => {
    calls.push('flushStats')
  })
  const disposeScreenStream = vi.fn(async () => {
    calls.push('disposeScreenStream')
  })
  const disposeOcr = vi.fn(async () => {
    calls.push('disposeOcr')
  })
  return {
    calls,
    halt,
    stopTimers,
    flushStats,
    flush,
    disposeScreenStream,
    disposeOcr,
    session: {
      pipeline: {
        halt,
        flush,
        getStats: () => zeroStats(),
        resetStats: () => {}
      } as unknown as CapturePipeline,
      stopTimers,
      flushStats,
      disposeScreenStream,
      disposeOcr
    }
  }
}

describe('CaptureController · 状态机', () => {
  it('start 幂等：同向重复调用返回同一个在途 Promise，只建一个会话', async () => {
    const fake = makeFakeSession()
    const createSession = vi.fn(async () => fake.session)
    const controller = new CaptureController({ createSession })

    const first = controller.start()
    const second = controller.start()

    expect(second).toBe(first)
    await first
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(controller.status()).toBe('running')
  })

  it('stop 幂等：同向重复调用只释放一次', async () => {
    const fake = makeFakeSession()
    const controller = new CaptureController({ createSession: async () => fake.session })
    await controller.start()

    const first = controller.stop()
    const second = controller.stop()

    expect(second).toBe(first)
    await first
    expect(controller.status()).toBe('paused')
    expect(fake.halt).toHaveBeenCalledTimes(1)
    expect(fake.stopTimers).toHaveBeenCalledTimes(1)
    expect(fake.disposeScreenStream).toHaveBeenCalledTimes(1)
    expect(fake.disposeOcr).toHaveBeenCalledTimes(1)
    expect(fake.flushStats).toHaveBeenCalledTimes(1)
  })

  it('并发 start + stop 串行：stop 等 start 落定后才执行，终态 paused', async () => {
    const fake = makeFakeSession()
    let resolveCreate!: (value: CaptureSession) => void
    const createSession = vi.fn(
      () =>
        new Promise<CaptureSession>((resolve) => {
          resolveCreate = resolve
        })
    )
    const changes: CaptureStatus[] = []
    const controller = new CaptureController({
      createSession,
      onStatusChange: (status) => changes.push(status)
    })

    const startPromise = controller.start()
    const stopPromise = controller.stop()
    await nextTask()
    expect(controller.status()).toBe('starting')
    expect(fake.calls).toEqual([])

    resolveCreate(fake.session)
    await startPromise
    await stopPromise

    expect(fake.calls).toEqual([
      'halt',
      'stopTimers',
      'disposeScreenStream',
      'disposeOcr',
      'flush',
      'flushStats'
    ])
    expect(controller.status()).toBe('paused')
    expect(changes).toEqual(['starting', 'running', 'stopping', 'paused'])
  })

  it('stop 先取消 OCR 再 flush：仍在等 OCR 启动时也不会无限等待（F07）', async () => {
    let releaseFlush: (() => void) | null = null
    let ocrDisposed = false
    const calls: string[] = []
    const session = {
      pipeline: {
        halt: () => {
          calls.push('halt')
        },
        flush: () =>
          new Promise<void>((resolve) => {
            calls.push('flush')
            if (ocrDisposed) resolve()
            else releaseFlush = resolve
          }),
        getStats: () => zeroStats(),
        resetStats: () => {}
      } as unknown as CapturePipeline,
      stopTimers: () => {},
      flushStats: () => {},
      disposeScreenStream: async () => {},
      disposeOcr: async () => {
        ocrDisposed = true
        calls.push('disposeOcr')
      }
    } as unknown as CaptureSession
    const controller = new CaptureController({ createSession: async () => session })

    await controller.start()
    await controller.stop()

    // 旧顺序（flush 在 disposeOcr 之前）会在这里一直等下去
    expect(calls).toEqual(['halt', 'disposeOcr', 'flush'])
    expect(releaseFlush).toBeNull()
    expect(controller.status()).toBe('paused')
  })

  it('start 失败：状态回落 paused、记录错因、后续可重试', async () => {
    const fake = makeFakeSession()
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('no display'))
      .mockResolvedValueOnce(fake.session)
    const log = vi.fn()
    const controller = new CaptureController({ createSession, log })

    await expect(controller.start()).rejects.toThrow('no display')
    expect(controller.status()).toBe('paused')
    expect(log).toHaveBeenCalledWith('error', 'capture start failed', {
      error: expect.stringContaining('no display')
    })

    await controller.start()
    expect(controller.status()).toBe('running')
  })

  it('toggle：paused → start、running → stop；starting 期间 toggle 排队为 stop', async () => {
    const fake = makeFakeSession()
    let resolveCreate!: (value: CaptureSession) => void
    const createSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<CaptureSession>((resolve) => {
            resolveCreate = resolve
          })
      )
      .mockResolvedValue(fake.session)
    const controller = new CaptureController({ createSession })

    const first = controller.toggle()
    await nextTask()
    expect(controller.status()).toBe('starting')
    const second = controller.toggle()
    resolveCreate(fake.session)
    await first
    await second
    expect(controller.status()).toBe('paused')

    await controller.toggle()
    expect(controller.status()).toBe('running')
    await controller.toggle()
    expect(controller.status()).toBe('paused')
  })
})

describe('createCaptureSession · 装配与失败回滚', () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-session-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function fakeStream(overrides: Partial<CaptureStream> = {}): CaptureStream {
    return {
      start: vi.fn(async () => {}),
      capture: vi.fn(async () => {
        throw new Error('not used')
      }),
      dispose: vi.fn(),
      ...overrides
    }
  }

  function baseDeps(db: Db, overrides: Partial<CaptureSessionDeps> = {}): CaptureSessionDeps {
    return {
      userDataDir: makeTempDir(),
      captureHtmlPath: 'capture.html',
      now: () => new Date(2026, 9, 22, 12, 0, 0).getTime(),
      ensureWriteDb: () => ({ db, openedThisTime: true }),
      releaseWriteDb: vi.fn(),
      createScreenStream: () => fakeStream(),
      createOcr: () => ({ recognize: vi.fn(), dispose: vi.fn(async () => {}) }),
      getActiveWindow: vi.fn(async () => null),
      isBlacklisted: () => false,
      log: vi.fn(),
      createScheduler: vi.fn(() => ({ stop: vi.fn() })),
      setFlushTimer: vi.fn(() => 'timer'),
      clearFlushTimer: vi.fn(),
      ...overrides
    }
  }

  it('屏幕流启动失败：dispose 流、释放本次新开写连接、记录错因并抛出', async () => {
    const db = openDatabase(':memory:')
    try {
      const stream = fakeStream({
        start: vi.fn(async () => {
          throw new Error('no display')
        })
      })
      const releaseWriteDb = vi.fn()
      const createOcr = vi.fn()
      const log = vi.fn()
      const deps = baseDeps(db, { createScreenStream: () => stream, createOcr, releaseWriteDb, log })

      await expect(createCaptureSession(deps)).rejects.toThrow('no display')

      expect(stream.dispose).toHaveBeenCalledTimes(1)
      expect(releaseWriteDb).toHaveBeenCalledWith(true)
      expect(createOcr).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(
        'error',
        'capture session create failed',
        expect.objectContaining({ error: expect.stringContaining('no display') })
      )
    } finally {
      db.close()
    }
  })

  it('OCR 创建失败：已起的屏幕流被回收、写连接释放', async () => {
    const db = openDatabase(':memory:')
    try {
      const stream = fakeStream()
      const releaseWriteDb = vi.fn()
      const deps = baseDeps(db, {
        createScreenStream: () => stream,
        createOcr: () => {
          throw new Error('ocr unavailable')
        },
        releaseWriteDb
      })

      await expect(createCaptureSession(deps)).rejects.toThrow('ocr unavailable')
      expect(stream.dispose).toHaveBeenCalledTimes(1)
      expect(releaseWriteDb).toHaveBeenCalledWith(true)
    } finally {
      db.close()
    }
  })

  it('装配成功：调度与每日落盘接线；stopTimers 停表；flush 写 settings', async () => {
    const db = openDatabase(':memory:')
    try {
      const stream = fakeStream()
      const ocr = {
        recognize: vi.fn(async () => ({ text: 'x', ms: 1 })),
        dispose: vi.fn(async () => {})
      }
      const schedulerStop = vi.fn()
      const createScheduler = vi.fn(() => ({ stop: schedulerStop }))
      const setFlushTimer = vi.fn(() => 'timer')
      const clearFlushTimer = vi.fn()
      const log = vi.fn()
      const deps = baseDeps(db, {
        createScreenStream: () => stream,
        createOcr: () => ocr,
        log,
        createScheduler,
        setFlushTimer,
        clearFlushTimer
      })

      const session = await createCaptureSession(deps)

      expect(createScheduler).toHaveBeenCalledTimes(1)
      expect(setFlushTimer).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith('info', expect.stringContaining('started schema=v1'))

      session.flushStats()
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('stats.day.2026-10-22') as { value: string } | undefined
      expect(row).toBeDefined()
      expect(JSON.parse(row!.value)).toMatchObject({ frames_total: 0, ocr_runs: 0 })

      session.stopTimers()
      expect(schedulerStop).toHaveBeenCalledTimes(1)
      expect(clearFlushTimer).toHaveBeenCalledWith('timer')

      await session.disposeOcr()
      expect(ocr.dispose).toHaveBeenCalledTimes(1)
      await session.disposeScreenStream()
      expect(stream.dispose).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
  })
})

describe('CaptureDbConnections · 只读 / 写连接生命周期', () => {
  it('先只读浏览再开启采集：先关只读再开写，查询切到写连接', () => {
    const readonly = { close: vi.fn() }
    const writable = { close: vi.fn() }
    const order: string[] = []
    let readCalls = 0
    const connections = new CaptureDbConnections({
      dbPath: 'memory.db',
      fileExists: () => true,
      openReadonly: () => {
        readCalls++
        order.push('readonly')
        return readonly as unknown as Db
      },
      openWritable: () => {
        order.push('writable')
        return writable as unknown as Db
      }
    })

    expect(connections.queryDb()).toBe(readonly)
    expect(connections.queryDb()).toBe(readonly)
    expect(readCalls).toBe(1)

    const ensured = connections.ensureWritable()
    expect(ensured.db).toBe(writable)
    expect(ensured.openedThisTime).toBe(true)
    expect(readonly.close).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['readonly', 'writable'])
    expect(connections.queryDb()).toBe(writable)

    const reused = connections.ensureWritable()
    expect(reused.db).toBe(writable)
    expect(reused.openedThisTime).toBe(false)
    expect(order).toEqual(['readonly', 'writable'])
  })

  it('库文件不存在时只读连接返回 null（不建库，A3）', () => {
    const openReadonly = vi.fn(() => ({ close: vi.fn() }) as unknown as Db)
    const openWritable = vi.fn(() => ({ close: vi.fn() }) as unknown as Db)
    const connections = new CaptureDbConnections({
      dbPath: 'x',
      fileExists: () => false,
      openReadonly,
      openWritable
    })
    expect(connections.queryDb()).toBeNull()
    expect(openReadonly).not.toHaveBeenCalled()
    expect(openWritable).not.toHaveBeenCalled()
  })

  it('启动失败只释放本次新开的写连接；复用中的连接不动', () => {
    const writable = { close: vi.fn() }
    let opens = 0
    const connections = new CaptureDbConnections({
      dbPath: 'x',
      fileExists: () => false,
      openReadonly: () => ({ close: vi.fn() }) as unknown as Db,
      openWritable: () => {
        opens++
        return writable as unknown as Db
      }
    })

    const first = connections.ensureWritable()
    expect(first.openedThisTime).toBe(true)

    connections.releaseWritableIfNew(false)
    expect(writable.close).not.toHaveBeenCalled()

    connections.releaseWritableIfNew(true)
    expect(writable.close).toHaveBeenCalledTimes(1)

    const again = connections.ensureWritable()
    expect(again.openedThisTime).toBe(true)
    expect(opens).toBe(2)
  })

  it('closeAll 同时关闭只读与写连接', () => {
    const readonly = { close: vi.fn() }
    const writable = { close: vi.fn() }
    const connections = new CaptureDbConnections({
      dbPath: 'x',
      fileExists: () => true,
      openReadonly: () => readonly as unknown as Db,
      openWritable: () => writable as unknown as Db
    })

    connections.queryDb()
    connections.ensureWritable()
    connections.closeAll()

    expect(readonly.close).toHaveBeenCalledTimes(1)
    expect(writable.close).toHaveBeenCalledTimes(1)
  })
})
