import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WinrtOcrBridge } from '../../src/capture/ocr/winrt-bridge'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly written: string[] = []
  readonly kill = vi.fn(() => true)

  constructor() {
    super()
    // 记录桥写入的请求行（PassThrough 的读端）
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

function makeBridge(
  spawnImpl: typeof spawn,
  overrides: Partial<ConstructorParameters<typeof WinrtOcrBridge>[0]> = {}
): WinrtOcrBridge {
  return new WinrtOcrBridge({
    scriptPath: 'C:\\fake\\winrt-ocr.ps1',
    spawnImpl,
    startupTimeoutMs: 50,
    restartCooldownMs: 0,
    ...overrides
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WinrtOcrBridge · 启动 / 退出状态管理（F07）', () => {
  it('ready 后按行协议识别成功', async () => {
    const { spawnImpl, children } = makeSpawn()
    const bridge = makeBridge(spawnImpl)
    try {
      const promise = bridge.recognize('C:\\tmp\\frame-1.png')
      await nextTask()
      const child = children[0]
      expect(child.kill).not.toHaveBeenCalled()

      child.stdout.write('{"ready":true}\n')
      await nextTask()
      expect(child.written.join('')).toContain('"id":1')

      child.stdout.write('{"id":1,"ok":true,"ms":43,"text":"hello"}\n')
      await expect(promise).resolves.toEqual({ text: 'hello', ms: 43 })
    } finally {
      await bridge.dispose()
    }
  })

  it('脚本不输出 ready：启动超时失败并结束子进程，调用方不会永久挂起', async () => {
    const { spawnImpl, children } = makeSpawn()
    const bridge = makeBridge(spawnImpl, { startupTimeoutMs: 10 })
    await expect(bridge.recognize('p')).rejects.toThrow('OCR 子进程启动超时')
    expect(children).toHaveLength(1)
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('ready 前退出：拒绝等待中的请求；冷却后可重新拉起并成功', async () => {
    const { spawnImpl, children } = makeSpawn()
    const bridge = makeBridge(spawnImpl)
    try {
      const first = bridge.recognize('p')
      await nextTask()
      children[0].emit('exit', 1)
      await expect(first).rejects.toThrow('OCR 子进程退出')

      const second = bridge.recognize('p')
      await nextTask()
      expect(children).toHaveLength(2)
      children[1].stdout.write('{"ready":true}\n')
      await nextTask()
      // 第一次请求没走到写管道（等 ready 时就被拒），seq 仍从 1 开始
      expect(children[1].written.join('')).toContain('"id":1')
      children[1].stdout.write('{"id":1,"ok":true,"ms":5,"text":"again"}\n')
      await expect(second).resolves.toEqual({ text: 'again', ms: 5 })
    } finally {
      await bridge.dispose()
    }
  })

  it('ready 后崩溃：在途请求立即失败，下次调用重新拉起子进程', async () => {
    const { spawnImpl, children } = makeSpawn()
    const bridge = makeBridge(spawnImpl)
    try {
      const first = bridge.recognize('p')
      await nextTask()
      children[0].stdout.write('{"ready":true}\n')
      await nextTask()
      expect(children[0].written.join('')).toContain('"id":1')

      children[0].emit('exit', 0)
      await expect(first).rejects.toThrow('OCR 子进程退出')

      const second = bridge.recognize('p')
      await nextTask()
      expect(children).toHaveLength(2)
      children[1].stdout.write('{"ready":true}\n')
      await nextTask()
      children[1].stdout.write('{"id":2,"ok":true,"ms":7,"text":"after-crash"}\n')
      await expect(second).resolves.toEqual({ text: 'after-crash', ms: 7 })
    } finally {
      await bridge.dispose()
    }
  })

  it('启动失败后的冷却期：直接失败，不每个采样周期都 spawn 新进程', async () => {
    const { spawnImpl, children } = makeSpawn()
    const bridge = makeBridge(spawnImpl, { startupTimeoutMs: 5, restartCooldownMs: 60_000 })
    await expect(bridge.recognize('p')).rejects.toThrow('OCR 子进程启动超时')
    await expect(bridge.recognize('p')).rejects.toThrow('s 后重试')
    expect(children).toHaveLength(1)
  })

  it('dispose 拒绝 ready 等待与在途请求（停止采集时不无限 flush）', async () => {
    const { spawnImpl, children } = makeSpawn()
    const bridge = makeBridge(spawnImpl, { startupTimeoutMs: 60_000 })
    const pending = bridge.recognize('p')
    await nextTask()
    await bridge.dispose()
    await expect(pending).rejects.toThrow('OCR 桥已关闭')
    expect(children[0].kill).toHaveBeenCalled()
  })
})
