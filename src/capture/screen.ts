/**
 * 截屏 → 裁前台窗口区域 → 降采样（m1a-plan §3 Phase 2b）
 *
 * desktopCapturer 抓整屏（按 DPI 物理像素），按窗口 bounds 裁剪；
 * 裁剪失败（多屏/DPI 异常）回退整屏，保证采集不断。
 */

import { desktopCapturer, screen } from 'electron'
import type { Display } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dHash, rgbaToGray } from './frame-diff'
import type { WindowBounds } from './window-meta'

/** dHash 输入尺寸（90x80，便于整数降到 9x8） */
const DIFF_WIDTH = 90
const DIFF_HEIGHT = 80
/** OCR 输入最大宽度：控制单帧 OCR 耗时 */
const MAX_OCR_WIDTH = 1280

export interface CapturedFrame {
  imagePath: string
  /** OCR 图宽（≤1280） */
  width: number
  /** OCR 图高 */
  height: number
  /** 90x80 灰度图的 dHash 指纹；尺寸必须用 DIFF_WIDTH/DIFF_HEIGHT 算 */
  diffHash: bigint
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** active-win 在 Electron 主进程返回物理像素；display.bounds 是 DIP，需按 scaleFactor 换算 */
function findDisplayForPhysicalPoint(point: { x: number; y: number }): Display {
  const displays = screen.getAllDisplays()
  return (
    displays.find((d) => {
      const scale = d.scaleFactor
      const left = d.bounds.x * scale
      const top = d.bounds.y * scale
      return (
        point.x >= left &&
        point.x < left + d.bounds.width * scale &&
        point.y >= top &&
        point.y < top + d.bounds.height * scale
      )
    }) ?? screen.getPrimaryDisplay()
  )
}

function clampRect(rect: Rect, maxWidth: number, maxHeight: number): Rect | null {
  const x = Math.max(0, Math.min(maxWidth - 1, Math.round(rect.x)))
  const y = Math.max(0, Math.min(maxHeight - 1, Math.round(rect.y)))
  const width = Math.min(maxWidth - x, Math.round(rect.width))
  const height = Math.min(maxHeight - y, Math.round(rect.height))
  if (width < 8 || height < 8) return null
  return { x, y, width, height }
}

/** 抓当前前台窗口区域；截图失败抛错由调用方计 capture_errors */
export async function captureWindowFrame(
  bounds: WindowBounds,
  tempDir: string,
  ts: number
): Promise<CapturedFrame> {
  const display = findDisplayForPhysicalPoint({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  })
  const scale = display.scaleFactor
  const displayPhysical: Rect = {
    x: display.bounds.x * scale,
    y: display.bounds.y * scale,
    width: display.bounds.width * scale,
    height: display.bounds.height * scale
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(displayPhysical.width),
      height: Math.round(displayPhysical.height)
    }
  })
  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('整屏截图失败')
  }

  const full = source.thumbnail
  const fullSize = full.getSize()
  // 缩略图尺寸与物理屏幕尺寸的比例（Electron 可能把超大屏缩略图限制到上限）
  const ratioX = fullSize.width / displayPhysical.width
  const ratioY = fullSize.height / displayPhysical.height

  const relative: Rect = {
    x: (bounds.x - displayPhysical.x) * ratioX,
    y: (bounds.y - displayPhysical.y) * ratioY,
    width: bounds.width * ratioX,
    height: bounds.height * ratioY
  }
  const cropRect = clampRect(relative, fullSize.width, fullSize.height) ?? {
    x: 0,
    y: 0,
    width: fullSize.width,
    height: fullSize.height
  }

  const cropped = full.crop(cropRect)
  const targetWidth = Math.min(MAX_OCR_WIDTH, cropRect.width)
  const targetHeight = Math.max(1, Math.round((cropRect.height * targetWidth) / cropRect.width))
  const windowImage = cropped.resize({ width: targetWidth, height: targetHeight, quality: 'good' })

  const imagePath = join(tempDir, `frame-${ts}.png`)
  writeFileSync(imagePath, windowImage.toPNG())

  const diffImage = windowImage.resize({ width: DIFF_WIDTH, height: DIFF_HEIGHT })
  const gray = rgbaToGray(new Uint8Array(diffImage.toBitmap()), DIFF_WIDTH, DIFF_HEIGHT)
  const diffHash = dHash(gray, DIFF_WIDTH, DIFF_HEIGHT)

  return { imagePath, width: targetWidth, height: targetHeight, diffHash }
}
