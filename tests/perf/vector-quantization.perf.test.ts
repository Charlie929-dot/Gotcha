/**
 * P1-3 选型：`event_embeddings` 的 512 维向量压到 int8 还是 int16？（真实库只读）
 *
 * 只做三件事：
 * 1. 现状体积：行数 × BLOB 字节，以及 int8 / int16 的投影体积；
 * 2. 余弦误差：随机取若干向量对，比较 float32 余弦与量化后反量化余弦的差（绝对值分布）；
 * 3. top-1 一致性：随机抽若干个向量，在**全量**里找最近邻，比较量化前后的第一名是否同一个
 *    （主题质心 / 次归属的判定依赖 top-1 与 top-2 的 gap，所以这条比余弦误差更关键）。
 *
 * 结论（2026-10-28，15,567 条真实向量）：
 * - int8：余弦误差 p50 6.2e-4，但 top-1 只有 **96.7%** 一致——同一屏的向量本来就互为近重复，
 *   top1/top2 的 gap 与量化误差同量级，翻盘会让归属/连线抖动 → **不采用**；
 * - int16：top-1 **100%**，BLOB 2048 → 1028 B，表 61 → 20.4 MB
 *   （1 KB 的行能整行放进 4 KB 页，溢出页消失；见 vector-int16.perf.test.ts）。
 *
 * 用例断言的就是这条门槛：int16 的 top-1 ≥ 99%（int8 达不到，所以这里只断言 int16）。
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/vector-quantization.perf.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const userData = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const hasDb = existsSync(dbPath)

function decodeVector(blob: Buffer): Float32Array {
  const length = Math.floor(blob.byteLength / 4)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) out[i] = blob.readFloatLE(i * 4)
  return out
}

/** absmax 对称量化：value / scale 取整到 [-127, 127]，scale = max|v| / 127 */
function quantize(vec: Float32Array): { bytes: Buffer; scale: number } {
  let max = 0
  for (const value of vec) max = Math.max(max, Math.abs(value))
  const scale = max > 0 ? max / 127 : 1
  const bytes = Buffer.alloc(vec.length)
  for (let i = 0; i < vec.length; i += 1) {
    const q = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)))
    bytes.writeInt8(q, i)
  }
  return { bytes, scale }
}

function dequantize(bytes: Buffer, scale: number): Float32Array {
  const out = new Float32Array(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes.readInt8(i) * scale
  return out
}

/** int16 absmax 对称量化：value / scale 取整到 [-32767, 32767]，scale = max|v| / 32767 */
function quantize16(vec: Float32Array): { bytes: Buffer; scale: number } {
  let max = 0
  for (const value of vec) max = Math.max(max, Math.abs(value))
  const scale = max > 0 ? max / 32767 : 1
  const bytes = Buffer.alloc(vec.length * 2)
  for (let i = 0; i < vec.length; i += 1) {
    const q = Math.max(-32767, Math.min(32767, Math.round(vec[i] / scale)))
    bytes.writeInt16LE(q, i * 2)
  }
  return { bytes, scale }
}

function dequantize16(bytes: Buffer, scale: number): Float32Array {
  const out = new Float32Array(bytes.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readInt16LE(i * 2) * scale
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a))
}

function cosine(a: Float32Array, b: Float32Array): number {
  const denom = norm(a) * norm(b)
  return denom > 0 ? dot(a, b) / denom : 0
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[index]
}

describe.skipIf(!hasDb)('event_embeddings 量化选型：int8 vs int16（P1-3）', () => {
  it('真实库：体积投影 / 余弦误差 / top-1 一致率', () => {
    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db
        .prepare('SELECT event_id, dim, vec FROM event_embeddings ORDER BY event_id ASC')
        .all() as Array<{ event_id: number; dim: number; vec: Buffer }>
      expect(rows.length).toBeGreaterThan(100)

      const dim = rows[0].dim
      expect(rows.every((row) => row.dim === dim && row.vec.byteLength === dim * 4)).toBe(true)

      const rawBytes = rows.reduce((sum, row) => sum + row.vec.byteLength, 0)
      const fileBytes = (
        db.prepare("SELECT SUM(pgsize) AS n FROM dbstat WHERE name = 'event_embeddings'").get() as {
          n: number | null
        }
      ).n
      const int8Bytes = rows.length * (dim + 4)

      const vectors = rows.map((row) => decodeVector(row.vec))
      const quantized = vectors.map((vec) => {
        const { bytes, scale } = quantize(vec)
        return dequantize(bytes, scale)
      })
      const quantized16 = vectors.map((vec) => {
        const { bytes, scale } = quantize16(vec)
        return dequantize16(bytes, scale)
      })

      // 余弦误差：随机取 pairs（固定种子，结果可复现）
      let seed = 20261028
      const rand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      const errors: number[] = []
      for (let i = 0; i < 20_000; i += 1) {
        const a = Math.floor(rand() * vectors.length)
        const b = Math.floor(rand() * vectors.length)
        if (a === b) continue
        errors.push(Math.abs(cosine(vectors[a], vectors[b]) - cosine(quantized[a], quantized[b])))
      }

      // top-1 一致率：抽 120 个向量在全量里找最近邻（排除自己）
      const probes = 120
      let same = 0
      let same16 = 0
      let probed = 0
      for (let p = 0; p < probes; p += 1) {
        const index = Math.floor(rand() * vectors.length)
        let bestFloat = -1
        let bestFloatIndex = -1
        let bestQuant = -1
        let bestQuantIndex = -1
        let bestQuant16 = -1
        let bestQuant16Index = -1
        for (let j = 0; j < vectors.length; j += 1) {
          if (j === index) continue
          const sf = cosine(vectors[index], vectors[j])
          if (sf > bestFloat) {
            bestFloat = sf
            bestFloatIndex = j
          }
          const sq8 = cosine(quantized[index], quantized[j])
          if (sq8 > bestQuant) {
            bestQuant = sq8
            bestQuantIndex = j
          }
          const sq16 = cosine(quantized16[index], quantized16[j])
          if (sq16 > bestQuant16) {
            bestQuant16 = sq16
            bestQuant16Index = j
          }
        }
        probed += 1
        if (bestFloatIndex === bestQuantIndex) same += 1
        if (bestFloatIndex === bestQuant16Index) same16 += 1
      }

      const rate = (same / probed) * 100
      const rate16 = (same16 / probed) * 100
      console.log(
        `[int8] 行数 ${rows.length} / dim ${dim}；BLOB ${(rawBytes / 1024 / 1024).toFixed(1)} MB，` +
          `表实占 ${((fileBytes ?? 0) / 1024 / 1024).toFixed(1)} MB，int8 投影 ${(
            int8Bytes / 1024 / 1024
          ).toFixed(1)} MB，int16 投影 ${((rows.length * (dim * 2 + 4)) / 1024 / 1024).toFixed(1)} MB`
      )
      console.log(
        `[int8] 余弦误差 |Δ|：p50 ${pct(errors, 50).toExponential(2)} / p99 ${pct(
          errors,
          99
        ).toExponential(2)} / max ${Math.max(...errors).toExponential(2)}`
      )
      console.log(`[int8] top-1 一致率 ${rate.toFixed(1)}%（${same}/${probed}）`)
      console.log(`[int16] top-1 一致率 ${rate16.toFixed(1)}%（${same16}/${probed}）`)

      expect(rate16).toBeGreaterThanOrEqual(99)
      expect(pct(errors, 50)).toBeLessThanOrEqual(2e-3)
    } finally {
      db.close()
    }
  })
})
