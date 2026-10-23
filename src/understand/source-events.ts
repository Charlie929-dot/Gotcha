/**
 * `source_events` / `event_ids` 字段解析（单一来源）
 *
 * 这些字段是 JSON 数组文本；坏数据（非数组 / 坏 JSON）不能让查询抛错，
 * 调用方按 `malformed` 计数或静默跳过。
 */

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export interface ParsedEventIds {
  /** 去重、升序、只保留正整数 id */
  ids: number[]
  /** 不是合法 JSON 数组（视为坏数据） */
  malformed: boolean
  /** 文本为空 / null（不算坏数据） */
  empty: boolean
}

/** 解析事件 id 数组（去重升序）；只有正整数 id 会被保留 */
export function parseEventIdsDetailed(raw: string | null | undefined): ParsedEventIds {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ids: [], malformed: false, empty: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ids: [], malformed: true, empty: false }
  }
  if (!Array.isArray(parsed)) return { ids: [], malformed: true, empty: false }
  const seen = new Set<number>()
  for (const value of parsed) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) seen.add(value)
  }
  return { ids: [...seen].sort((a, b) => a - b), malformed: false, empty: false }
}

/** 只要 id 列表的场合（坏数据视为空数组） */
export function parseSourceEventIds(raw: string | null | undefined): number[] {
  return parseEventIdsDetailed(raw).ids
}
