/**
 * 记忆仓 · 信（D81，2026-10-31）
 *
 * 信不放进 system：写在分支的 `letters/` 里，未读的记在 `letters/unread.json`；
 * `<now>` 只报「N 封未读」，模型用 `list_letter` / `read_letter` 自己看。
 *
 * 三个落点（`write_letter.at`）：
 * - `self`：自己分支的 `letters/<id>.md`（草稿，立即提交）；
 * - `daughter`：自己分支的 `letters/outbox/<id>.md`（待寄；`give_birth` 时带进女儿分支并标未读）；
 * - `desktop`：`<桌面>/记忆球的信/<id>.md`（给他看，不进仓）。
 *
 * 文件格式（人可读，`list_letter` / `read_letter` 也从这里解析）：
 *
 * ```
 * 写给：主人
 * 来自：小鱼
 * 写于：2026-10-31 12:30
 *
 * ---
 *
 * 正文……
 * ```
 *
 * 纪律：仓内写失败就如实回失败，不假装写成；桌面文件不覆盖（同秒重名自动加 `-2`）。
 */

import { mkdir, readdir, writeFile as writeFsFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LetterAt, LetterSummary, LetterView, WriteLetterResult } from '../chain/agent/tools'
import type { MemoryRepo } from './memory-repo'

const LETTER_DIR = 'letters'
const OUTBOX_DIR = 'letters/outbox'
const UNREAD_FILE = 'letters/unread.json'
const DESKTOP_DIRNAME = '记忆球的信'
const HEADER_SEP = '\n\n---\n\n'
const LIST_LIMIT = 50
const TO_MAX = 60
const FROM_MAX = 40
const WRITE_MAX = 8_000

export interface LetterStore {
  write(input: { to: string; write: string; at: LetterAt; from: string }): Promise<WriteLetterResult>
  list(): Promise<readonly LetterSummary[]>
  /** id 不传 = 最新一封未读；读到未读的会标已读（写回 unread.json 并提交） */
  read(id?: string): Promise<LetterView | null>
  unreadCount(): Promise<number>
}

export interface LetterStoreDeps {
  repo: MemoryRepo
  /** 桌面目录（`app.getPath('desktop')`；测试注入临时目录） */
  desktopDir: string
  now?: () => number
}

interface ParsedLetter {
  from: string
  to: string
  at: number
  text: string
}

interface UnreadEntry {
  id: string
  file: string
  from: string
  to: string
  at: number
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function parseTime(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u.exec(text.trim())
  if (!match) return null
  const ts = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  ).getTime()
  return Number.isFinite(ts) ? ts : null
}

function formatId(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function oneLine(value: string, maxChars: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, maxChars)
}

export function buildLetterContent(input: {
  from: string
  to: string
  at: number
  text: string
}): string {
  return `写给：${input.to}\n来自：${input.from}\n写于：${formatTime(input.at)}${HEADER_SEP}${input.text.trim()}\n`
}

export function parseLetterContent(content: string): ParsedLetter | null {
  const sep = content.indexOf(HEADER_SEP)
  if (sep < 0) return null
  const head = content.slice(0, sep)
  const text = content.slice(sep + HEADER_SEP.length).trim()
  const line = (prefix: string): string => {
    const found = head.split('\n').find((item) => item.startsWith(prefix))
    return found === undefined ? '' : found.slice(prefix.length).trim()
  }
  const to = line('写给：')
  const from = line('来自：')
  const at = parseTime(line('写于：'))
  if (to === '' || from === '' || at === null) return null
  return { from, to, at, text }
}

function isUnreadEntry(value: unknown): value is UnreadEntry {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    item.id !== '' &&
    typeof item.file === 'string' &&
    item.file !== '' &&
    typeof item.from === 'string' &&
    typeof item.to === 'string' &&
    typeof item.at === 'number' &&
    Number.isFinite(item.at)
  )
}

