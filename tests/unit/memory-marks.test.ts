/**
 * 个人记忆 · 作者标记解析（marks.ts）
 *
 * 这一层的每个断言都对应一个会被写进用户日记的错误，所以宁可写细：
 * 1）行尾裸 ❤️ 是用户的聊天习惯，不能把用户的话算成 ta 的；
 * 2）`[❤️]()` 空评论才是「ta 自己写的这一行」，和 `[❤️](正文)` 是同一个解析器、不同语义；
 * 3）评论 / 回复的顺序就是线程顺序，`[💬]` 没有前置评论时算独立留言；
 * 4）正文里有 `)` 得按 `<...>` 包裹，未包裹的成对括号也不能提前截断。
 */

import { describe, expect, it } from 'vitest'

import {
  TA_MARK,
  formatComment,
  formatReply,
  markAsTaLine,
  parseMarks,
  stripMarks,
  unmark
} from '../../src/memory/marks'

describe('parseMarks · 作者判定', () => {
  it('没有标记 = 用户写的', () => {
    const parsed = parseMarks('- 08:40 今天早上有点困，昨晚没睡好。')
    expect(parsed.author).toBe('user')
    expect(parsed.hasMark).toBe(false)
    expect(parsed.body).toBe('- 08:40 今天早上有点困，昨晚没睡好。')
  })

  it('行尾裸 ❤️ 不算标记（用户顺手打的）', () => {
    const parsed = parseMarks('- 23:10 今天总算把周报写完了 ❤️')
    expect(parsed.author).toBe('user')
    expect(parsed.hasMark).toBe(false)
    expect(parsed.comments).toEqual([])
  })

  it('行尾 [❤️]() 空评论 = ta 自己写的行', () => {
    const parsed = parseMarks('- 23:30 今天你大部分时间都在改记忆球。 [❤️]()')
    expect(parsed.author).toBe('ta')
    expect(parsed.body).toBe('- 23:30 今天你大部分时间都在改记忆球。')
    expect(parsed.comments).toEqual([])
    expect(parsed.hasMark).toBe(true)
  })

  it('多句合并成一条时，末尾的空评论仍判 ta', () => {
    const parsed = parseMarks(
      '- 23:30 今天你大部分时间都在改记忆球。 [❤️]() 下午有一阵子盯着设置抽屉发呆，我猜你累了。 [❤️]()'
    )
    expect(parsed.author).toBe('ta')
    expect(parsed.body).toContain('盯着设置抽屉发呆')
    expect(parsed.comments).toEqual([])
  })

  it('带正文的 [❤️](…) 是评论，不能把用户的行改成 ta 的', () => {
    const parsed = parseMarks('- 08:40 今天早上有点困。[❤️](那就别硬撑，午休二十分钟？)')
    expect(parsed.author).toBe('user')
    expect(parsed.comments).toEqual(['那就别硬撑，午休二十分钟？'])
    expect(parsed.body).toBe('- 08:40 今天早上有点困。')
  })
})

describe('parseMarks · 线程', () => {
  it('评论后面紧跟的 [💬] 是回复', () => {
    const parsed = parseMarks(
      '- 08:40 今天早上有点困。[❤️](那就别硬撑，午休二十分钟？)[💬](好，我中午睡。)'
    )
    expect(parsed.replies).toEqual(['好，我中午睡。'])
    expect(parsed.thread).toEqual([
      { comment: '那就别硬撑，午休二十分钟？', replies: ['好，我中午睡。'] }
    ])
    expect(parsed.looseReplies).toEqual([])
  })

  it('多条评论按出现顺序构成线程，回复挂到各自评论下', () => {
    const parsed = parseMarks('[❤️](第一条)[💬](回一)[❤️](第二条)[💬](回二)')
    expect(parsed.thread).toEqual([
      { comment: '第一条', replies: ['回一'] },
      { comment: '第二条', replies: ['回二'] }
    ])
  })

  it('没有前置评论的 [💬] 是独立留言', () => {
    const parsed = parseMarks('- 21:00 今天想早点睡 [💬](晚安)')
    expect(parsed.thread).toEqual([])
    expect(parsed.looseReplies).toEqual(['晚安'])
  })

  it('空评论不进线程（它只是作者标记）', () => {
    const parsed = parseMarks('- 23:30 我写的一行 [❤️]()')
    expect(parsed.thread).toEqual([])
    expect(parsed.comments).toEqual([])
  })
})

describe('parseMarks · 正文边界', () => {
  it('<...> 包裹的正文可以带 )', () => {
    const parsed = parseMarks('- 09:00 今天开会（迟到五分钟）。[❤️](<下次记得早出门(比如提前十分钟)>)')
    expect(parsed.comments).toEqual(['下次记得早出门(比如提前十分钟)'])
    expect(parsed.body).toBe('- 09:00 今天开会（迟到五分钟）。')
  })

  it('未包裹的成对括号不会被提前截断', () => {
    const parsed = parseMarks('[❤️](正文(笑))')
    expect(parsed.comments).toEqual(['正文(笑)'])
  })

  it('没闭合的标记按普通文字保留，不吞掉后文', () => {
    const parsed = parseMarks('- 09:00 写了一半 [❤️](没闭合')
    expect(parsed.hasMark).toBe(false)
    expect(parsed.body).toContain('没闭合')
  })
})

describe('stripMarks / unmark / 格式化', () => {
  const line = '- 08:40 今天早上有点困。[❤️](那就别硬撑)[💬](好)'

  it('stripMarks 只留这一行的正文', () => {
    expect(stripMarks(line)).toBe('- 08:40 今天早上有点困。')
  })

  it('unmark 去掉标记外壳但保留评论 / 回复正文（检索用）', () => {
    expect(unmark(line)).toBe('- 08:40 今天早上有点困。 那就别硬撑 好')
  })

  it('formatComment 在正文含 ) 时自动包 <...>', () => {
    expect(formatComment('午休二十分钟？')).toBe('[❤️](午休二十分钟？)')
    expect(formatComment('早点睡(比如 23 点)')).toBe('[❤️](<早点睡(比如 23 点)>)')
    expect(() => formatComment('   ')).toThrow(/不能为空/u)
  })

  it('formatReply 同样包裹，空正文报错', () => {
    expect(formatReply('好，我中午睡。')).toBe('[💬](好，我中午睡。)')
    expect(() => formatReply('')).toThrow(/不能为空/u)
  })

  it('markAsTaLine 幂等（不重复打标）', () => {
    const once = markAsTaLine('- 23:30 今天在改记忆球。')
    expect(once).toBe(`- 23:30 今天在改记忆球。 ${TA_MARK}`)
    expect(markAsTaLine(once)).toBe(once)
  })
})
