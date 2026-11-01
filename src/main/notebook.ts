/**
 * 小本本 · 主进程接线（自调用 v0.2 §7 / §12.2，2026-11-01）
 *
 * 把 `src/memory/notebook.ts` 的文件读写包成链层要的两个口子：
 * - `read()`：每轮注入 `<now>` 的当前核心页（带编号，模型据此 revise / remove）；
 * - `update()`：`update_notebook` 的执行端口（add / revise / remove 后立刻落盘）；
 *
 * 文件在**记忆仓**里：`<memory-repo>/notebook.md`。它跟着分支走——换节点就是换一个人，
 * 小本本不串；git 里也有历史。用户 Obsidian 的日记一个字节都不碰。
 *
 * 读写都是同步小文件（< 4KB），不引 Promise；失败只回可读原因，不把异常抛进问答。
 */

import { join } from 'node:path'

import type { NotebookUpdateRequest, NotebookUpdateResult } from '../chain/agent/tools'
import {
  NOTEBOOK_FILE_NAME,
  NOTEBOOK_SECTION_IDS,
  NOTEBOOK_SECTION_LABELS,
  addNotebookEntry,
  isNotebookSection,
  notebookListText,
  readNotebookFile,
  removeNotebookEntry,
  reviseNotebookEntry,
  type NotebookUpdateOutcome,
  writeNotebookFile
} from '../memory/notebook'

/** 链层要的注入视图（section 是中文栏名） */
export interface NotebookSnapshotEntry {
  id: string
  section: string
  text: string
}

/** 设置抽屉「小本本」块的一条 */
export interface NotebookAdminEntry {
  id: string
  text: string
  /** 最近一次写下的日期；空 = 老条目没记日期 */
  at: string
}

/** 设置抽屉「小本本」块：按四个分区排，空栏也留着（看得出结构） */
export interface NotebookAdminView {
  /** 文件路径（给人看；换分支 / 换人时这里也跟着变） */
  path: string
  total: number
  groups: readonly { section: string; entries: readonly NotebookAdminEntry[] }[]
}

export interface NotebookStore {
  /** 小本本文件（`<记忆仓>/notebook.md`） */
  readonly path: string
  /** 每轮注入用：当前全部条目（文件不存在 = 空数组） */
  read(): readonly NotebookSnapshotEntry[]
  /** `update_notebook` 的端口：成功才落盘，失败如实回原因 */
  update(input: NotebookUpdateRequest): NotebookUpdateResult
  /** `/notebook` 的列表文本 */
  list(): string
  /** 设置抽屉视图（四分区 + 编号） */
  view(): NotebookAdminView
  /** `/notebook rm n3` 与抽屉删除共用 */
  remove(id: string): string
}

/** 本地日（与提交主题、计划同步同一个日历口径） */
function dayKey(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function failure(message: string, total: number): NotebookUpdateResult {
  return { ok: false, message, entry: null, total }
}

export function createNotebookStore(options: {
  /** 记忆仓根目录 */
  root: string
  /** 固定钟（测试注入） */
  now: () => number
}): NotebookStore {
  const path = join(options.root, NOTEBOOK_FILE_NAME)
  const today = (): string => dayKey(options.now())

  const read = (): readonly NotebookSnapshotEntry[] => {
    const notebook = readNotebookFile(path, today())
    return notebook.entries.map((entry) => ({
      id: entry.id,
      section: NOTEBOOK_SECTION_LABELS[entry.section],
      text: entry.text
    }))
  }

  const update = (input: NotebookUpdateRequest): NotebookUpdateResult => {
    const day = today()
    const notebook = readNotebookFile(path, day)
    let outcome: NotebookUpdateOutcome
    if (input.action === 'add') {
      const section = input.section
      if (section === undefined || !isNotebookSection(section)) {
        return failure('add 需要有效的 section（about_you / recent_you / between_us / reminders）', notebook.entries.length)
      }
      if (input.text === undefined) return failure('add 需要 text', notebook.entries.length)
      outcome = addNotebookEntry(notebook, section, input.text, day)
    } else if (input.action === 'revise') {
      if (input.id === undefined || input.text === undefined) {
        return failure('revise 需要 id 和 text', notebook.entries.length)
      }
      outcome = reviseNotebookEntry(notebook, input.id, input.text, day)
    } else {
      if (input.id === undefined) return failure('remove 需要 id', notebook.entries.length)
      outcome = removeNotebookEntry(notebook, input.id)
    }
    if (!outcome.ok) return failure(outcome.message, notebook.entries.length)
    try {
      writeNotebookFile(path, outcome.notebook, day)
    } catch (error) {
      return failure(
        `没写进小本本（${error instanceof Error ? error.message : String(error)}）`,
        notebook.entries.length
      )
    }
    return {
      ok: true,
      message: outcome.message,
      entry: {
        id: outcome.entry.id,
        section: NOTEBOOK_SECTION_LABELS[outcome.entry.section],
        text: outcome.entry.text,
        at: outcome.entry.at
      },
      total: outcome.total
    }
  }

  return {
    path,
    read,
    update,
    list: () => notebookListText(readNotebookFile(path, today())),
    view: () => {
      const notebook = readNotebookFile(path, today())
      return {
        path,
        total: notebook.entries.length,
        groups: NOTEBOOK_SECTION_IDS.map((section) => ({
          section: NOTEBOOK_SECTION_LABELS[section],
          entries: notebook.entries
            .filter((entry) => entry.section === section)
            .map((entry) => ({ id: entry.id, text: entry.text, at: entry.at }))
        }))
      }
    },
    remove: (id) => {
      const result = update({ action: 'remove', id })
      return result.message
    }
  }
}
