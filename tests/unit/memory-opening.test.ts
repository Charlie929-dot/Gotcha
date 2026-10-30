/**
 * 个人记忆 · 开场（D61）：拆关键词 + 「此刻」事实段
 *
 * 拍板人 2026-10-29 深夜七：人味不靠「你是独立的人」这种宣言，
 * 靠处境事实——此刻几点、今天说过几句、上次多久前、日记记到哪天。
 * 这些必须**可预测**（确定性规则，不随机、不调模型），用户才能感知因果。
 */

import { describe, expect, it } from 'vitest'

import { buildSituation, formatGap, localDayKey, splitRecallKeywords } from '../../src/memory/opening'

/** 2026-10-29 23:40（周四） */
const NOW = new Date(2026, 9, 29, 23, 40, 0, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('splitRecallKeywords', () => {
  it('中文取两字词，丢掉「今天」「什么」这类虚词', () => {
    const words = splitRecallKeywords('今天下午那个编译错误怎么解决的')
    expect(words).toContain('编译')
    expect(words).toContain('译错')
    expect(words).toContain('错误')
    expect(words).not.toContain('今天')
    expect(words).not.toContain('那个')
    expect(words).not.toContain('什么')
  })

  it('英文 / 数字整词保留（小写），短于两个字符不取', () => {
    expect(splitRecallKeywords('LNK1104 和 v0.3 的问题')).toEqual(
      expect.arrayContaining(['lnk1104', 'v0.3'])
    )
  })

  it('去重、最多 8 个（recallMemory 也只认 8 个）', () => {
    const words = splitRecallKeywords('编译错误链接设置抽屉菜单端口缓存索引', 8)
    expect(words).toHaveLength(8)
    expect(new Set(words).size).toBe(words.length)
    expect(splitRecallKeywords('设置 设置')).toEqual(['设置'])
  })

  it('没有可用的词就返回空数组（不拿空查询扫整库）', () => {
    expect(splitRecallKeywords('在吗？')).toEqual([])
    expect(splitRecallKeywords('   ')).toEqual([])
  })
})

describe('formatGap', () => {
  it('刚刚 / 分钟 / 小时 / 天', () => {
    expect(formatGap(20_000)).toBe('刚刚')
    expect(formatGap(5 * MINUTE)).toBe('5 分钟前')
    expect(formatGap(2 * HOUR)).toBe('2 小时前')
    expect(formatGap(50 * HOUR)).toBe('2 天前')
  })
})

describe('buildSituation', () => {
  it('今天说过几句 + 上次间隔 + 日记日期（全部是本地事实）', () => {
    const facts = buildSituation({
      now: NOW,
      talkTimes: [NOW - 2 * HOUR, NOW - 30 * MINUTE, NOW - 26 * HOUR],
      lastDiaryDay: '2026-10-28'
    })
    expect(facts).toContain('现在是 2026-10-29 23:40 周四')
    expect(facts).toContain('今天你们说过 2 句话')
    expect(facts).toContain('上次说话是 30 分钟前')
    expect(facts).toContain('他的日记记到 2026-10-28（1 天前）')
  })

  it('今天还没说话 / 日记是今天的：说法不重复也不冒充', () => {
    const facts = buildSituation({ now: NOW, talkTimes: [NOW - 26 * HOUR], lastDiaryDay: '2026-10-29' })
    expect(facts).toContain('今天你们还没说过话')
    expect(facts).toContain('他的日记记到今天')
  })

  it('没有任何历史：不编造「上次」', () => {
    const facts = buildSituation({ now: NOW, talkTimes: [], lastDiaryDay: null })
    expect(facts).toContain('今天你们还没说过话')
    expect(facts).toContain('他还没写过日记')
    expect(facts).not.toContain('上次说话')
  })

  it('月份 / 日期补零，和日记 day_key 同形', () => {
    expect(localDayKey(new Date(2026, 0, 5, 8, 0).getTime())).toBe('2026-01-05')
  })
})
