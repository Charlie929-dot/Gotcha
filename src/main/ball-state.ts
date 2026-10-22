/**
 * 球位置偏好文件（m1b-plan §4.7 / Q2 / Q8）
 *
 * 只存边缘 / 比例 / 显示器 id，不含任何采集内容；仅在拖动或吸附后惰性写入，
 * 空 userData 启动不会生成该文件（A3 口径：无显式交互时零磁盘写入）。
 * 写入走 `ball.json.tmp` → rename 的原子替换，避免半截文件。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { clampRatio, isBallEdge, type BallSavedState } from './ball-position'

export const BALL_STATE_FILE = 'ball.json'

/** 解析并校验 `ball.json` 内容；损坏 / 字段缺失返回 null（调用方回退默认位置） */
export function parseBallState(raw: string): BallSavedState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const data = parsed as Partial<BallSavedState>
  if (!isBallEdge(data.edge)) return null
  if (typeof data.offset_ratio !== 'number' || !Number.isFinite(data.offset_ratio)) return null
  if (typeof data.display_id !== 'number' || !Number.isFinite(data.display_id)) return null
  return {
    edge: data.edge,
    offset_ratio: clampRatio(data.offset_ratio),
    display_id: data.display_id
  }
}

/** 读取偏好；文件不存在或内容损坏都返回 null（不抛错、不建文件） */
export function readBallState(filePath: string): BallSavedState | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  return parseBallState(raw)
}

/** 原子写入：先写临时文件再 rename 覆盖，失败向上抛由调用方记日志 */
export function writeBallState(filePath: string, state: BallSavedState): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(state))
    renameSync(tempPath, filePath)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件本就不存在（写失败发生在 writeFileSync 之前），忽略
    }
    throw error
  }
}
