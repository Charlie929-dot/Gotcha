import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PowerShellJsonWorker } from '../../src/chain/content/worker'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly written: string[] = []
  readonly kill = vi.fn(() => true)

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => this.written.push(String(chunk)))
  }
}

function makeSpawn(): { spawnImpl: typeof spawn; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawnImpl = vi.fn(() => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  })
  return { spawnImpl: spawnImpl as unknown as typeof spawn, children }
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeWorker(
  spawnImpl: typeof spawn,
  overrides: Partial<ConstructorParameters<typeof PowerShellJsonWorker>[0]> = {}
): PowerShellJsonWorker {
  return new PowerShellJsonWorker({
    scriptPath: 'C:\\fake\\uia-text.ps1',
    spawnImpl,
    startupTimeoutMs: 50,
    requestTimeoutMs: 50,
    restartCooldownMs: 0,
    ...overrides
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PowerShell 行式 JSON 工作器', () => {
  it('ready 后按行协议请求，响应原样交回（ok 由调用方解释）', async () => {
    const { spawnImpl, children } = makeSpawn()
    const worker = makeWorker(spawnImpl)
    try {
      const promise = worker.request({ hwnd: 42 })
      await nextTask()
      const child = children[0]
      child.stdout.write('{"ready":true}\n')
      await nextTask()
      expect(child.written.join('')).toContain('"id":1')
      expect(child.written.join('')).toContain('"hwnd":42')

      child.stdout.write('{"id":1,"ok":true,"chars":3}\n')
      await expect(promise).resolves.toEqual({ id: 1, ok: true, chars: 3 })
    } finally {
      await worker.dispose()
    }
  })

  it('非 JSON / 无 id 的行忽略，不影响后续响应', async () => {
    const { spawnImpl, children } = makeSpawn()
    const worker = makeWorker(spawnImpl)
    try {
      const promise = worker.request({ hwnd: 42 })
      await nextTask()
      const child = children[0]
      child.stdout.write('not json\n')
      child.stdout.write('{"hello":"world"}\n')
      child.stdout.write('{"ready":true}\n')
      await nextTask()
      child.stdout.write('{"id":1,"ok":false,"error":"boom"}\n')
      await expect(promise).resolves.toMatchObject({ ok: false, error: 'boom' })
    } finally {
      await worker.dispose()
    }
  })

  it('请求超时：拒绝在途请求**并杀掉子进程**（UIA 可能永久挂住）', async () => {
    const { spawnImpl, children } = makeSpawn()
    const worker = makeWorker(spawnImpl, { requestTimeoutMs: 10 })
    try {
      const promise = worker.request({ hwnd: 42 })
      await nextTask()
      children[0].stdout.write('{"ready":true}\n')
      await expect(promise).rejects.toThrow('子进程请求超时')
      // 不杀进程的话，卡住的子进程会让后续每次请求都排队等死
      expect(children[0].kill).toHaveBeenCalled()
    } finally {
      await worker.dispose()
    }
  })

  it('超时后的冷却期：不重复 spawn，冷却过后能重新拉起', async () => {
    const { spawnImpl, children } = makeSpawn()
    const worker = makeWorker(spawnImpl, { requestTimeoutMs: 10, restartCooldownMs: 60_000 })
    try {
      const first = worker.request({ hwnd: 42 })
      await nextTask()
      children[0].stdout.write('{"ready":true}\n')
      await expect(first).rejects.toThrow('子进程请求超时')

      await expect(worker.request({ hwnd: 42 })).rejects.toThrow('s 后重试')
      expect(children).toHaveLength(1)
    } finally {
      await worker.dispose()
    }
  })

  it('启动超时：失败并结束子进程，调用方不会永久挂起', async () => {
    const { spawnImpl, children } = makeSpawn()
    const worker = makeWorker(spawnImpl, { startupTimeoutMs: 5 })
    await expect(worker.request({ hwnd: 42 })).rejects.toThrow('子进程启动超时')
    expect(children).toHaveLength(1)
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('ready 后崩溃：在途请求立即失败，冷却后重拉并成功', async () => {
    const { spawnImpl, children } = makeSpawn()
    const worker = makeWorker(spawnImpl)
    try {
      const first = worker.request({ hwnd: 42 })
      await nextTask()
      children[0].stdout.write('{"ready":true}\n')
      await nextTask()
      children[0].emit('exit', 1)
      await expect(first).rejects.toThrow('子进程退出')

      const second = worker.request({ hwnd: 43 })
      await nextTask()
      expect(children).toHaveLength(2)
      children[1].stdout.write('{"ready":true}\n')
      await nextTask()
      // 第一次请求已经写过管道（id 1），崩溃后重拉，序号继续往前走
      expect(children[1].written.join('')).toContain('"id":2')
      children[1].stdout.write('{"id":2,"ok":true}\n')
      await expect(second).resolves.toMatchObject({ ok: true })
    } finally {
      await worker.dispose()
    }
  })

  it('dispose 拒绝在途请求并结束子进程', async () => {
    const { spawnImpl, children } = makeSpawn()
    const worker = makeWorker(spawnImpl, { startupTimeoutMs: 60_000 })
    const pending = worker.request({ hwnd: 42 })
    // 先挂上断言再 dispose：请求的拒绝发生在 dispose 里，晚一个 tick 才挂断言会被 Node 当成未处理拒绝
    const settled = expect(pending).rejects.toThrow('子进程工作器已关闭')
    await nextTask()
    await worker.dispose()
    await settled
    expect(children[0].kill).toHaveBeenCalled()
    // 关掉之后再请求直接失败，不会悄悄拉起新进程
    await expect(worker.request({ hwnd: 42 })).rejects.toThrow('子进程工作器已关闭')
    expect(children).toHaveLength(1)
  })
})
