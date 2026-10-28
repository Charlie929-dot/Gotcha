import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/db'
import { closeSegment, insertContent, openSegment } from '../../src/chain/store'
import { ensureChainSchema } from '../../src/chain/schema'
import { createAskToolExecutor } from '../../src/chain/agent/tools'

const AT = (minute: number): number => new Date(2026, 9, 28, 10, minute, 0, 0).getTime()

function segment(db: Db, app: string, texts: readonly string[], minute = 0): number {
  const start = AT(minute)
  const title = `${app} 标题`
  const id = openSegment(db, { startTs: start, app, exe: `${app}.exe`, pid: 1, hwnd: 1, title }, start)
  texts.forEach((text, index) => {
    insertContent(db, { segmentId: id, capturedAt: start + index * 1_000, source: 'uia', text })
  })
  closeSegment(db, id, {
    startTs: start,
    endTs: start + texts.length * 1_000,
    activeMs: texts.length * 1_000,
    idleMs: 0,
    pid: 1,
    exe: `${app}.exe`,
    app,
    hwnd: 1,
    titleFirst: title,
    titleLast: title
  })
  return id
}

async function search(
  db: Db,
  args: Record<string, unknown>
): Promise<Array<{ segmentId: number; snippet: string; urls: string[] }>> {
  const executor = createAskToolExecutor({ db, now: () => AT(59), captureRunning: () => false })
  const outcome = await executor.execute({ name: 'search_info', arguments: args })
  const result = outcome.result as {
    kind: string
    message?: string
    hits?: Array<{ segmentId: number; snippet: string; urls: string[] }>
  }
  if (result.kind !== 'search_info') throw new Error(`search_info 返回 ${result.kind}：${result.message ?? ''}`)
  return result.hits ?? []
}

describe('search_info 段详情（P1-6：读 urls 列 + 只取最长正文开头）', () => {
  it('兜底摘要取「最长那条正文」的前 80 字，不是第一行', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureChainSchema(db)
      const short = '第一行很短'
      const long = `${'长正文 '.repeat(40)}结尾`
      const id = segment(db, 'Code', [short, long])

      const hits = await search(db, { app: 'Code', limit: 5 })
      const hit = hits.find((item) => item.segmentId === id)
      expect(hit).toBeTruthy()
      // 兜底摘要 = 最长那行压缩空白后前 80 字
      expect(hit!.snippet).toBe(long.replace(/\s+/g, ' ').trim().slice(0, 80))
      expect(hit!.snippet.startsWith('长正文')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('网址来自任意一条正文（不要求是最长那条），按内容时间去重、最多 3 条', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureChainSchema(db)
      const id = segment(db, 'Firefox', [
        '菜单栏 帮助 https://a.test/first',
        `${'很长的正文 '.repeat(60)}地址栏 https://b.test/second`,
        '再看 https://a.test/first 与 https://c.test/third 与 https://d.test/fourth'
      ])

      const hits = await search(db, { app: 'Firefox', limit: 5 })
      const hit = hits.find((item) => item.segmentId === id)
      expect(hit?.urls).toEqual([
        'https://a.test/first',
        'https://b.test/second',
        'https://c.test/third'
      ])
    } finally {
      db.close()
    }
  })

  it('没有正文的段：snippet 空串、urls 空数组（不抛错、不编造）', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureChainSchema(db)
      const start = AT(10)
      const id = openSegment(
        db,
        { startTs: start, app: 'WeChat', exe: 'wechat.exe', pid: 1, hwnd: 1, title: '微信' },
        start
      )
      closeSegment(db, id, {
        startTs: start,
        endTs: start + 1_000,
        activeMs: 1_000,
        idleMs: 0,
        pid: 1,
        exe: 'wechat.exe',
        app: 'WeChat',
        hwnd: 1,
        titleFirst: '微信',
        titleLast: '微信'
      })

      const hits = await search(db, { app: 'WeChat', limit: 5 })
      const hit = hits.find((item) => item.segmentId === id)
      expect(hit).toBeTruthy()
      expect(hit!.snippet).toBe('')
      expect(hit!.urls).toEqual([])
    } finally {
      db.close()
    }
  })

  it('有关键词摘要时不再走兜底（snippet 是命中上下文，不是最长行开头）', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureChainSchema(db)
      segment(db, 'Code', [`${'填充文字 '.repeat(20)}插件市场里有 dsh-market 条目`], 20)

      const hits = await search(db, { keywords: ['插件市场'], limit: 5 })
      const hit = hits[0]
      expect(hit.snippet).toContain('插件市场')
      expect(hit.snippet.length).toBeLessThanOrEqual(80)
    } finally {
      db.close()
    }
  })
})
