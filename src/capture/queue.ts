/**
 * OCR 任务队列（m1a-plan §4.4）
 *
 * 上限 50；满则丢**最新**并计 queue_dropped（机器忙时保采集轻量）。
 */

export interface OcrJob {
  ts: number
  app: string
  title: string
  imagePath: string
  /** 帧差指纹（管线入队时填充，用于成功后提交 / 失败重试） */
  hash?: bigint
}

export class OcrQueue {
  private readonly items: OcrJob[] = []
  private droppedCount = 0

  constructor(private readonly capacity = 50) {}

  get size(): number {
    return this.items.length
  }

  get dropped(): number {
    return this.droppedCount
  }

  /** 入队；队长满返回 false 并计丢弃 */
  push(job: OcrJob): boolean {
    if (this.items.length >= this.capacity) {
      this.droppedCount++
      return false
    }
    this.items.push(job)
    return true
  }

  /** 取最早任务（FIFO） */
  take(): OcrJob | undefined {
    return this.items.shift()
  }

  /** 一次取空（关闸时由管线逐条删帧并计 queue_dropped），返回 FIFO 顺序 */
  drainAll(): OcrJob[] {
    return this.items.splice(0, this.items.length)
  }
}
