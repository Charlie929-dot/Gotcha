/**
 * 信息链正文里的网址抽取（性能方案 P1-6）
 *
 * 为什么单独成一个模块：同一套规则要在三处保持一字不差——
 * 1. 写入时（`insertContent`）把抽到的网址落到 `chain_content.urls`；
 * 2. 老库迁移（chain v4）按同一规则回填；
 * 3. `search_info` 的兜底摘要仍可对内存里的正文直接抽（`collectUrls`）。
 *
 * 为什么要落列：`search_info` 以前对每条命中的段都 `getSegmentDetail()` 取整段正文，
 * 只为两件事——80 字兜底摘要、以及扫网址；实测 limit 8 时要搬 2.3 MB 正文、
 * 在 2.3 MB 上跑正则（19.2 ms，其中大半是正则与字符串构造）。
 * 网址是纯派生数据（正文改了网址必然重算），落列后读路径只剩几十字节。
 *
 * 口径（在改造前 `tools.ts` 的 `extractUrls` 基础上补了一条）：
 * - 只认 `http(s)://` 开头、非空白 / 引号 / 尖括号 / 中文括号 / **中文标点**的连续串；
 *   中文标点不可能出现在合法 URL 里（未编码），不排除的话中文正文里「http://x，再一个」
 *   会把后文一起吞进网址；
 * - 去掉结尾的 ASCII 句读（`.` `,` `;` `:` `!` `?`）；
 * - 长度 < 10 当作不是真网址，> 400 当作 base64 垃圾；
 * - 跨正文行按顺序去重，最多 3 条。
 */

/** 一条正文最多带几个网址（跨行合计） */
export const CONTENT_URLS_MAX = 3
/** 单个网址的最大长度：超长多半是 base64 垃圾 */
export const CONTENT_URL_MAX_CHARS = 400
/** 太短的不是真网址（`http://a` 这种） */
export const CONTENT_URL_MIN_CHARS = 10

const URL_RE = /https?:\/\/[^\s"'<>（）【】。，、；：！？「」《》]+/g

/** 从一段正文里按顺序收集网址（去重、限量、限长）；`into` 可跨多段正文累计 */
export function collectUrls(texts: Iterable<string | null | undefined>, into: string[] = []): string[] {
  const urls = into
  for (const text of texts) {
    if (!text) continue
    for (const match of text.matchAll(URL_RE)) {
      if (urls.length >= CONTENT_URLS_MAX) return urls
      const url = match[0].replace(/[.,;:!?]+$/, '')
      if (url.length < CONTENT_URL_MIN_CHARS || url.length > CONTENT_URL_MAX_CHARS) continue
      if (!urls.includes(url)) urls.push(url)
    }
  }
  return urls
}

/** 存库形态：JSON 数组（空数组也存 `[]`，方便读路径统一解析） */
export function encodeContentUrls(urls: readonly string[]): string {
  return JSON.stringify(urls.slice(0, CONTENT_URLS_MAX))
}

/** 读库形态：坏 JSON / 非字符串项一律丢掉（派生数据不值得让查询失败） */
export function decodeContentUrls(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string' && item !== '')
      .slice(0, CONTENT_URLS_MAX)
  } catch {
    return []
  }
}

/** 写入 / 迁移用：正文 → 存库形态（先做一次 `includes` 粗筛，整段正则只在含 http 时跑） */
export function contentUrlsOf(text: string): string {
  if (!text || !text.includes('http')) return '[]'
  return encodeContentUrls(collectUrls([text]))
}
