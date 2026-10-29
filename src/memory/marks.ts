/**
 * 个人记忆 · 作者标记与行内线程（纯函数，不碰文件、不碰库）
 *
 * 一条日记条目里混着两个人写的话：
 *
 * ```markdown
 * - 08:40 今天早上有点困。[❤️](那就别硬撑，午休二十分钟？)[💬](好，我中午睡。)
 * - 23:30 今天你大部分时间都在改记忆球。 [❤️]()
 * ```
 *
 * 约定（`docs/agent/llm-call.md` §2.2，D57）：
 * - 行尾**没有标记** = 用户写的；
 * - `[❤️]()`（空正文）= ta 自己写的**这一行**；
 * - `[❤️](正文)` = ta 对这一行的**评论**；
 * - `[💬](正文)` = 用户对 ta 评论的**回复**（须紧跟被回复的 `[❤️]`，否则算独立留言）。
 *
 * 为什么不用「行尾裸 ❤️」：用户聊天时顺手打 ❤️ 的概率不低，裸字符会把用户的话误判成 ta 的话
 * （2026-10-29 复审的第 1 项就是把这条推翻的原因）。标记做成链接形态后，作者判定只认完整标记。
 *
 * 正文里带 `)` 时按约定写成 `[❤️](<正文>)`；解析两种都认，也容忍未包裹的成对括号
 * （`[❤️](正文(笑))` 不会把 `)` 提前切断）。
 *
 * 这一层只回答「这行是谁写的、里面有几条评论/回复」；**落库的 `text` 保留原始标记**
 * （`llm-call.md` §10：评论/回复从 text 解析），显示和检索再按需去标记。
 */

/** 标记种类：评论（ta）与回复（用户） */
export type MarkKind = 'comment' | 'reply'

export type MarkPartKind = 'text' | MarkKind

export interface MarkPart {
  kind: MarkPartKind
  /** 标记正文（已去掉 `<...>` 包裹）；空字符串表示 ta「自己写的这一行」的收尾标记 */
  text: string
}

/** 一条评论及其直接回复（同一行内按出现顺序构成线程） */
export interface MarkThreadNode {
  comment: string
  replies: string[]
}

export interface ParsedMarks {
  /** 按出现顺序的片段：正文 / 评论 / 回复 */
  parts: MarkPart[]
  /** 去掉所有标记后的正文（评论、回复的正文不算「这一行说的话」） */
  body: string
  /** 这一行是谁写的：行尾是空评论标记就是 ta，否则是用户 */
  author: 'user' | 'ta'
  /** 非空 `[❤️](正文)` 的正文 */
  comments: string[]
  /** `[💬](正文)` 的正文 */
  replies: string[]
  /** 评论 → 紧跟其后的回复 */
  thread: MarkThreadNode[]
  /** 没有前置评论的 `[💬]`（独立留言，夜报里可以回应） */
  looseReplies: string[]
  /** 这一行有没有任何标记（`comment_on_line` 据它判断「不许重复评论」） */
  hasMark: boolean
}

/** `[❤️](` / `[💬](` 的起点；❤ 兼容带不带 VS16（U+FE0F）两种写法 */
const MARK_OPEN_RE = /\[(❤️?|💬)\]\(/u

/** 标记正文里有 `)` 时要包一层 `<...>`，否则会把正文截断 */
function wrapBody(text: string): string {
  return /[)]/u.test(text) ? `<${text}>` : text
}

/**
 * 读标记的正文：`<...>`) 形式或裸正文（按括号配对找到收尾的 `)`）。
 *
 * @param text 整行
 * @param from 正文起点（`(` 之后）
 * @returns 正文与「下一个字符的位置」；格式不完整返回 null（调用方按普通文字处理，不猜）
 */
