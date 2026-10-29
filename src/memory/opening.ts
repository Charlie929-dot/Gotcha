/**
 * 个人记忆 · 开场（新对话第一问）
 *
 * 2026-10-29 深夜七（D61，拍板人「重新做人味……不要直接和他说」）：
 * 不再用提示词告诉 ta「你是独立的人」；只给它事实——
 * 此刻几点、今天说过几句、上次说话多久前、日记记到哪天，以及按问题想到的几条日记。
 *
 * 联想不是证据：想核对仍要自己 `recall_diary` / `read_diary`（引用只由「真的打开过」生成）。
 * 本模块是纯函数：时间由调用方注入，历史由调用方读好；不碰库、不调模型、不读配置。
 */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

/**
 * 拆关键词时丢掉的中文两字虚词 / 疑问词。
 * 不丢的话「今天」「什么」「可以」这种词会把整库都当命中；宁可少想，不要瞎想。
 */
const NOISE_BIGRAMS = new Set([
  '我们',
  '你们',
  '他们',
  '她们',
  '它们',
  '什么',
  '怎么',
  '这个',
  '那个',
  '一个',
  '一下',
  '不是',
  '就是',
  '可以',
  '没有',
  '还是',
  '现在',
  '今天',
  '昨晚',
  '昨天',
  '明天',
  '最近',
  '然后',
  '因为',
  '所以',
  '但是',
  '如果',
  '时候',
  '觉得',
  '知道',
  '帮我',
  '我的',
  '你的',
  '他的',
  '她的',
  '请问',
  '麻烦',
  '告诉',
  '看看',
  '说说',
  '记得',
  '在吗',
  '你好',
  '谢谢',
  '再见',
  '没事',
  '好的'
])

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日键 `yyyy-mm-dd`（和日记的 day_key 同形） */
export function localDayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 把一句问题拆成日记检索的关键词（纯本地，够用就好）。
 *
 * - 英文 / 数字整词；
 * - 连续汉字取两字词（`有点累` → `有点` / `点累`），丢掉 `今天` `什么` 这类虚词；
 * - 去重、最多 `max` 个（`recallMemory` 本身也只认 8 个）。
 *
 * 这些词只用来「想起点什么」，不当作证据；想歪了就让它自己再查。
 */
export function splitRecallKeywords(question: string, max = 8): string[] {
  const terms: string[] = []
  const push = (term: string): boolean => {
    const value = term.trim().toLowerCase()
    if (value === '' || terms.includes(value)) return false
    terms.push(value)
    return terms.length >= max
  }
  for (const word of question.match(/[A-Za-z][A-Za-z0-9+#._-]{1,}/gu) ?? []) {
    if (push(word)) return terms
  }
  for (const run of question.match(/[\u3400-\u9fff]+/gu) ?? []) {
    if (run.length < 2) continue
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (NOISE_BIGRAMS.has(bigram)) continue
      if (push(bigram)) return terms
    }
  }
  return terms
}

/** 时间间隔 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」 */
export function formatGap(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function dayStart(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `yyyy-mm-dd` 距 now 多少天（本地日界；解析不了返回 null） */
function daysSinceDayKey(dayKey: string, now: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim())
  if (!match) return null
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  if (!Number.isFinite(start)) return null
  return Math.max(0, Math.round((dayStart(now) - start) / 86_400_000))
}

export interface SituationInput {
  /** 当前时间（测试注入固定钟） */
  now: number
  /** 历史提问时刻（毫秒；顺序随意，含今天以前的也行） */
  talkTimes: readonly number[]
  /** 日记最后一天（`yyyy-mm-dd`；null = 还没同步到日记） */
  lastDiaryDay: string | null
}

/**
 * 「此刻」事实：一两句话，只写能核对的东西，不写「你现在心情不错」这类判断。
 * 心情让它自己从事实里长——写成判断就变成演。
 */
export function buildSituation(input: SituationInput): string {
  const now = input.now
  const date = new Date(now)
  const today = localDayKey(now)
  const talkTimes = input.talkTimes.filter((ts) => Number.isFinite(ts))
  const todayTalks = talkTimes.filter((ts) => localDayKey(ts) === today).length
  const lastTalk = talkTimes.reduce<number | null>(
    (best, ts) => (best === null || ts > best ? ts : best),
    null
  )

  const parts = [`现在是 ${today} ${pad2(date.getHours())}:${pad2(date.getMinutes())} 周${WEEKDAYS[date.getDay()]}`]
  parts.push(todayTalks === 0 ? '今天你们还没说过话' : `今天你们说过 ${todayTalks} 句话`)
  if (lastTalk !== null && lastTalk <= now) {
    parts.push(`上次说话是 ${formatGap(now - lastTalk)}`)
  }

  const lastDiaryDay = input.lastDiaryDay?.trim() ?? ''
  if (lastDiaryDay === '') {
    parts.push('他还没写过日记')
  } else {
    const days = daysSinceDayKey(lastDiaryDay, now)
    if (days === null) parts.push(`他的日记记到 ${lastDiaryDay}`)
    else if (days === 0) parts.push('他的日记记到今天')
    else parts.push(`他的日记记到 ${lastDiaryDay}（${days} 天前）`)
  }
  return `${parts.join('；')}。`
}
