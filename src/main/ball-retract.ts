/**
 * 悬浮球自动缩回的主进程兜底判定（m1b-plan §3 Phase 1 / D16，2026-10-23 拍板）
 *
 * 为什么需要：主路径是 renderer 收到 `pointerleave` 后进入 600ms 宽限、到期缩回。
 * 但窗口一旦持久化穿透或系统未转发离开事件（Windows 上高完整性级别窗口在前台等），
 * renderer 可能永远收不到 leave，球会卡在展开态。主进程用
 * `screen.getCursorScreenPoint()` 每 50ms 检查真实指针，离开窗口安全区
 * （64×64 + 8px 容差）超过宽限期后发出强制缩回。
 *
 * 纯函数：判定不依赖 Electron，单测注入假指针、边界与时钟。
 */

import type { BallRect } from './ball-position'

/** 窗口安全区外扩容差：抵消缩放 / 阴影 / 指针临界抖动 */
export const BALL_SAFE_MARGIN = 8

/** 离开安全区多久后判定需要缩回；与 renderer 的 `BALL_GRACE_MS` 保持同一口径 */
export const BALL_RETRACT_GRACE_MS = 600

/** 兜底轮询间隔 */
export const BALL_RETRACT_POLL_MS = 50

/**
 * 兜底相对 renderer 宽限再晚 100ms：正常路径（renderer 计时）不会抢跑，
 * 只有 leave 事件丢失时才由这里收口。含过渡动画约 160ms，总耗时 ≤900ms（D16）。
 */
export const BALL_RETRACT_FALLBACK_MARGIN_MS = 100

export type BallRetractState = 'idle' | 'expanded' | 'grace' | 'dragging'

export interface BallPoint {
  x: number
  y: number
}

export interface BallRetractInput {
  state: BallRetractState
  /** 当前真实指针（DIP 屏幕坐标） */
  cursor: BallPoint
  /** 球窗口边界（DIP 屏幕坐标） */
  bounds: BallRect
  /** 上一轮判定为「在安全区外」的时刻；null / 未提供表示当前在安全区内 */
  outsideSince?: number | null
  now: number
}

export interface BallRetractDecision {
  /** 传给下一轮的 outsideSince */
  outsideSince: number | null
  /** 本轮是否已到强制缩回时刻（调用方负责去重发送） */
  forceRetract: boolean
}

/** 指针是否在窗口安全区（窗口 + 容差）内；边界算在内 */
export function isPointInSafeArea(
  point: BallPoint,
  bounds: BallRect,
  margin: number = BALL_SAFE_MARGIN
): boolean {
  return (
    point.x >= bounds.x - margin &&
    point.x <= bounds.x + bounds.width + margin &&
    point.y >= bounds.y - margin &&
    point.y <= bounds.y + bounds.height + margin
  )
}

export function decideRetract(input: BallRetractInput): BallRetractDecision {
  const watchable = input.state === 'expanded' || input.state === 'grace'
  if (!watchable || isPointInSafeArea(input.cursor, input.bounds)) {
    return { outsideSince: null, forceRetract: false }
  }
  const outsideSince = input.outsideSince ?? input.now
  const deadline = BALL_RETRACT_GRACE_MS + BALL_RETRACT_FALLBACK_MARGIN_MS
  return {
    outsideSince,
    forceRetract: input.now - outsideSince >= deadline
  }
}
