/**
 * 录屏请求的窗口身份判定（F08，纯函数便于单测）
 *
 * `session.setDisplayMediaRequestHandler` 是全局的：时间线 / 球窗口与采集窗口共用
 * `defaultSession`。只检查 `pendingSource` 就放行，等于假设「只有采集窗口会调用
 * getDisplayMedia」；一旦其它 renderer 被攻陷或引入脚本，就可能拿到屏幕流。
 *
 * 因此只接受采集窗口主 frame 发起的请求：
 * - 优先按对象身份比较（request.frame === captureFrame）；
 * - Electron 跨进程重建 wrapper 时对象可能不同，再按 (processId, routingId) 兜底；
 * - 其它窗口 / iframe / 非视频请求一律拒绝。
 */

export interface DisplayMediaRequestLike {
  videoRequested: boolean
  frame: unknown
}

interface FrameIdentity {
  processId?: number
  routingId?: number
}

/** 请求是否来自采集窗口自己的主 frame（且确实请求视频） */
export function isCaptureFrameRequest(
  request: DisplayMediaRequestLike,
  captureFrame: unknown
): boolean {
  if (!request.videoRequested || !captureFrame || !request.frame) return false
  if (request.frame === captureFrame) return true
  const requestFrame = request.frame as FrameIdentity
  const expectedFrame = captureFrame as FrameIdentity
  return (
    typeof requestFrame.processId === 'number' &&
    typeof requestFrame.routingId === 'number' &&
    requestFrame.processId === expectedFrame.processId &&
    requestFrame.routingId === expectedFrame.routingId
  )
}
