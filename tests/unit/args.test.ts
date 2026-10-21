import { describe, expect, it } from 'vitest'
import { resolveCapture } from '../../src/main/args'

describe('resolveCapture · 默认暂停红线（A3 前置）', () => {
  it('不带任何启动参数、无环境变量 → 默认暂停', () => {
    expect(resolveCapture([], {})).toBe(false)
  })

  it('带无关启动参数 → 仍默认暂停', () => {
    expect(resolveCapture(['gotcha.exe', '--foo'], {})).toBe(false)
  })

  it('--capture → 开启', () => {
    expect(resolveCapture(['gotcha.exe', '--capture'], {})).toBe(true)
  })

  it('GOTCHA_CAPTURE=1 → 开启', () => {
    expect(resolveCapture([], { GOTCHA_CAPTURE: '1' })).toBe(true)
  })

  it('GOTCHA_CAPTURE=0 → 默认暂停', () => {
    expect(resolveCapture([], { GOTCHA_CAPTURE: '0' })).toBe(false)
  })
})
