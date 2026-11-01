/**
 * 成长档案 · 主进程接线（自调用 v0.2 §8 / §12.3，2026-11-01）
 *
 * 把 `src/memory/growth.ts` 的文件读写包成链层要的口子：
 * - `write()`：`write_growth` 的执行端口（日记 / 周记 / 月末总结 / 年终总结落盘，已有就覆盖）；
 * - `list()` / `show()`：`/growth` 的列表与全文；
 * - `hasEntry()`：上一层的写作任务写完后判断「这一篇写了没」（串下一篇用）。
 *
 * 文件在**记忆仓**里：`<memory-repo>/growth/{daily,weekly,monthly,yearly}/`。用户 Obsidian 的日记
 * 一个字节都不碰；成长档案也不每轮注入（§8：只有少量结论回流小本本）。
 */

import { join } from 'node:path'

import {
  GROWTH_DIR_NAME,
  emptyGrowthText,
  growthEntryText,
  growthKeyOf,
  growthKindLabel,
  growthKindOfKey,
  growthListText,
  isGrowthKey,
  listGrowthKeys,
  readGrowthEntry,
  writeGrowthEntry,
  type GrowthKind
} from '../memory/growth'

export interface GrowthWriteRequest {
  kind: GrowthKind
  content: string
}

/** 工具回执：`kind` / `period` 在失败时为空串，模型不得改口成成功 */
export interface GrowthWriteResult {
  ok: boolean
  message: string
  kind: GrowthKind | ''
  /** 写到哪一篇：`2026-11-01` / `2026-W44` */
  period: string
  chars: number
}

export interface GrowthStore {
  /** 成长档案目录（`<记忆仓>/growth`） */
  readonly dir: string
  write(input: GrowthWriteRequest): GrowthWriteResult
  /** `/growth` 列表 */
  list(): string
  /** `/growth <键>`：全文；没有这一篇时给一句人话 */
  show(key: string): string
  /** 某一时刻对应那篇写没写（周日串周记用） */
  hasEntry(kind: GrowthKind, at: number): boolean
  /** 设置抽屉：某一类的一页（新到旧；只有标题与字数，正文按需取） */
  page(kind: GrowthKind, page: number, pageSize?: number): GrowthPage
  /** 设置抽屉：点开一篇的全文（只读） */
  entry(key: string): GrowthEntryView
}

/** 抽屉里四类各自翻页，一页几条 */
export const GROWTH_PAGE_SIZE = 10

/** 抽屉列表里的一条：不给正文，避免一打开就整仓读完 */
export interface GrowthPageItem {
  key: string
  title: string
  chars: number
}

/** 抽屉里某一类的一页；`page` 会被夹到 1..pages */
export interface GrowthPage {
  kind: GrowthKind
  page: number
  pages: number
  pageSize: number
  total: number
  items: GrowthPageItem[]
}

/** 抽屉里点开一篇的全文（读不到就如实说，不抛给渲染层） */
export type GrowthEntryView =
  | { ok: true; key: string; title: string; body: string; chars: number; path: string }
  | { ok: false; message: string }

function failure(message: string): GrowthWriteResult {
  return { ok: false, message, kind: '', period: '', chars: 0 }
}

export function createGrowthStore(options: {
  /** 记忆仓根目录 */
  root: string
  /** 固定钟（测试注入） */
  now: () => number
}): GrowthStore {
  const dir = join(options.root, GROWTH_DIR_NAME)

  const write = (input: GrowthWriteRequest): GrowthWriteResult => {
    const key = growthKeyOf(input.kind, options.now())
    const outcome = writeGrowthEntry(options.root, input.kind, key, input.content)
    if (!outcome.ok) return failure(outcome.message)
    return {
      ok: true,
      message: outcome.message,
      kind: input.kind,
      period: key,
      chars: outcome.entry.body.length
    }
  }

  return {
    dir,
    write,
    list: () => growthListText(options.root),
    show: (rawKey) => {
      const key = rawKey.trim()
      if (key === '') {
        return '用法：/growth <日期 2026-11-01 | 周 2026-W44 | 月 2026-11 | 年 2026>'
      }
      // 四层键各有形状（2026 / 2026-11 / 2026-11-01 / 2026-W44）：不猜，认不出来就说不认识
      const kind = growthKindOfKey(key)
      if (kind === null || !isGrowthKey(kind, key)) {
        return `不认识的日期 / 周 / 月 / 年：${key}（日记 2026-11-01，周记 2026-W44，月末总结 2026-11，年终总结 2026）`
      }
      const entry = readGrowthEntry(options.root, kind, key)
      if (entry === null) {
        return `成长档案里还没有 ${key} 这一篇${growthKindLabel(kind)}（${emptyGrowthText()}）`
      }
      return growthEntryText(entry)
    },
    hasEntry: (kind, at) => readGrowthEntry(options.root, kind, growthKeyOf(kind, at)) !== null,
    page: (kind, page, pageSize = GROWTH_PAGE_SIZE) => {
      const keys = listGrowthKeys(options.root, kind)
      const size = Math.max(1, Math.floor(pageSize))
      const pages = Math.max(1, Math.ceil(keys.length / size))
      const current = Math.min(Math.max(1, Math.floor(page)), pages)
      const items: GrowthPageItem[] = []
      for (const key of keys.slice((current - 1) * size, current * size)) {
        const entry = readGrowthEntry(options.root, kind, key)
        // 坏文件（读不出来 / 键不合法）跳过，不让一条脏数据挡住整页
        if (entry === null) continue
        items.push({ key, title: entry.title, chars: entry.body.length })
      }
      return { kind, page: current, pages, pageSize: size, total: keys.length, items }
    },
    entry: (rawKey) => {
      const key = rawKey.trim()
      const kind = growthKindOfKey(key)
      if (key === '' || kind === null || !isGrowthKey(kind, key)) {
        return {
          ok: false,
          message: `不认识的日期 / 周 / 月 / 年：${key === '' ? '（空）' : key}（日记 2026-11-01，周记 2026-W44，月末总结 2026-11，年终总结 2026）`
        }
      }
      const entry = readGrowthEntry(options.root, kind, key)
      if (entry === null) {
        return {
          ok: false,
          message: `成长档案里还没有 ${key} 这一篇${growthKindLabel(kind)}（${emptyGrowthText()}）`
        }
      }
      return {
        ok: true,
        key,
        title: entry.title,
        body: entry.body,
        chars: entry.body.length,
        path: entry.path
      }
    }
  }
}
