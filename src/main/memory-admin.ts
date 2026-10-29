/**
 * 个人记忆 · 条目浏览 / 删除（设置抽屉「记忆条目」）的主进程侧
 *
 * 和 `memory-settings.ts` 同一套纪律：渲染层来的参数一律在这层钳死（关键词长度、分页、
 * 条目 id / uid 形态），再交给 `src/memory/store.ts`；出错变成可读结果，不把异常抛回渲染层。
 *
 * 只读写 `mem_items` / `mem_deleted` 两张表，不碰日记文件本身：删除是「从记忆里拿掉」，
 * 不是改用户写的 md（原文与双链、勾选框都还在）。
 */
import { basename } from 'node:path'

import type { Db } from '../db'
import type { MemoryItemKind } from '../memory/vault'
import {
  countDeleted,
  deleteMemoryItem,
  listMemoryItems,
  restoreMemoryItem,
  type MemoryItemRow,
  type MemoryListQuery
} from '../memory/store'

/** 关键词上限（界面上是一个搜索框；够描述「某个词」就行） */
export const MEMORY_SEARCH_MAX_CHARS = 80
/** 一页多少条（抽屉一次滚不完；翻页靠「加载更多」） */
export const MEMORY_LIST_LIMIT_DEFAULT = 20
export const MEMORY_LIST_LIMIT_MAX = 50
/** 一次最多翻到第几条（防止手滑滚出个巨大的 OFFSET） */
const MEMORY_LIST_OFFSET_MAX = 1_000_000
/** 条目 uid = sha1 hex */
const MEMORY_UID_RE = /^[0-9a-f]{40}$/u

const KINDS: readonly MemoryItemKind[] = ['diary', 'task', 'note', 'quote']

/** 列表里的一个条目（渲染层直接画；源码路径只给文件名） */
export interface MemoryListItemView {
  id: number
  /** 删除 / 撤销用的稳定键（正文删了也还在回收站里） */
  uid: string
  day: string
  section: string
  kind: MemoryItemKind
  text: string
  /** 当天时刻 `HH:mm`；待办这类没有时刻的条目为 null */
  clock: string | null
  tags: string[]
  refs: string[]
  /** 源文件名（`2026-09-29.md`） */
  file: string
}

export type MemoryListView =
  | {
      ok: true
      items: MemoryListItemView[]
      /** 满足条件的总条数（不是这一页） */
      total: number
      hasMore: boolean
      /** 回收站里现有条数 */
      deleted: number
    }
  | { ok: false; error: string }

export type MemoryDeleteView =
  | { ok: true; item: MemoryListItemView; deleted: number }
  | { ok: false; error: string }

export type MemoryRestoreView =
  | { ok: true; item: MemoryListItemView }
  | { ok: false; error: string }

export type ParseMemoryQueryResult =
  | { ok: true; query: MemoryListQuery }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 时间戳 → 当天 `HH:mm`（本地时区；与对话卡里的时刻同一个口径） */
function clockOf(ts: number | null): string | null {
  if (ts === null) return null
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function toMemoryListItem(item: MemoryItemRow): MemoryListItemView {
  return {
    id: item.id,
    uid: item.uid,
    day: item.day_key,
    section: item.section,
    kind: item.kind,
    text: item.text,
    clock: clockOf(item.ts),
    tags: [...item.tags],
    refs: [...item.refs],
    file: basename(item.source_path)
  }
}

/**
 * 校验浏览参数。空对象 = 第一页（按天倒序）。
 * 手滑传了非数字 / 超长关键词 / 不认识的类别都直接报错，不静默纠正（设置抽屉的既有纪律）。
 */
export function parseMemoryListQuery(raw: unknown): ParseMemoryQueryResult {
  if (raw === undefined || raw === null) return { ok: true, query: {} }
  if (!isPlainObject(raw)) return { ok: false, error: '参数不合法' }
  const query: MemoryListQuery = {}

  if (raw.search !== undefined) {
    if (typeof raw.search !== 'string') return { ok: false, error: '关键词必须是文本' }
    const search = raw.search.trim()
    if (search.length > MEMORY_SEARCH_MAX_CHARS) {
      return { ok: false, error: `关键词太长（最多 ${MEMORY_SEARCH_MAX_CHARS} 字）` }
    }
    query.search = search
  }

  if (raw.kind !== undefined && raw.kind !== '') {
    if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind as MemoryItemKind)) {
      return { ok: false, error: '不认识的条目类别' }
    }
    query.kind = raw.kind as MemoryItemKind
  }

  if (raw.offset !== undefined) {
    if (
      typeof raw.offset !== 'number' ||
      !Number.isInteger(raw.offset) ||
      raw.offset < 0 ||
      raw.offset > MEMORY_LIST_OFFSET_MAX
    ) {
      return { ok: false, error: '分页位置不合法' }
    }
    query.offset = raw.offset
  }

  if (raw.limit !== undefined) {
    if (
      typeof raw.limit !== 'number' ||
      !Number.isInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > MEMORY_LIST_LIMIT_MAX
    ) {
      return { ok: false, error: `每页最多 ${MEMORY_LIST_LIMIT_MAX} 条` }
    }
    query.limit = raw.limit
  }

  return { ok: true, query }
}

/** 一条列表页（含回收站计数：界面要显示「已删除 N 条 · 撤销」） */
export function buildMemoryListView(db: Db, query: MemoryListQuery): MemoryListView {
  const result = listMemoryItems(db, query)
  return {
    ok: true,
    items: result.items.map(toMemoryListItem),
    total: result.total,
    hasMore: result.hasMore,
    deleted: countDeleted(db)
  }
}

/** 删一条（只删记忆索引，不动日记原文；回收站里留整行，可以撤销） */
export function deleteMemoryView(db: Db, raw: unknown): MemoryDeleteView {
  if (!isPlainObject(raw)) return { ok: false, error: '参数不合法' }
  const id = raw.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return { ok: false, error: '条目 id 不合法' }
  }
  const result = deleteMemoryItem(db, id)
  if (result === null) return { ok: false, error: '这条记忆已经不在了（可能刚被同步清掉）' }
  return { ok: true, item: toMemoryListItem(result.item), deleted: result.deleted }
}

/** 撤销删除：把回收站里的整行放回索引 */
export function restoreMemoryView(db: Db, raw: unknown): MemoryRestoreView {
  if (!isPlainObject(raw)) return { ok: false, error: '参数不合法' }
  const uid = raw.uid
  if (typeof uid !== 'string' || !MEMORY_UID_RE.test(uid)) {
    return { ok: false, error: '条目 uid 不合法' }
  }
  const restored = restoreMemoryItem(db, uid)
  if (restored === null) {
    return { ok: false, error: '回收站里没有这一条（可能已经恢复，或超出了保留上限）' }
  }
  return { ok: true, item: toMemoryListItem(restored) }
}
