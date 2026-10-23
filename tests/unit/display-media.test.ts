import { describe, expect, it } from 'vitest'
import { isCaptureFrameRequest } from '../../src/capture/display-media'

describe('录屏请求窗口身份（F08）', () => {
  it('采集窗口主 frame 的视频请求放行', () => {
    const frame = { processId: 1, routingId: 10 }
    expect(isCaptureFrameRequest({ videoRequested: true, frame }, frame)).toBe(true)
  })

  it('等价 frame wrapper（processId + routingId 相同）也放行（跨进程重建兜底）', () => {
    const capture = { processId: 7, routingId: 3 }
    expect(
      isCaptureFrameRequest({ videoRequested: true, frame: { processId: 7, routingId: 3 } }, capture)
    ).toBe(true)
  })

  it('其它窗口 frame 拒绝', () => {
    const capture = { processId: 7, routingId: 3 }
    expect(
      isCaptureFrameRequest({ videoRequested: true, frame: { processId: 8, routingId: 3 } }, capture)
    ).toBe(false)
  })

  it('同进程其它 frame（iframe）拒绝', () => {
    const capture = { processId: 7, routingId: 3 }
    expect(
      isCaptureFrameRequest({ videoRequested: true, frame: { processId: 7, routingId: 4 } }, capture)
    ).toBe(false)
  })

  it('非视频请求 / 采集窗口不可用 / 缺少 frame 一律拒绝', () => {
    const capture = { processId: 7, routingId: 3 }
    expect(isCaptureFrameRequest({ videoRequested: false, frame: capture }, capture)).toBe(false)
    expect(isCaptureFrameRequest({ videoRequested: true, frame: capture }, null)).toBe(false)
    expect(isCaptureFrameRequest({ videoRequested: true, frame: null }, capture)).toBe(false)
  })
})
