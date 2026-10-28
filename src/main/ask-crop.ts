/**
 * 选区截图裁剪（主进程；要 `nativeImage`，所以单独一个模块）
 *
 * 单独拆出来的原因：`ask-shot.ts` 的路径 / 留存逻辑要能在单测里跑（node 环境不加载 electron），
 * 而裁剪必须用 Electron 的 nativeImage。分开放，测试只 import 前者。
 */

import { nativeImage } from 'electron'
import type { ScreenRect } from '../capture/full-frame'

/**
 * 整屏帧 → 选区 PNG。`crop` 来自 `selectionToFrameCrop()`（帧像素、已夹在帧内）。
 * 裁剪失败（尺寸非法 / 解码失败 / 越界）返回 null，由调用方按「没截到」处理。
 */
export function cropFrameToPng(frame: Uint8Array, crop: ScreenRect): Buffer | null {
  if (crop.width <= 0 || crop.height <= 0) return null
  const image = nativeImage.createFromBuffer(Buffer.from(frame))
  if (image.isEmpty()) return null
  const size = image.getSize()
  if (crop.x + crop.width > size.width || crop.y + crop.height > size.height) return null
  const cropped = image.crop(crop)
  if (cropped.isEmpty()) return null
  return cropped.toPNG()
}
