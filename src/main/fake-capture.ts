/**
 * E2E 假采集会话（m1b-plan §3 Phase 2 / §6「E2E 不得启动真实录屏与真实 OCR」）
 *
 * 只在 `GOTCHA_FAKE_CAPTURE=1` **且** `GOTCHA_USER_DATA` 存在 **且** 非打包态时由
 * `main/index.ts` 注入；正常启动 / 打包产物不会走到这里。它只满足 `CaptureSession`
 * 契约（halt / flush / 释放），不建屏幕流、不起 OCR、不写库、不写临时帧。
 */

import type { CapturePipeline } from '../capture/pipeline'
import type { CaptureSession } from './capture-controller'

export interface FakeCaptureSession extends CaptureSession {
  /** 被 controller 调用的次数（E2E 可断言「切换只走状态机」） */
  readonly calls: { halt: number; flush: number; disposeStream: number; disposeOcr: number }
}

export function createFakeCaptureSession(): FakeCaptureSession {
  const calls = { halt: 0, flush: 0, disposeStream: 0, disposeOcr: 0 }
  const pipeline = {
    halt: (): void => {
      calls.halt += 1
    },
    flush: async (): Promise<void> => {
      calls.flush += 1
    },
    tick: async (): Promise<void> => {}
  } as unknown as CapturePipeline

  return {
    pipeline,
    calls,
    stopTimers: () => {},
    flushStats: () => {},
    disposeScreenStream: async () => {
      calls.disposeStream += 1
    },
    disposeOcr: async () => {
      calls.disposeOcr += 1
    }
  }
}
