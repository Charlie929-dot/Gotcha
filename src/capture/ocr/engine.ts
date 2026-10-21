/**
 * OCR 引擎接口（m1a-plan §2：留 RapidOCR 替换点）
 */

export interface OcrResult {
  text: string
  /** 识别耗时（ms，不含进程启动） */
  ms: number
}

export interface OcrEngine {
  recognize(imagePath: string): Promise<OcrResult>
  dispose(): Promise<void>
}
