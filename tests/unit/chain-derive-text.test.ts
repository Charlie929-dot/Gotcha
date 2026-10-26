import { describe, expect, it } from 'vitest'
import {
  buildDeriveText,
  deriveTextHash,
  MAX_DERIVE_TEXT_CHARS,
  normalizeLine
} from '../../src/chain/derive/text'

describe('normalizeLine', () => {
  it('连续空白折成一个空格并去首尾空白', () => {
    expect(normalizeLine('  记忆球\t\t记忆  \r')).toBe('记忆球 记忆')
    expect(normalizeLine('   ')).toBe('')
  })
})

describe('buildDeriveText', () => {
  it('跨多次读取的重复行只留一份，顺序按第一次出现', () => {
    const result = buildDeriveText([
      { text: '标题 A\n最小化\n关闭' },
      { text: '标题 A\n最小化\n侧边栏' }
    ])
    expect(result.text).toBe('标题 A\n最小化\n关闭\n侧边栏')
    expect(result.droppedLines).toBe(2)
    // rawChars 与 keptChars 同口径（每行算行 + 换行）：5+4+3 + 5+4+4 - 最后一个换行 = 24
    expect(result.rawChars).toBe(24)
  })

  it('空白差异视为同一行（UIA 每次缩进 / 空白不同）', () => {
    const result = buildDeriveText([{ text: '  新建会话\n全局面板  ' }, { text: '新建会话\n全局面板' }])
    expect(result.text).toBe('新建会话\n全局面板')
    expect(result.droppedLines).toBe(2)
  })

  it('空输入得到空正文与空串指纹', () => {
    const result = buildDeriveText([])
    expect(result).toMatchObject({ text: '', hash: deriveTextHash(''), truncated: false, droppedLines: 0 })
    expect(buildDeriveText([{ text: '\n \n' }]).text).toBe('')
  })

  it('超过上限就截断并标 truncated；上限之外的滚动内容不改变指纹', () => {
    const head = 'a'.repeat(50)
    const short = buildDeriveText([{ text: `${head}\n1` }], { maxChars: 52 })
    const long = buildDeriveText([{ text: `${head}\n1\n2\n3\n4` }], { maxChars: 52 })
    expect(short.truncated).toBe(false)
    expect(long.truncated).toBe(true)
    expect(long.text).toBe(`${head}\n1`)
    expect(long.keptChars).toBe(52)
    expect(long.hash).toBe(short.hash)
  })

  it('上限之内的变化会改变指纹（换页 / 换话题要重抽）', () => {
    const a = buildDeriveText([{ text: '第一页\n内容' }])
    const b = buildDeriveText([{ text: '第二页\n内容' }])
    expect(a.hash).not.toBe(b.hash)
  })

  it('默认上限是 6000 字，且不会把续行切出半截另算', () => {
    const result = buildDeriveText([{ text: 'x'.repeat(MAX_DERIVE_TEXT_CHARS + 100) }])
    expect(result.text.length).toBe(MAX_DERIVE_TEXT_CHARS)
    expect(result.truncated).toBe(true)
  })
})
