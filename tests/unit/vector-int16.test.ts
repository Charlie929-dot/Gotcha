import { describe, expect, it } from 'vitest'
import {
  INT16_VECTOR_HEADER_BYTES,
  decodeEmbeddingVector,
  decodeVectorInt16,
  encodeVectorFloat32,
  encodeVectorInt16,
  isInt16Vector
} from '../../src/understand/vector-int16'

/** 构造一个 512 维、L2 归一化的假向量（与真实 embedding 同量级） */
function unitVector(dim: number, seed = 1): Float32Array {
  const out = new Float32Array(dim)
  let state = seed
  let norm = 0
  for (let i = 0; i < dim; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const value = state / 0x7fffffff - 0.5
    out[i] = value
    norm += value * value
  }
  const scale = Math.sqrt(norm)
  for (let i = 0; i < dim; i += 1) out[i] /= scale
  return out
}

describe('vector-int16', () => {
  it('512 维往返：每维误差 < 1e-4，长度 = dim*2+8', () => {
    const vec = unitVector(512)
    const blob = encodeVectorInt16(vec)
    expect(blob.byteLength).toBe(INT16_VECTOR_HEADER_BYTES + 512 * 2)
    expect(isInt16Vector(blob, 512)).toBe(true)

    const back = decodeVectorInt16(blob)
    expect(back.length).toBe(512)
    for (let i = 0; i < vec.length; i += 1) expect(Math.abs(back[i] - vec[i])).toBeLessThan(1e-4)
  })

  it('cos 相似度基本不变（> 0.9999）', () => {
    const a = unitVector(512, 7)
    const b = unitVector(512, 11)
    const dot = (x: Float32Array, y: Float32Array): number => {
      let sum = 0
      for (let i = 0; i < x.length; i += 1) sum += x[i] * y[i]
      return sum
    }
    const before = dot(a, b)
    const after = dot(decodeVectorInt16(encodeVectorInt16(a)), decodeVectorInt16(encodeVectorInt16(b)))
    expect(after).toBeCloseTo(before, 4)
    expect(Math.abs(after - before)).toBeLessThan(1e-3)
  })

  it('全零向量不除零：编码后解码仍是全零', () => {
    const blob = encodeVectorInt16(new Float32Array(8))
    expect(decodeVectorInt16(blob).every((value) => value === 0)).toBe(true)
  })

  it('兼容老行：Float32 BLOB 仍按 dim*4 解码', () => {
    const vec = Float32Array.from([0.5, -0.25, 0.125, 0])
    const blob = encodeVectorFloat32(vec)
    expect(isInt16Vector(blob, 4)).toBe(false)
    expect([...decodeEmbeddingVector(blob, 4)]).toEqual([...vec])
  })

  it('长度对不上时返回空数组（调用方按 skipped 计）', () => {
    expect(decodeEmbeddingVector(Buffer.alloc(4), 9).length).toBe(0)
    expect(decodeVectorInt16(Buffer.alloc(9)).length).toBe(0)
    // 魔数不对的 int16 长度 BLOB 也按老格式处理（长度对不上 dim*4 → 空）
    const fake = Buffer.alloc(INT16_VECTOR_HEADER_BYTES + 6)
    expect(isInt16Vector(fake, 3)).toBe(false)
    expect(decodeEmbeddingVector(fake, 3).length).toBe(0)
  })

  it('NaN / Infinity 当 0 处理，不污染尺度', () => {
    const vec = Float32Array.from([0.5, Number.NaN, Number.POSITIVE_INFINITY, -0.5])
    const back = decodeVectorInt16(encodeVectorInt16(vec))
    expect(back[1]).toBe(0)
    expect(back[2]).toBe(0)
    expect(back[0]).toBeCloseTo(0.5, 4)
    expect(back[3]).toBeCloseTo(-0.5, 4)
  })
})
