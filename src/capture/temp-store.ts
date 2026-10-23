/**
 * 临时帧存储（F06）
 *
 * 文件桥模式下每帧 PNG 先写 `userData/tmp/frame-<ts>.png`，OCR 完立即删除。
 * 强退 / 崩溃 / 删除失败会留下残留：下次应用启动时按「受控目录 + 文件名白名单」
 * 清理，只删本应用生成的 `frame-<毫秒时间戳>.png`，目录里的其它文件一律不动。
 *
 * 不在日志 / 返回值里出现文件路径（路径可能带用户名）：调用方只记数量与错误码。
 */

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface TempCleanupResult {
  removed: number
  failed: number
}

/** 截图层写盘命名：`frame-${Date.now()}.png`（screen-stream.ts） */
export const FRAME_FILE_PATTERN = /^frame-\d+\.png$/

/**
 * 清理 temp 目录里上次会话残留的帧文件。
 * 目录不存在 / 不可读时返回 0，不抛错（启动路径不能因清理失败而中断）。
 */
export function cleanStaleFrames(dir: string): TempCleanupResult {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { removed: 0, failed: 0 }
  }
  let removed = 0
  let failed = 0
  for (const name of entries) {
    if (!FRAME_FILE_PATTERN.test(name)) continue
    try {
      rmSync(join(dir, name), { force: true })
      removed++
    } catch {
      failed++
    }
  }
  return { removed, failed }
}