async function readUnread(repo: MemoryRepo): Promise<UnreadEntry[]> {
  const raw = await repo.readFile(UNREAD_FILE)
  if (raw === null) return []
  try {
    const data = JSON.parse(raw) as { unread?: unknown }
    if (!Array.isArray(data.unread)) return []
    return data.unread.filter(isUnreadEntry)
  } catch {
    return []
  }
}

async function writeUnread(repo: MemoryRepo, entries: readonly UnreadEntry[]): Promise<boolean> {
  return repo.writeFile(UNREAD_FILE, `${JSON.stringify({ unread: entries }, null, 2)}\n`)
}

async function listLetterFiles(repo: MemoryRepo, dir: string): Promise<string[]> {
  try {
    const names = await readdir(join(repo.root, dir))
    return names.filter((name) => name.endsWith('.md')).sort()
  } catch {
    return []
  }
}

/** 桌面目录不存在就先建；名字按 id 排，避免同秒重名覆盖 */
async function desktopFile(desktopDir: string, id: string): Promise<string> {
  const dir = join(desktopDir, DESKTOP_DIRNAME)
  await mkdir(dir, { recursive: true })
  return join(dir, `${id}.md`)
}

export function createLetterStore(deps: LetterStoreDeps): LetterStore {
  const now = deps.now ?? (() => Date.now())

  /**
   * 同一个 id 在两个落点都不存在才用；同秒写第二封自动 `-2`、`-3`…
   * （仓内查 letters/ 与 letters/outbox/；桌面查同名文件）
   */
  async function uniqueId(ts: number, at: LetterAt): Promise<string> {
    const base = formatId(ts)
    let desktopNames: string[] | null = null
    if (at === 'desktop') {
      try {
        desktopNames = await readdir(join(deps.desktopDir, DESKTOP_DIRNAME))
      } catch {
        desktopNames = []
      }
    }
    for (let n = 1; n <= 99; n += 1) {
      const id = n === 1 ? base : `${base}-${n}`
      if (desktopNames !== null) {
        if (!desktopNames.includes(`${id}.md`)) return id
      } else {
        const drafts = await deps.repo.readFile(`${LETTER_DIR}/${id}.md`)
        const outbox = await deps.repo.readFile(`${OUTBOX_DIR}/${id}.md`)
        if (drafts === null && outbox === null) return id
      }
    }
    return `${base}-${now()}`
  }

  return {
    async unreadCount(): Promise<number> {
      return (await readUnread(deps.repo)).length
    },

    async write(input): Promise<WriteLetterResult> {
      const to = oneLine(input.to, TO_MAX)
      const from = oneLine(input.from, FROM_MAX)
      const text = input.write.trim().slice(0, WRITE_MAX)
      if (to === '') return { ok: false, message: '没写清楚写给谁。' }
      if (text === '') return { ok: false, message: '信是空的。' }
      if (from === '') return { ok: false, message: '写信人没有名字（分支昵称读不到）。' }

      const ts = now()
      const id = await uniqueId(ts, input.at)
      const content = buildLetterContent({ from, to, at: ts, text })

      if (input.at === 'desktop') {
        try {
          const file = await desktopFile(deps.desktopDir, id)
          await writeFsFile(file, content, 'utf8')
          return {
            ok: true,
            id,
            at: 'desktop',
            message: `信写到你桌面了：${DESKTOP_DIRNAME}/${id}.md`
          }
        } catch {
          return { ok: false, message: '桌面写不进去，信没写成。' }
        }
      }

      const relative = input.at === 'daughter' ? `${OUTBOX_DIR}/${id}.md` : `${LETTER_DIR}/${id}.md`
      if (!(await deps.repo.writeFile(relative, content))) {
        return { ok: false, message: '记忆仓写不进去，信没写成。' }
      }
      const committed = await deps.repo.commit(`memory: letter ${id}`)
      if (!committed.committed && committed.reason !== 'clean') {
        return { ok: true, id, at: input.at, message: `信写进去了（${relative}），但提交失败，下次提交会带上。` }
      }
      return {
        ok: true,
        id,
        at: input.at,
        message:
          input.at === 'daughter'
            ? `信放好了，出生时带给女儿：${relative}`
            : `信写进记忆仓了：${relative}`
      }
    },

    async list(): Promise<readonly LetterSummary[]> {
      const unread = await readUnread(deps.repo)
      const unreadIds = new Set(unread.map((entry) => entry.id))
      const items: LetterSummary[] = []
      for (const [dir, where] of [
        [LETTER_DIR, 'letters'],
        [OUTBOX_DIR, 'outbox']
      ] as const) {
        for (const name of await listLetterFiles(deps.repo, dir)) {
          const id = name.slice(0, -3)
          const content = await deps.repo.readFile(`${dir}/${name}`)
          if (content === null) continue
          const parsed = parseLetterContent(content)
          if (parsed === null) continue
          items.push({
            id,
            from: parsed.from,
            to: parsed.to,
            at: parsed.at,
            where,
            unread: unreadIds.has(id)
          })
        }
      }
      items.sort((a, b) => b.at - a.at)
      return items.slice(0, LIST_LIMIT)
    },

    async read(id?: string): Promise<LetterView | null> {
      const unread = await readUnread(deps.repo)
      let target = id?.trim() ?? ''
      if (target === '') {
        if (unread.length === 0) return null
        const latest = [...unread].sort((a, b) => b.at - a.at)[0]
        if (latest === undefined) return null
        target = latest.id
      }
      if (!/^[A-Za-z0-9-]+$/u.test(target)) return null

      const found = await deps.repo.readFile(`${LETTER_DIR}/${target}.md`)
      const inOutbox = found === null
      const content = found ?? (await deps.repo.readFile(`${OUTBOX_DIR}/${target}.md`))
      if (content === null) return null
      const parsed = parseLetterContent(content)
      if (parsed === null) return null

      const wasUnread = unread.some((entry) => entry.id === target)
      if (wasUnread) {
        const next = unread.filter((entry) => entry.id !== target)
        if (await writeUnread(deps.repo, next)) {
          // 读完标已读要落盘：否则工作区一直脏、切分支会被拒
          await deps.repo.commit(`memory: read ${target}`)
        }
      }

      return {
        id: target,
        from: parsed.from,
        to: parsed.to,
        at: parsed.at,
        where: inOutbox ? 'outbox' : 'letters',
        unread: false,
        text: parsed.text
      }
    }
  }
}

