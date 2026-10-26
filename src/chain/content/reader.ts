/**
 * 信息链 · 内容来源的取用策略（D43）：**UIA 优先、OCR 兜底，拿不到就留空**
 *
 * 口径（契约 §2.4 / §5.0 第 12 条）：
 * 1. UIA 拿到的文本 ≥ `minUiaChars`（默认 200）才用 UIA；更薄就当没拿到——探针实测微信 6 字符、
 *    终端 90 字符，UIA 树在自绘窗口上就是这么薄，把 6 个字当「这段的内容」是骗自己。
 * 2. 拿不到（薄 / 抛错 / 没接 UIA）才走 OCR，且必须有一张**这次抓帧落下的图**；
 *    没有图就没有 OCR（不为了读文字额外再截一张，口径是「抓帧时顺带读」）。
 * 3. 两者都失败返回 null：不编造、不写空行，由调用方记日志。
 * 4. 单条文本有长度上限（默认 100k 字符），超了截断并在日志里写明——不静默。
 */
import type { ContentPayload } from '../recorder'
import type { UiaTextReader } from './uia'

export type ContentLog = (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void

export interface ContentReadInput {
  /** 段身份对应窗口的句柄（UIA 按句柄读这扇窗） */
  hwnd: number
  /** 进程名（日志用） */
  executable: string
  /** 这次抓帧落下的图（OCR 兜底用）；没抓帧就是 null */
  framePath: string | null
}

/** OCR 引擎的最小形状（`WinrtOcrBridge` 满足它） */
export interface OcrLike {
  recognize(imagePath: string): Promise<{ text: string }>
  dispose?(): Promise<void>
}

export interface ContentReaderOptions {
  uia?: UiaTextReader | null
  ocr?: OcrLike | null
  /** UIA 文本少于这么多字符就当没拿到（默认 200） */
  minUiaChars?: number
  /** 单条内容字符上限（默认 100k） */
  maxChars?: number
  log?: ContentLog
}

export interface ContentReader {
  read(input: ContentReadInput): Promise<ContentPayload | null>
}

export const DEFAULT_MIN_UIA_CHARS = 200
export const DEFAULT_MAX_CONTENT_CHARS = 100_000

function cap(text: string, maxChars: number, log: ContentLog | undefined, source: string): string {
  if (text.length <= maxChars) return text
  log?.('info', 'content: text capped', { source, before: text.length, after: maxChars })
  return text.slice(0, maxChars)
}

export function createContentReader(options: ContentReaderOptions): ContentReader {
  const minUiaChars = options.minUiaChars ?? DEFAULT_MIN_UIA_CHARS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CONTENT_CHARS
  const log = options.log

  return {
    async read(input: ContentReadInput): Promise<ContentPayload | null> {
      if (options.uia) {
        try {
          const result = await options.uia.read(input.hwnd)
          const text = result.text.trim()
          if (text.length >= minUiaChars) {
            log?.('info', 'content: uia', {
              exe: input.executable,
              chars: result.chars,
              elements: result.elements,
              truncated: result.truncated,
              passwordElements: result.passwordElements,
              ms: result.ms
            })
            return { source: 'uia', text: cap(result.text, maxChars, log, 'uia') }
          }
          log?.('info', 'content: uia thin, trying ocr', {
            exe: input.executable,
            chars: result.chars,
            elements: result.elements,
            minUiaChars
          })
        } catch (error) {
          log?.('warn', 'content: uia failed', { exe: input.executable, error: String(error) })
        }
      }

      if (options.ocr && input.framePath) {
        try {
          const recognized = await options.ocr.recognize(input.framePath)
          if (recognized.text.trim() !== '') {
            log?.('info', 'content: ocr', {
              exe: input.executable,
              chars: recognized.text.length
            })
            return { source: 'ocr', text: cap(recognized.text, maxChars, log, 'ocr') }
          }
          log?.('info', 'content: ocr empty', { exe: input.executable })
        } catch (error) {
          log?.('warn', 'content: ocr failed', { exe: input.executable, error: String(error) })
        }
      }

      log?.('info', 'content: nothing captured', {
        exe: input.executable,
        hasUia: options.uia !== null && options.uia !== undefined,
        hasFrame: input.framePath !== null
      })
      return null
    }
  }
}
