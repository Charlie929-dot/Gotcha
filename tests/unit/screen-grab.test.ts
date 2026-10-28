import { describe, expect, it } from 'vitest'
import {
  frameMatchesDisplay,
  isScreenGrabBinding,
  loadScreenGrab,
  parseGrabbedFrame,
  screenGrabCandidates,
  type ScreenGrabBinding
} from '../../src/main/screen-grab'

function binding(overrides: Partial<ScreenGrabBinding> = {}): ScreenGrabBinding {
  return {
    grabMonitor: () => null,
    warmup: () => true,
    setTopmost: () => true,
    version: '0.1.0',
    ...overrides
  }
}

describe('原生抓帧模块的加载与形状校验', () => {
  it('候选路径：开发构建在前，打包资源在后', () => {
    expect(screenGrabCandidates('C:\\repo', 'C:\\app\\resources')).toEqual([
      'C:\\repo\\native\\screen-grab\\build\\Release\\screen_grab.node',
      'C:\\app\\resources\\native\\screen_grab.node'
    ])
    expect(screenGrabCandidates('C:\\repo')).toEqual([
      'C:\\repo\\native\\screen-grab\\build\\Release\\screen_grab.node'
    ])
  })

  it('一个候选都没有就返回 null（不抛错）', () => {
    expect(
      loadScreenGrab({ candidates: ['a.node', 'b.node'], exists: () => false, load: () => binding() })
    ).toBeNull()
  })

  it('加载抛错 / 形状不对就继续试下一个', () => {
    const seen: string[] = []
    const loaded = binding({ version: '0.2.0' })
    const result = loadScreenGrab({
      candidates: ['bad.node', 'wrong.node', 'good.node'],
      exists: () => true,
      load: (path) => {
        seen.push(path)
        if (path === 'bad.node') throw new Error('ABI mismatch')
        if (path === 'wrong.node') return { grabMonitor: () => null }
        return loaded
      }
    })
    expect(result).toBe(loaded)
    expect(seen).toEqual(['bad.node', 'wrong.node', 'good.node'])
  })

  it('三个导出缺一个都不算可用（否则调用点会半路崩）', () => {
    expect(isScreenGrabBinding(binding())).toBe(true)
    expect(isScreenGrabBinding(null)).toBe(false)
    expect(isScreenGrabBinding({ grabMonitor: () => null, setTopmost: () => true })).toBe(false)
    expect(isScreenGrabBinding({ grabMonitor: () => null, warmup: () => true })).toBe(false)
    expect(isScreenGrabBinding('screen_grab')).toBe(false)
  })
})

describe('原生帧的形状校验', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff])

  it('合法帧原样放行，缺的布尔按 false 记', () => {
    expect(parseGrabbedFrame({ width: 1920, height: 1080, jpeg })).toEqual({
      jpeg,
      width: 1920,
      height: 1080,
      borderSuppressed: false,
      cursorCaptured: false
    })
    expect(
      parseGrabbedFrame({ width: 2400, height: 1350, jpeg, borderSuppressed: true, cursorCaptured: true })
    ).toEqual({ jpeg, width: 2400, height: 1350, borderSuppressed: true, cursorCaptured: true })
  })

  it('尺寸 / 像素不合格就当没抓到，不猜默认值', () => {
    expect(parseGrabbedFrame(null)).toBeNull()
    expect(parseGrabbedFrame('frame')).toBeNull()
    expect(parseGrabbedFrame({ width: 1920, height: 1080 })).toBeNull()
    expect(parseGrabbedFrame({ width: 0, height: 1080, jpeg })).toBeNull()
    expect(parseGrabbedFrame({ width: 1920.5, height: 1080, jpeg })).toBeNull()
    expect(parseGrabbedFrame({ width: '1920', height: 1080, jpeg })).toBeNull()
    expect(parseGrabbedFrame({ width: 1920, height: 1080, jpeg: new Uint8Array(0) })).toBeNull()
    expect(parseGrabbedFrame({ width: 1920, height: 1080, jpeg: [0xff, 0xd8] })).toBeNull()
  })
})

describe('帧与显示器是否同一块屏', () => {
  const display = { bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }

  it('原生分辨率 / 125% 放大都认', () => {
    expect(frameMatchesDisplay({ width: 1920, height: 1080 }, display)).toBe(true)
    expect(
      frameMatchesDisplay(
        { width: 2400, height: 1350 },
        { bounds: { width: 1920, height: 1080 }, scaleFactor: 1.25 }
      )
    ).toBe(true)
  })

  it('差 1–2px 是驱动取整，放行；差得多就是抓错屏，拒绝', () => {
    expect(frameMatchesDisplay({ width: 1921, height: 1079 }, display)).toBe(true)
    expect(frameMatchesDisplay({ width: 1923, height: 1080 }, display)).toBe(false)
    expect(
      frameMatchesDisplay(
        { width: 1920, height: 1080 },
        { bounds: { width: 1920, height: 1080 }, scaleFactor: 1.5 }
      )
    ).toBe(false)
  })

  it('显示器尺寸非法直接拒绝（不能拿 0 去除）', () => {
    expect(
      frameMatchesDisplay({ width: 1920, height: 1080 }, { bounds: { width: 0, height: 0 }, scaleFactor: 1 })
    ).toBe(false)
  })
})
