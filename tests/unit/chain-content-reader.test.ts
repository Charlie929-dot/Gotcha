import { describe, expect, it } from 'vitest'
import { createUiaTextReader } from '../../src/chain/content/uia'
import type { PowerShellJsonWorker } from '../../src/chain/content/worker'
import {
  createContentReader,
  DEFAULT_MAX_CONTENT_CHARS,
  type OcrLike
} from '../../src/chain/content/reader'

/** 假工作器：按调用顺序回放响应 */
function fakeWorker(responses: Array<Record<string, unknown>>): PowerShellJsonWorker & { requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = []
  const worker = {
    requests,
    request: async (payload: Record<string, unknown>) => {
      requests.push(payload)
      const next = responses.shift()
      if (!next) throw new Error('no response queued')
      return next
    }
  }
  return worker as unknown as PowerShellJsonWorker & { requests: Array<Record<string, unknown>> }
}

function uiaOf(text: string, overrides: Record<string, unknown> = {}): PowerShellJsonWorker {
  return fakeWorker([
    {
      ok: true,
      text,
      chars: text.length,
      elements: 10,
      scanned: 10,
      truncated: false,
      password: 0,
      ms: 5,
      ...overrides
    }
  ])
}

describe('UIA 文本读取（脚本边界校验）', () => {
  it('把 hwnd / 上限传给脚本，响应字段原样解读', async () => {
    const worker = fakeWorker([{ ok: true, text: '正文', chars: 2, elements: 7, scanned: 6, truncated: true, password: 2, ms: 900 }])
    const reader = createUiaTextReader({ worker, maxElements: 4_000, maxChars: 100_000 })
    const result = await reader.read(42)
    expect(result).toMatchObject({
      text: '正文',
      chars: 2,
      elements: 7,
      scanned: 6,
      truncated: true,
      passwordElements: 2,
      ms: 900
    })
    expect(worker.requests[0]).toMatchObject({ hwnd: 42, maxElements: 4_000, maxChars: 100_000 })
  })

  it('脚本报错：抛错（由策略层决定要不要转 OCR）', async () => {
    const reader = createUiaTextReader({ worker: fakeWorker([{ ok: false, error: 'FromHandle returned null' }]) })
    await expect(reader.read(42)).rejects.toThrow('FromHandle returned null')
  })

  it('非法句柄直接拒绝，不惊动子进程', async () => {
    const worker = fakeWorker([])
    const reader = createUiaTextReader({ worker })
    await expect(reader.read(0)).rejects.toThrow('非法窗口句柄')
    expect(worker.requests).toHaveLength(0)
  })

  it('缺字段一律当 0 / 空串（不信任子进程回来的对象）', async () => {
    const reader = createUiaTextReader({ worker: fakeWorker([{ ok: true }]) })
    await expect(reader.read(42)).resolves.toEqual({
      text: '',
      chars: 0,
      elements: 0,
      scanned: 0,
      truncated: false,
      passwordElements: 0,
      ms: 0
    })
  })
})

describe('内容取用策略：UIA 优先、OCR 兜底', () => {
  function ocrOf(text: string, calls: string[] = []): OcrLike {
    return {
      recognize: async (path: string) => {
        calls.push(path)
        return { text }
      }
    }
  }

  it('UIA 够厚：用 UIA，不去 OCR', async () => {
    const calls: string[] = []
    const reader = createContentReader({
      uia: { read: async () => ({ text: '长'.repeat(500), chars: 500, elements: 20, scanned: 20, truncated: false, passwordElements: 0, ms: 30 }) },
      ocr: ocrOf('OCR 文本', calls),
      minUiaChars: 200
    })
    const payload = await reader.read({ hwnd: 42, executable: 'firefox.exe', framePath: 'C:/shots/a.png' })
    expect(payload).toEqual({ source: 'uia', text: '长'.repeat(500) })
    expect(calls).toHaveLength(0)
  })

  it('UIA 太薄（微信 6 字符那种）：转 OCR，来源记 ocr', async () => {
    const reader = createContentReader({
      uia: { read: async () => ({ text: '微信', chars: 2, elements: 3, scanned: 3, truncated: false, passwordElements: 0, ms: 5 }) },
      ocr: ocrOf('OCR 正文'),
      minUiaChars: 200
    })
    const payload = await reader.read({ hwnd: 42, executable: 'wechat.exe', framePath: 'C:/shots/a.png' })
    expect(payload).toEqual({ source: 'ocr', text: 'OCR 正文' })
  })

  it('UIA 抛错：转 OCR（不整条失败）', async () => {
    const reader = createContentReader({
      uia: {
        read: async () => {
          throw new Error('UIA 挂住')
        }
      },
      ocr: ocrOf('OCR 正文')
    })
    await expect(reader.read({ hwnd: 42, executable: 'x.exe', framePath: 'C:/a.png' })).resolves.toEqual({
      source: 'ocr',
      text: 'OCR 正文'
    })
  })

  it('UIA 太薄且没有这一帧：留空（不额外再截一张）', async () => {
    const calls: string[] = []
    const reader = createContentReader({
      uia: { read: async () => ({ text: 'x', chars: 1, elements: 1, scanned: 1, truncated: false, passwordElements: 0, ms: 1 }) },
      ocr: ocrOf('不该被调用', calls)
    })
    await expect(reader.read({ hwnd: 42, executable: 'x.exe', framePath: null })).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('OCR 也空 / 抛错：留空，不编造', async () => {
    const thin = { text: '', chars: 0, elements: 0, scanned: 0, truncated: false, passwordElements: 0, ms: 1 }
    const emptyOcr = createContentReader({
      uia: { read: async () => thin },
      ocr: ocrOf('   ')
    })
    await expect(emptyOcr.read({ hwnd: 1, executable: 'x.exe', framePath: 'C:/a.png' })).resolves.toBeNull()

    const brokenOcr = createContentReader({
      uia: { read: async () => thin },
      ocr: {
        recognize: async () => {
          throw new Error('OCR 超时')
        }
      }
    })
    await expect(brokenOcr.read({ hwnd: 1, executable: 'x.exe', framePath: 'C:/a.png' })).resolves.toBeNull()
  })

  it('没接 UIA 也能只靠 OCR；两者都没有就留空', async () => {
    const onlyOcr = createContentReader({ ocr: ocrOf('OCR 正文') })
    await expect(onlyOcr.read({ hwnd: 1, executable: 'x.exe', framePath: 'C:/a.png' })).resolves.toEqual({
      source: 'ocr',
      text: 'OCR 正文'
    })

    const nothing = createContentReader({})
    await expect(nothing.read({ hwnd: 1, executable: 'x.exe', framePath: 'C:/a.png' })).resolves.toBeNull()
  })

  it('超长正文按上限截断（不静默：日志里记截断前长度）', async () => {
    const logged: string[] = []
    const reader = createContentReader({
      uia: { read: async () => ({ text: 'a'.repeat(50), chars: 50, elements: 1, scanned: 1, truncated: false, passwordElements: 0, ms: 1 }) },
      minUiaChars: 10,
      maxChars: 20,
      log: (level, message, data) => {
        logged.push(`${level}:${message}:${String(data?.['before'])}`)
      }
    })
    const payload = await reader.read({ hwnd: 1, executable: 'x.exe', framePath: null })
    expect(payload).toEqual({ source: 'uia', text: 'a'.repeat(20) })
    expect(logged).toContain('info:content: text capped:50')
    expect(DEFAULT_MAX_CONTENT_CHARS).toBe(100_000)
  })
})
