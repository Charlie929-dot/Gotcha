/**
 * 成长档案 · 主进程接线（自调用 v0.2 §8 / §12.3，2026-11-01）
 *
 * 把 `src/memory/growth.ts` 的文件读写包成链层要的口子：
 * - `write()`：`write_growth` 的执行端口（日记 / 周记落盘，已有就覆盖）；
 * - `list()` / `show()`：`/growth` 的列表与全文；
 * - `hasEntry()`：周日日记写完后判断「这周周记写了没」（串周记用）。
 *
 * 文件在**记忆仓**里：`<memory-repo>/growth/{daily,weekly}/`。用户 Obsidian 的日记
 * 一个字节都不碰；成长档案也不每轮注入（§8：只有少量结论回流小本本）。
 */

import { join } from 'node:path'

import {
  GROWTH_DIR_NAME,
  emptyGrowthText,
  growthEntryText,
  growthKeyOf,
  growthListText,
  isGrowthKey,
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
}

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
      if (key === '') return '用法：/growth <日期 2026-11-01 | 周 2026-W44>'
      const kind: GrowthKind = /^\d{4}-W\d{2}$/u.test(key) ? 'weekly' : 'daily'
      if (!isGrowthKey(kind, key)) {
        return `不认识的日期 / 周：${key}（日记写 2026-11-01，周记写 2026-W44）`
      }
      const entry = readGrowthEntry(options.root, kind, key)
      if (entry === null) {
        return `成长档案里还没有 ${key} 这一篇（${emptyGrowthText()}）`
      }
      return growthEntryText(entry)
    },
    hasEntry: (kind, at) => readGrowthEntry(options.root, kind, growthKeyOf(kind, at)) !== null
  }
}
