/**
 * 信息链 · 派生层：段文本整理（契约 v0.8 / D45）
 *
 * 段里的 `chain_content` 不是一篇干净的文章：UIA 每 15s 读一次整窗树，同一段里会
 * 攒下多份**几乎相同**的文本（菜单、侧栏、工具栏每份都重复一遍）；OCR 每次断行 / 错字
 * 又都不同。派生的目标是「抽标签 / 双链关键词」，不是复述原文（原文在库里，图片也在），
 * 所以送模型前先做三件事：
 *
 * 1. **按行去重**（保留第一次出现的顺序）：跨多次读取的同一行只留一份——浏览器页面、
 *    UIA 整窗树里的大量重复靠这一步消掉；
 * 2. **归一化空白**：连续空白折成一个空格、去首尾空白、空行丢掉；
 * 3. **按字符上限截断**（默认 6000，见 `MAX_DERIVE_TEXT_CHARS`）：超了就在末尾截断并标
 *    `truncated`，模型侧看到的是「这一段只给了这么多」。
 *
 * 指纹（`hash`）算在**截断后**的文本上：上限之外的滚动内容不会让同一段反复重抽，
 * 上限之内的变化（换页、换了话题）才会。
 */

import { createHash } from 'node:crypto'

/**
 * 送模型的正文字符上限（去重后）。
 *
 * 定这个数的依据是真实样本：UIA 整窗一次 2.1 万字（DSH），去重后仍有数千字；
 * 而抽取只需要关键词。6000 字 ≈ 3–4k tokens，200 段回填约 60–80 万 tokens，
 * 正好落在默认每日 100 万预算里（D22）。改这个数要同时改契约 §2.5 与标定说明。
 */
export const MAX_DERIVE_TEXT_CHARS = 6_000

export interface DeriveTextInput {
  text: string
}

export interface DeriveText {
  /** 去重 + 归一化 + 截断后的正文（可能为空串） */
  text: string
  /** 截断后正文的指纹（16 位 hex），用于判断「这一段要不要重抽」 */
  hash: string
  truncated: boolean
  /** 输入各行的总字符数（去重前，按「行 + 换行」计，与 keptChars 同口径） */
  rawChars: number
  /** 留下来的字符数（= text.length） */
  keptChars: number
  /** 因重复被丢掉的行数 */
  droppedLines: number
}

/** 单行归一化：连续空白折成一个空格，去首尾空白 */
export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/** 文本指纹（sha256 前 16 位；只用于本地判重，不是安全哈希） */
export function deriveTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * 把一段（同一 `segment_id`）的多条内容整理成一份送模型的正文。
 * 输入按 `captured_at` / `id` 升序时保留「第一次出现」的顺序；乱序也不会崩，只是顺序不同。
 */
export function buildDeriveText(
  contents: readonly DeriveTextInput[],
  options: { maxChars?: number } = {}
): DeriveText {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? MAX_DERIVE_TEXT_CHARS))
  const seen = new Set<string>()
  const lines: string[] = []
  let rawHint = 0
  let droppedLines = 0

  for (const content of contents) {
    for (const raw of content.text.split(/\r?\n/)) {
      const line = normalizeLine(raw)
      if (line === '') continue
      // 与 keptChars（含换行）同口径：每行算「行 + 一个换行」
      rawHint += line.length + 1
      if (seen.has(line)) {
        droppedLines += 1
        continue
      }
      seen.add(line)
      lines.push(line)
    }
  }

  const joined = lines.join('\n')
  const truncated = joined.length > maxChars
  const text = truncated ? joined.slice(0, maxChars) : joined
  return {
    text,
    hash: deriveTextHash(text),
    truncated,
    rawChars: Math.max(0, rawHint - (lines.length > 0 ? 1 : 0)),
    keptChars: text.length,
    droppedLines
  }
}
