import { describe, expect, it } from 'vitest'
import {
  bestMatch,
  cosineSimilarity,
  mergeBand,
  MERGE_ASK_SIM,
  MERGE_AUTO_SIM,
  nameKey,
  normalizeName
} from '../../src/chain/derive/names'

describe('normalizeName', () => {
  it('去首尾空白、折叠内部空白', () => {
    expect(normalizeName('  记忆球   记忆 ')).toBe('记忆球 记忆')
  })

  it('剥掉两侧的引号 / 括号 / 标点（可能叠好几层）', () => {
    expect(normalizeName('「记忆球」')).toBe('记忆球')
    expect(normalizeName('（“Hindsight”）')).toBe('Hindsight')
    expect(normalizeName('**bge-small-zh-v1.5**')).toBe('bge-small-zh-v1.5')
  })

  it('不误伤名字里的 C++ / C# / AT&T 这类符号', () => {
    expect(normalizeName('C++')).toBe('C++')
    expect(normalizeName('C#')).toBe('C#')
    expect(normalizeName('AT&T')).toBe('AT&T')
  })
})

describe('nameKey', () => {
  it('大小写与空白不参与匹配', () => {
    expect(nameKey('DeepSeek Harness')).toBe(nameKey('deepseekharness'))
    expect(nameKey('  DeepSeek  Harness ')).toBe(nameKey('DeepSeek Harness'))
  })
})

describe('cosineSimilarity', () => {
  it('同向为 1、正交为 0、零向量为 0、长度不等为 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0)
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0)
    expect(cosineSimilarity(new Float32Array([1]), new Float32Array([1, 0]))).toBe(0)
  })
})

describe('mergeBand', () => {
  it('≥0.95 复用、0.90–0.95 问模型、<0.90 新建（没有相似度也新建）', () => {
    expect(mergeBand(1)).toBe('reuse')
    expect(mergeBand(MERGE_AUTO_SIM)).toBe('reuse')
    expect(mergeBand(MERGE_AUTO_SIM - 0.001)).toBe('ask')
    expect(mergeBand(MERGE_ASK_SIM)).toBe('ask')
    expect(mergeBand(MERGE_ASK_SIM - 0.001)).toBe('new')
    expect(mergeBand(null)).toBe('new')
    expect(mergeBand(Number.NaN)).toBe('new')
  })
})

describe('bestMatch', () => {
  it('挑出最像的已有名字；没有候选返回 null', () => {
    const entries = [
      { name: '记忆球', vec: new Float32Array([0, 1]) },
      { name: '信息链', vec: new Float32Array([1, 0]) }
    ]
    expect(bestMatch(new Float32Array([0.99, 0.01]), entries)).toMatchObject({ name: '信息链' })
    expect(bestMatch(new Float32Array([0.01, 0.99]), entries)).toMatchObject({ name: '记忆球' })
    expect(bestMatch(new Float32Array([1, 0]), [])).toBeNull()
  })
})
