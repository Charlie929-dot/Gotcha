/**
 * 信息链 · 不变量校验（契约 §3，第 1–5 条；第 6–9 条是使用纪律，靠代码审查与迁移测试保证）
 *
 * 纯函数：不碰数据库，输入是待写入的行，输出是人能读的问题清单。
 * 写入前先过一遍，问题是**返回错误**而不是修补——证据层不许静默改数。
 */
import type { ChainContentRow, ChainEventRow, ChainSegmentRow, ChainShotRow } from './schema'

/** 段：`active_ms + idle_ms = end_ts - start_ts`，且区间不倒挂 */
export function validateSegment(segment: ChainSegmentRow): string[] {
  const problems: string[] = []
  if (segment.end_ts < segment.start_ts) problems.push('段结束早于开始')
  if (segment.active_ms < 0 || segment.idle_ms < 0) problems.push('段时长不能为负')
  if (segment.active_ms + segment.idle_ms !== segment.end_ts - segment.start_ts) {
    problems.push(
      `有效时长 + 空闲 (${segment.active_ms} + ${segment.idle_ms}) 不等于跨度 ${segment.end_ts - segment.start_ts}`
    )
  }
  if (segment.day_key.trim() === '') problems.push('段缺少 day_key')
  return problems
}

/** 事件：必须落在所属段的时间范围内 */
export function validateEvent(event: ChainEventRow, segment: ChainSegmentRow): string[] {
  const problems: string[] = []
  if (event.segment_id !== segment.id) problems.push('事件指向的段不存在')
  if (event.ts < segment.start_ts || event.ts > segment.end_ts) problems.push('事件时刻落在段之外')
  return problems
}

/** 截图：必须挂在存在的段上；挂了事件就必须与段一致 */
export function validateShot(shot: ChainShotRow, segment: ChainSegmentRow, event?: ChainEventRow): string[] {
  const problems: string[] = []
  if (shot.segment_id !== segment.id) problems.push('截图指向的段不存在')
  if (shot.event_id !== null) {
    if (!event) problems.push('截图挂在不存在的事件上')
    else if (event.segment_id !== shot.segment_id) problems.push('截图与它的事件不属于同一段')
  }
  if (shot.source === 'enter' && shot.event_id !== null) problems.push('入场帧不应关联普通事件')
  if (shot.ts < segment.start_ts || shot.ts > segment.end_ts) problems.push('截图时刻落在段之外')
  return problems
}

/** 内容：必须有来源；字符数必须与正文一致 */
export function validateContent(content: ChainContentRow): string[] {
  const problems: string[] = []
  if (content.text.trim() === '') problems.push('内容为空')
  if (content.chars !== content.text.length) {
    problems.push(`字符数 ${content.chars} 与正文长度 ${content.text.length} 不一致`)
  }
  return problems
}

export interface SegmentLike {
  start_ts: number
  end_ts: number
}

/** 段之间不允许重叠（同一时刻最多一个段在占用） */
export function findOverlaps(segments: readonly SegmentLike[]): Array<[SegmentLike, SegmentLike]> {
  const sorted = [...segments].sort((a, b) => a.start_ts - b.start_ts)
  const overlaps: Array<[SegmentLike, SegmentLike]> = []
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]
    const current = sorted[i]
    if (current.start_ts < previous.end_ts) overlaps.push([previous, current])
  }
  return overlaps
}
