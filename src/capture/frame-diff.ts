/**
 * 帧差：dHash 8x8 + 汉明距离（m1a-plan §3 Phase 2b）
 *
 * 流程：RGBA 截图 → 灰度 → 缩到 9x8 → 每行相邻像素比较 → 64 bit 指纹；
 * 汉明距离 ≤ 阈值视为「内容未变」，直接丢帧（settings capture.diff_threshold，初值 8）。
 */

export const DHASH_COLS = 9
export const DHASH_ROWS = 8

/** RGBA → 灰度（BT.601 亮度权重） */
export function rgbaToGray(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0
  }
  return out
}

/** 最近邻降采样（帧差只需 9x8，不需要高质量插值） */
export function resizeGray(
  gray: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number
): Uint8Array {
  const out = new Uint8Array(outWidth * outHeight)
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / outHeight))
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / outWidth))
      out[y * outWidth + x] = gray[sy * width + sx]
    }
  }
  return out
}

/**
 * 64 bit dHash 指纹（输入任意尺寸灰度图，内部降采样到 9x8）
 *
 * width/height 必须是 **gray 自身的尺寸**：拿 OCR 图尺寸去套 90x80 灰度会越界读到
 * undefined，指纹恒为同值、帧差永不触发（真机验收踩过，见 gotchas.md）。
 */
export function dHash(gray: Uint8Array, width: number, height: number): bigint {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`dHash 尺寸非法: ${width}x${height}`)
  }
  if (gray.length < width * height) {
    throw new RangeError(`dHash 缓冲区不足: 声明 ${width}x${height}，实际 ${gray.length} 字节`)
  }
  const small = resizeGray(gray, width, height, DHASH_COLS, DHASH_ROWS)
  let bits = 0n
  for (let y = 0; y < DHASH_ROWS; y++) {
    for (let x = 0; x < DHASH_COLS - 1; x++) {
      const left = small[y * DHASH_COLS + x]
      const right = small[y * DHASH_COLS + x + 1]
      if (left > right) bits |= 1n << BigInt(y * (DHASH_COLS - 1) + x)
    }
  }
  return bits
}

/** 汉明距离（不同 bit 数，0–64） */
export function hammingDistance(a: bigint, b: bigint): number {
  let v = a ^ b
  let count = 0
  while (v !== 0n) {
    count += Number(v & 1n)
    v >>= 1n
  }
  return count
}
