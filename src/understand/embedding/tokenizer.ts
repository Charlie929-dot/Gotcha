/**
 * BERT WordPiece 分词（bge-small-zh-v1.5 用 `BertTokenizer`，vocab.txt 21,128 项）
 *
 * 与 HF `BertTokenizer` 的口径对齐（`tokenizer_config.json`：`do_lower_case=false`、
 * `tokenize_chinese_chars=true`、`do_basic_tokenize=true`）：
 * 1. 清控制字符、空白归一；
 * 2. 中文（CJK）按字拆开；
 * 3. 空白切词 + WordPiece 贪心最长匹配（非词首前缀 `##`）；
 * 4. 加 `[CLS]` / `[SEP]`，截断到 `maxLength`。
 *
 * 不依赖第三方 tokenizer：模型文件是用户本地资产，这里只读 `vocab.txt`。
 */

export const SPECIAL_TOKENS = {
  pad: '[PAD]',
  unk: '[UNK]',
  cls: '[CLS]',
  sep: '[SEP]'
} as const

/** BERT 的 max_position_embeddings（config.json） */
export const BERT_MAX_LENGTH = 512

/** 单个词最多切 100 个 WordPiece（与 HF 一致，防病态长串） */
const MAX_CHARS_PER_WORD = 100

export interface BertVocab {
  /** token → id */
  ids: Map<string, number>
  padId: number
  unkId: number
  clsId: number
  sepId: number
}

export interface EncodedText {
  inputIds: number[]
  attentionMask: number[]
  /** 实际 token 数（含特殊符号，已截断） */
  length: number
}

export interface EncodeOptions {
  /** 含 `[CLS]`/`[SEP]` 的总长度上限（默认 512） */
  maxLength?: number
}

/** 从 vocab.txt 原文构建词表（每行一个 token，行号即 id） */
export function loadVocab(text: string): BertVocab {
  const ids = new Map<string, number>()
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const token = lines[index]
    if (token === '') continue
    if (!ids.has(token)) ids.set(token, index)
  }
  return {
    ids,
    padId: ids.get(SPECIAL_TOKENS.pad) ?? 0,
    unkId: ids.get(SPECIAL_TOKENS.unk) ?? 100,
    clsId: ids.get(SPECIAL_TOKENS.cls) ?? 101,
    sepId: ids.get(SPECIAL_TOKENS.sep) ?? 102
  }
}

/** HF `_is_chinese_char`：CJK 统一表意文字、扩展 A/B…、兼容表意、私用平面 */
function isChineseChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  )
}

/** 清控制字符 + 空白归一（\t/\n/\r 等 → 空格） */
export function cleanText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0 || code === 0xfffd) continue
    if (code < 32 || code === 0x7f) {
      out += ' '
      continue
    }
    out += char
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** 中文按字拆开，其它字符原样（返回以空格分隔的串） */
export function spaceChinese(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isChineseChar(code)) out += ` ${char} `
    else out += char
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** WordPiece 贪心最长匹配；任何一个片段匹配不上整词判 `[UNK]` */
export function wordPiece(word: string, vocab: BertVocab): string[] {
  const chars = Array.from(word)
  if (chars.length === 0) return []
  if (chars.length > MAX_CHARS_PER_WORD) return [SPECIAL_TOKENS.unk]
  const pieces: string[] = []
  let start = 0
  while (start < chars.length) {
    let end = chars.length
    let current: string | null = null
    while (start < end) {
      let sub = chars.slice(start, end).join('')
      if (start > 0) sub = `##${sub}`
      if (vocab.ids.has(sub)) {
        current = sub
        break
      }
      end -= 1
    }
    if (current === null) return [SPECIAL_TOKENS.unk]
    pieces.push(current)
    start = end
  }
  return pieces
}

/** 基础分词（不做 WordPiece）：返回 token 字符串数组 */
export function basicTokenize(text: string, options: { lowercase?: boolean } = {}): string[] {
  const cleaned = spaceChinese(cleanText(text))
  const lower = options.lowercase === true ? cleaned.toLowerCase() : cleaned
  return lower.split(' ').filter((word) => word !== '')
}

/** 把一段文本编码成 `[CLS] … [SEP]` 的 id 序列 */
export function encodeText(text: string, vocab: BertVocab, options: EncodeOptions = {}): EncodedText {
  const maxLength = Math.max(2, options.maxLength ?? BERT_MAX_LENGTH)
  const tokens: string[] = []
  for (const word of basicTokenize(text)) {
    for (const piece of wordPiece(word, vocab)) {
      tokens.push(piece)
      if (tokens.length >= maxLength - 2) break
    }
    if (tokens.length >= maxLength - 2) break
  }

  const inputIds = [vocab.clsId]
  for (const token of tokens) {
    const id = vocab.ids.get(token)
    inputIds.push(id ?? vocab.unkId)
  }
  inputIds.push(vocab.sepId)
  return {
    inputIds,
    attentionMask: inputIds.map(() => 1),
    length: inputIds.length
  }
}
