/**
 * 信息链 · UIA 文本读取（D43）
 *
 * 只做「请求 → 校验字段」：真正的遍历在 `resources/chain/uia-text.ps1` 里。
 * 不信任脚本回来的一切（它是子进程边界）：非字符串文本一律当空、缺字段给 0。
 */
import type { PowerShellJsonWorker } from './worker'

export interface UiaText {
  text: string
  /** 文本长度（chars = text.length，契约不变量 5 在存储层还会再算一次） */
  chars: number
  /** 树里的元素总数（可能超过扫描上限） */
  elements: number
  /** 实际扫描到的元素数 */
  scanned: number
  /** 元素数或字符数撞上限（拿到的文本是截断的） */
  truncated: boolean
  /** 密码控件个数（这些控件的文本一个都没取） */
  passwordElements: number
  ms: number
}

export interface UiaTextReader {
  read(hwnd: number): Promise<UiaText>
}

export interface UiaReaderOptions {
  worker: PowerShellJsonWorker
  /** 单次扫描的元素上限（默认 4000，与探针口径一致） */
  maxElements?: number
  /** 单次返回的字符上限（默认 100k） */
  maxChars?: number
}

const DEFAULT_MAX_ELEMENTS = 4_000
const DEFAULT_MAX_CHARS = 100_000

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

export function createUiaTextReader(options: UiaReaderOptions): UiaTextReader {
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  return {
    async read(hwnd: number): Promise<UiaText> {
      if (!Number.isInteger(hwnd) || hwnd <= 0) throw new Error(`UIA: 非法窗口句柄 ${hwnd}`)
      const message = await options.worker.request({ hwnd, maxElements, maxChars })
      if (message['ok'] !== true) {
        const reason = typeof message['error'] === 'string' ? message['error'] : 'UIA 读取失败'
        throw new Error(reason)
      }
      const text = typeof message['text'] === 'string' ? message['text'] : ''
      return {
        text,
        chars: asCount(message['chars']) || text.length,
        elements: asCount(message['elements']),
        scanned: asCount(message['scanned']),
        truncated: message['truncated'] === true,
        passwordElements: asCount(message['password']),
        ms: asCount(message['ms'])
      }
    }
  }
}
