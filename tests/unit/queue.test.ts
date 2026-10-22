import { describe, expect, it } from 'vitest'
import { OcrQueue, type OcrJob } from '../../src/capture/queue'

function job(n: number): OcrJob {
  return { ts: n, app: 'notepad', title: `t${n}`, imagePath: `frame-${n}.png` }
}

describe('OcrQueue · 上限与丢弃', () => {
  it('容量满后丢最新并计 dropped，FIFO 取出', () => {
    const queue = new OcrQueue(2)
    expect(queue.push(job(1))).toBe(true)
    expect(queue.push(job(2))).toBe(true)
    expect(queue.push(job(3))).toBe(false)
    expect(queue.dropped).toBe(1)
    expect(queue.size).toBe(2)
    expect(queue.take()?.ts).toBe(1)
    expect(queue.take()?.ts).toBe(2)
    expect(queue.take()).toBeUndefined()
  })

  it('默认容量 50', () => {
    const queue = new OcrQueue()
    for (let i = 0; i < 50; i++) expect(queue.push(job(i))).toBe(true)
    expect(queue.push(job(50))).toBe(false)
    expect(queue.dropped).toBe(1)
  })

  it('drainAll 一次取空并保持 FIFO 顺序', () => {
    const queue = new OcrQueue()
    expect(queue.drainAll()).toEqual([])
    for (const entry of [job(1), job(2), job(3)]) queue.push(entry)

    expect(queue.drainAll().map((entry) => entry.ts)).toEqual([1, 2, 3])
    expect(queue.size).toBe(0)
    expect(queue.take()).toBeUndefined()
  })
})
