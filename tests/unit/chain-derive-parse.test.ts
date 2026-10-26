import { describe, expect, it } from 'vitest'
import {
  collectNames,
  DeriveParseError,
  LINK_MAX_CHARS,
  MAX_LINKS,
  MAX_TAGS,
  parseExtractResult,
  parseMergeResult,
  TAG_MAX_CHARS
} from '../../src/chain/derive/parse'

describe('collectNames', () => {
  it('丢掉非字符串与空白，按上限截断，按小写键去重', () => {
    expect(collectNames(['  记忆球 ', '记忆球', 'Hindsight', 42, '', null], 40, 8)).toEqual([
      '记忆球',
      'Hindsight'
    ])
    expect(collectNames(['a'.repeat(60)], 10, 8)).toEqual(['a'.repeat(10)])
  })

  it('只收前 max 个（保留出现顺序）', () => {
    const names = collectNames(['a', 'b', 'c', 'd'], 10, 2)
    expect(names).toEqual(['a', 'b'])
  })

  it('非数组当空', () => {
    expect(collectNames('记忆球', 10, 8)).toEqual([])
  })
})

describe('parseExtractResult', () => {
  it('收下 tags / links，并按各自上限裁剪', () => {
    const result = parseExtractResult({
      tags: Array.from({ length: MAX_TAGS + 3 }, (_, index) => `标签${index}`),
      links: Array.from({ length: MAX_LINKS + 3 }, (_, index) => `链接${index}`)
    })
    expect(result.tags).toHaveLength(MAX_TAGS)
    expect(result.links).toHaveLength(MAX_LINKS)
  })

  it('只有一个数组也算合法（模型可能只抽到标签）', () => {
    expect(parseExtractResult({ tags: ['记忆球'] })).toEqual({ tags: ['记忆球'], links: [] })
    expect(parseExtractResult({ links: ['Hindsight'] })).toEqual({ tags: [], links: ['Hindsight'] })
  })

  it('两个数组都没有 / 不是对象 → 结构非法（不能当空结果写库）', () => {
    expect(() => parseExtractResult({})).toThrow(DeriveParseError)
    expect(() => parseExtractResult({ tags: '记忆球' })).toThrow(/既没有 tags 也没有 links/)
    expect(() => parseExtractResult(null)).toThrow(/不是对象/)
    expect(() => parseExtractResult(['记忆球'])).toThrow(/不是对象/)
  })

  it('超长名字被截断而不是整条丢弃', () => {
    const result = parseExtractResult({ tags: ['x'.repeat(100)], links: ['y'.repeat(100)] })
    expect(result.tags[0]).toHaveLength(TAG_MAX_CHARS)
    expect(result.links[0]).toHaveLength(LINK_MAX_CHARS)
  })
})

describe('parseMergeResult', () => {
  it('按顺序返回布尔判定', () => {
    expect(parseMergeResult({ same: [true, false, true] }, 3)).toEqual([true, false, true])
  })

  it('长度不一致 / 非布尔 / 缺 same → 整批作废', () => {
    expect(() => parseMergeResult({ same: [true] }, 2)).toThrow(/长度/)
    expect(() => parseMergeResult({ same: ['yes'] }, 1)).toThrow(/不是布尔值/)
    expect(() => parseMergeResult({}, 1)).toThrow(/缺少 same/)
    expect(() => parseMergeResult(null, 1)).toThrow(/不是对象/)
  })
})
