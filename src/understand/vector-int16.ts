/**
 * 事件向量 int16 压缩（性能方案 §3 P1-3）
 *
 * 为什么不是 int8：
 * - 真实库 15,567 条 512 维向量实测（`tests/perf/vector-int8.perf.test.ts`）：
 *   int8（absmax 对称量化）余弦误差 p50 6.2e-4，但 **top-1 最近邻只有 96.7% 一致**——
 *   同一屏的 OCR 文本向量本来就互为近重复，top1/top2 的 gap 与量化误差同量级；
 * - int16 同样的抽样 **top-1 一致率 100%**，而 BLOB 从 2048 B 降到 1028 B：
 *   SQLite 里 2 KB 的行会溢出到第二页（实测 4105 B/行），1 KB 的行能整行放下（1369 B/行），
 *   于是 15,567 行从 61.0 MB 降到 20.3 MB（≈3×），而精度上的代价可以忽略。
 *
 * 存储格式（小端）：
 * ```
 * 0..1   'Q1' 魔数     —— 与老的 Float32 行区分（Float32 向量分量不可能出现 0x5131 这个字节对）
 * 2..3   版本/标志位（当前恒 0）
 * 4..7   float32 尺度  —— 反量化时每分量乘它
 * 8..     dim × int16  —— round(v / scale)，scale = max|v| / 32767
 * ```
 * 兼容：老行（`dim × float32`，无头）继续按 Float32 解码，所以迁移只影响之后新写的行，
 * 读路径两种格式都能吃（`decodeEmbeddingVector`）。
 */

/** 头部长度：魔数 2 + 版本 2 + 尺度 4 */
export const INT16_VECTOR_HEADER_BYTES = 8

const MAGIC_0 = 0x51 // 'Q'
const MAGIC_1 = 0x31 // '1'

/** int16 量化的满量程（对称量化，不用 32768 免得取整溢出） */
const INT16_FULL_SCALE = 32767

/** 把归一化后的向量编码成 int16（带尺度头） */
export function encodeVectorInt16(vec: Float32Array): Buffer {
  let max = 0
  for (let i = 0; i < vec.length; i += 1) {
    const value = vec[i]
    if (!Number.isFinite(value)) continue
    const abs = Math.abs(value)
    if (abs > max) max = abs
  }
  // 全零向量：尺度取 1，反量化仍是全零（不做除零）
  const scale = max > 0 ? max / INT16_FULL_SCALE : 1
  const buffer = Buffer.alloc(INT16_VECTOR_HEADER_BYTES + vec.length * 2)
  buffer.writeUInt8(MAGIC_0, 0)
  buffer.writeUInt8(MAGIC_1, 1)
  buffer.writeUInt16LE(0, 2)
  buffer.writeFloatLE(scale, 4)
  for (let i = 0; i < vec.length; i += 1) {
    const value = vec[i]
    const q = Number.isFinite(value)
      ? Math.max(-INT16_FULL_SCALE, Math.min(INT16_FULL_SCALE, Math.round(value / scale)))
      : 0
    buffer.writeInt16LE(q, INT16_VECTOR_HEADER_BYTES + i * 2)
  }
  return buffer
}

/** 判断一个 BLOB 是不是 int16 编码（魔数 + 长度都要对得上） */
export function isInt16Vector(blob: Buffer, dim: number): boolean {
  return (
    blob.byteLength === INT16_VECTOR_HEADER_BYTES + dim * 2 &&
    blob.byteLength >= INT16_VECTOR_HEADER_BYTES &&
    blob.readUInt8(0) === MAGIC_0 &&
    blob.readUInt8(1) === MAGIC_1
  )
}

/** 解码 int16（调用方先用 `isInt16Vector` 判断；长度不符返回空数组） */
export function decodeVectorInt16(blob: Buffer): Float32Array {
  const body = blob.byteLength - INT16_VECTOR_HEADER_BYTES
  if (body < 0 || body % 2 !== 0) return new Float32Array(0)
  const scale = blob.readFloatLE(4)
  const dim = body / 2
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i += 1) {
    out[i] = blob.readInt16LE(INT16_VECTOR_HEADER_BYTES + i * 2) * scale
  }
  return out
}

/**
 * 读事件向量的统一入口：int16 新行按头解码，老的 Float32 行按 `dim × 4` 解码。
 * 长度两种都对不上时返回空数组（调用方按 `skipped` 计）。
 */
export function decodeEmbeddingVector(blob: Buffer, dim: number): Float32Array {
  if (isInt16Vector(blob, dim)) return decodeVectorInt16(blob)
  const expected = dim * 4
  if (expected > 0 && blob.byteLength === expected) {
    const out = new Float32Array(dim)
    for (let i = 0; i < dim; i += 1) out[i] = blob.readFloatLE(i * 4)
    return out
  }
  // 维度未知（dim 传 0）或长度异常：按 Float32 尽力解（与旧行为一致）
  if (dim <= 0 && blob.byteLength % 4 === 0) {
    const out = new Float32Array(blob.byteLength / 4)
    for (let i = 0; i < out.length; i += 1) out[i] = blob.readFloatLE(i * 4)
    return out
  }
  return new Float32Array(0)
}

/** 反量化回 Float32 的编码（迁移 down / 需要与老格式对齐时用） */
export function encodeVectorFloat32(vec: Float32Array): Buffer {
  const buffer = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i += 1) buffer.writeFloatLE(vec[i], i * 4)
  return buffer
}
