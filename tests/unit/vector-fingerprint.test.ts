import { describe, expect, it } from 'vitest'
import { eventIdsFingerprint, stableFingerprint } from '../../src/understand/vector-fingerprint'

describe('stableFingerprint', () => {
  it('同一个输入永远同一个值；不同输入不同值', () => {
    expect(stableFingerprint('主题一。摘要一')).toBe(stableFingerprint('主题一。摘要一'))
    expect(stableFingerprint('主题一。摘要一')).toMatch(/^[0-9a-f]{16}$/)
    expect(stableFingerprint('主题一。摘要一')).not.toBe(stableFingerprint('主题一。摘要一，变长了'))
    expect(stableFingerprint('')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('同前缀不同长度不会撞车（种子混入长度）', () => {
    expect(stableFingerprint('abc')).not.toBe(stableFingerprint('abcabc'))
  })
})

describe('eventIdsFingerprint', () => {
  it('顺序无关；去重后计算', () => {
    expect(eventIdsFingerprint([3, 1, 2])).toBe(eventIdsFingerprint([1, 2, 3]))
    expect(eventIdsFingerprint([1, 1, 2, 3])).toBe(eventIdsFingerprint([3, 2, 1]))
  })

  it('集合变了指纹就变；坏值（非正整数）忽略', () => {
    expect(eventIdsFingerprint([1, 2, 3])).not.toBe(eventIdsFingerprint([1, 2, 4]))
    expect(eventIdsFingerprint([1, 2, 3])).toBe(eventIdsFingerprint([1, 2, 3, 0, -1, 2.5]))
    expect(eventIdsFingerprint([])).toMatch(/^[0-9a-f]{16}$/)
  })
})
