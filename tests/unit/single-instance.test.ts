import { describe, expect, it, vi } from 'vitest'
import { claimSingleInstance, type SingleInstanceHost } from '../../src/main/single-instance'

interface FakeHost extends SingleInstanceHost {
  quits: number
  listeners: Array<(event: unknown, argv: string[]) => void>
  fireSecondInstance(argv: string[]): void
}

function makeHost(locked: boolean): FakeHost {
  const host: FakeHost = {
    quits: 0,
    listeners: [],
    requestSingleInstanceLock: vi.fn(() => locked),
    quit: vi.fn(() => {
      host.quits += 1
    }),
    on: vi.fn((_event: 'second-instance', listener: (event: unknown, argv: string[]) => void) => {
      host.listeners.push(listener)
    }),
    fireSecondInstance(argv: string[]): void {
      for (const listener of host.listeners) listener({}, argv)
    }
  }
  return host
}

describe('claimSingleInstance', () => {
  it('抢到锁：注册 second-instance，返回 true', () => {
    const host = makeHost(true)
    const onSecond = vi.fn()

    expect(claimSingleInstance(host, onSecond)).toBe(true)
    expect(host.quits).toBe(0)
    expect(host.listeners).toHaveLength(1)

    host.fireSecondInstance(['gotcha.exe', '--capture'])
    expect(onSecond).toHaveBeenCalledWith(['gotcha.exe', '--capture'])
  })

  it('没抢到锁：立即 quit，返回 false，不注册回调（不建第二个球）', () => {
    const host = makeHost(false)
    const onSecond = vi.fn()

    expect(claimSingleInstance(host, onSecond)).toBe(false)
    expect(host.quits).toBe(1)
    expect(host.listeners).toHaveLength(0)
    host.fireSecondInstance([])
    expect(onSecond).not.toHaveBeenCalled()
  })

  it('锁只请求一次（重复启动不会重复抢）', () => {
    const host = makeHost(true)
    claimSingleInstance(host, () => {})
    expect(host.requestSingleInstanceLock).toHaveBeenCalledTimes(1)
  })
})