function readMarkBody(text: string, from: number): { text: string; next: number } | null {
  if (text[from] === '<') {
    const close = text.indexOf('>', from + 1)
    if (close === -1 || text[close + 1] !== ')') return null
    return { text: text.slice(from + 1, close).trim(), next: close + 2 }
  }
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') {
      depth += 1
      continue
    }
    if (char !== ')') continue
    if (depth === 0) return { text: text.slice(from, index).trim(), next: index + 1 }
    depth -= 1
  }
  return null
}

/** 把一行拆成「正文 / 评论 / 回复」片段；格式不完整的标记按普通文字保留 */
function scanParts(input: string): MarkPart[] {
  const parts: MarkPart[] = []
  const pushText = (text: string): void => {
    if (text === '') return
    const last = parts[parts.length - 1]
    if (last !== undefined && last.kind === 'text') {
      last.text += text
      return
    }
    parts.push({ kind: 'text', text })
  }
  let index = 0
  while (index < input.length) {
    const match = MARK_OPEN_RE.exec(input.slice(index))
    if (match === null) {
      pushText(input.slice(index))
      break
    }
    const start = index + match.index
    if (start > index) pushText(input.slice(index, start))
    const markStart = start + match[0].length
    const body = readMarkBody(input, markStart)
    if (body === null) {
      // 标记没收尾：当成用户写的字面量，继续往后扫（不抛错，也不吞掉后文）
      pushText(input.slice(start, markStart))
      index = markStart
      continue
    }
    parts.push({ kind: match[1] === '💬' ? 'reply' : 'comment', text: body.text })
    index = body.next
  }
  return parts
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** 解析一行里的作者标记与行内线程 */
export function parseMarks(input: string): ParsedMarks {
  const parts = scanParts(input)
  const body = collapse(
    parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join(' ')
  )
  const comments: string[] = []
  const replies: string[] = []
  const thread: MarkThreadNode[] = []
  const looseReplies: string[] = []
  for (const part of parts) {
    if (part.kind === 'comment') {
      if (part.text !== '') {
        comments.push(part.text)
        thread.push({ comment: part.text, replies: [] })
      }
      continue
    }
    if (part.kind !== 'reply') continue
    replies.push(part.text)
    const last = thread[thread.length - 1]
    if (last === undefined) looseReplies.push(part.text)
    else last.replies.push(part.text)
  }
  const lastPart = parts[parts.length - 1]
  const author: 'user' | 'ta' =
    lastPart !== undefined && lastPart.kind === 'comment' && lastPart.text === '' ? 'ta' : 'user'
  return {
    parts,
    body,
    author,
    comments,
    replies,
    thread,
    looseReplies,
    hasMark: parts.some((part) => part.kind !== 'text')
  }
}

/** 只留「这一行说的正文」：去掉标记、也去掉评论/回复的正文 */
export function stripMarks(text: string): string {
  return parseMarks(text).body
}

/** 去掉标记外壳但保留评论/回复正文（检索用：ta 的评论也是记忆） */
export function unmark(text: string): string {
  return collapse(
    parseMarks(text)
      .parts.map((part) => part.text)
      .join(' ')
  )
}

/** ta 的评论：`[❤️](正文)`；正文带 `)` 时自动包 `<...>` */
export function formatComment(text: string): string {
  const body = text.trim()
  if (body === '') throw new Error('评论正文不能为空（空评论只用于标记 ta 自己写的行）')
  return `[❤️](${wrapBody(body)})`
}

/** 用户回复：`[💬](正文)` */
export function formatReply(text: string): string {
  const body = text.trim()
  if (body === '') throw new Error('回复正文不能为空')
  return `[💬](${wrapBody(body)})`
}

/** ta 自己写的行的收尾标记（空评论） */
export const TA_MARK = '[❤️]()'

/** 给 ta 写的一句话收尾（已有标记就原样返回，避免重复打标） */
export function markAsTaLine(text: string): string {
  const line = text.trimEnd()
  const parsed = parseMarks(line)
  const lastPart = parsed.parts[parsed.parts.length - 1]
  if (lastPart !== undefined && lastPart.kind === 'comment' && lastPart.text === '') return line
  return `${line} ${TA_MARK}`
}