/** 给 `give_birth` 用：读母亲分支里待寄的信（不解析失败就跳过，不挡住出生） */
export async function readOutboxLetters(
  repo: MemoryRepo
): Promise<Array<{ id: string; content: string; parsed: ParsedLetter }>> {
  const out: Array<{ id: string; content: string; parsed: ParsedLetter }> = []
  for (const name of await listLetterFiles(repo, OUTBOX_DIR)) {
    const id = name.slice(0, -3)
    const content = await repo.readFile(`${OUTBOX_DIR}/${name}`)
    if (content === null) continue
    const parsed = parseLetterContent(content)
    if (parsed === null) continue
    out.push({ id, content, parsed })
  }
  return out
}

/** 给 `give_birth` 用：把待寄的信写进女儿分支，并标成未读；返回是否全部写成 */
export async function carryOutboxLetters(
  repo: MemoryRepo,
  letters: readonly { id: string; content: string; parsed: ParsedLetter }[]
): Promise<boolean> {
  if (letters.length === 0) return true
  let ok = true
  for (const letter of letters) {
    if (!(await repo.writeFile(`${LETTER_DIR}/${letter.id}.md`, letter.content))) ok = false
  }
  if (!ok) return false
  const unread: UnreadEntry[] = letters.map((letter) => ({
    id: letter.id,
    file: `${LETTER_DIR}/${letter.id}.md`,
    from: letter.parsed.from,
    to: letter.parsed.to,
    at: letter.parsed.at
  }))
  return writeUnread(repo, unread)
}

export type { ParsedLetter, UnreadEntry }
