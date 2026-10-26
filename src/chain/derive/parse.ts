/**
 * 信息链 · 派生层：模型输出的校验与裁剪（契约 v0.8 / D45）
 *
 * 与主题命名 / 模糊确认同一套纪律：**只信任字段与上限，其余一律丢弃或截断**；
 * 结构不对就抛错，由调用方决定「这一段先不派生、下一轮再试」，绝不当成空结果写库
 * （空结果会被误读成「这段没有标签」，而实际上是一次失败）。
 */

/** 标签名上限（字符） */
export const TAG_MAX_CHARS = 24
/** 双链名字上限（字符） */
export const LINK_MAX_CHARS = 40
/** 一段最多收几个标签 */
export const MAX_TAGS = 8
/** 一段最多收几个双链单元 */
export const MAX_LINKS = 10

export class DeriveParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeriveParseError'
  }
}

export interface ExtractResult {
  tags: string[]
  links: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把字符串数组里合法的名字收下来：非字符串跳过、空白跳过、按上限截断、
 * 归一化后按 key 去重（保留第一次出现的写法），最多 `max` 个。
 */
export function collectNames(raw: unknown, maxChars: number, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.replace(/\s+/g, ' ').trim().slice(0, maxChars)
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
    if (names.length >= max) break
  }
  return names
}

/**
 * 抽取结果：`{ "tags": [...], "links": [...] }`。
 * `tags` / `links` 至少有一个是数组，否则视为结构非法（整段失败，不写空结果）。
 */
export function parseExtractResult(json: unknown): ExtractResult {
  if (!isRecord(json)) throw new DeriveParseError('抽取结果不是对象')
  const hasTags = Array.isArray(json.tags)
  const hasLinks = Array.isArray(json.links)
  if (!hasTags && !hasLinks) throw new DeriveParseError('抽取结果既没有 tags 也没有 links 数组')
  return {
    tags: collectNames(json.tags, TAG_MAX_CHARS, MAX_TAGS),
    links: collectNames(json.links, LINK_MAX_CHARS, MAX_LINKS)
  }
}

/**
 * 模糊带合并的答复：`{ "same": [true, false, ...] }`，长度必须与提问对数一致。
 * 长度不对就整批作废（错位比漏判更糟：会把 A 的结论用到 B 上）。
 */
export function parseMergeResult(json: unknown, expected: number): boolean[] {
  if (!isRecord(json)) throw new DeriveParseError('合并答复不是对象')
  if (!Array.isArray(json.same)) throw new DeriveParseError('合并答复缺少 same 数组')
  if (json.same.length !== expected) {
    throw new DeriveParseError(`合并答复长度 ${json.same.length} 与提问对数 ${expected} 不一致`)
  }
  return json.same.map((value, index) => {
    if (typeof value !== 'boolean') throw new DeriveParseError(`合并答复第 ${index} 项不是布尔值`)
    return value
  })
}
