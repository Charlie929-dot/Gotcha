/**
 * QQ 出站图片与发图闸门（D96 / PR2）
 *
 * 守这些事：出站图长边 / 大小口径（GIF 原样、转码失败不吞图）；
 * 同一张表情 24h 不连发、表情 / 图片每日上限、跨重启不清零、坏文件按新一天开始。
 */

import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  prepareOutboundImage,
  QqMediaGate,
  QQ_OUTBOUND_MAX_BYTES,
  type QqImageEncoder
} from '../../src/main/qq/media'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-qq-media-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('出站图片口径（D96 §6.4）', () => {
  it('PNG 走编码器：输出按编码器的字节与 mime，data URL 对得上', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43])
    const encoder: QqImageEncoder = ({ maxSide }) => {
      expect(maxSide).toBe(1600)
      return { bytes: jpeg, mime: 'image/jpeg' }
    }
    const prepared = prepareOutboundImage(PNG, encoder)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.bytes.equals(jpeg)).toBe(true)
    expect(prepared.mime).toBe('image/jpeg')
    expect(prepared.dataUrl).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
  })

  it('编码器返回 null（比如解码失败）：原图不大就照发，不吞图', () => {
    const prepared = prepareOutboundImage(PNG, () => null)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.bytes.equals(PNG)).toBe(true)
    expect(prepared.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('编码器抛错也一样退到原图', () => {
    const prepared = prepareOutboundImage(PNG, () => {
      throw new Error('nativeImage 挂了')
    })
    expect(prepared.ok).toBe(true)
  })

  it('GIF 原样保留（解码会丢动画）', () => {
    const prepared = prepareOutboundImage(GIF, () => {
      throw new Error('不该调用编码器')
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.bytes.equals(GIF)).toBe(true)
    expect(prepared.mime).toBe('image/gif')
  })

  it('超过 3MB 且压不下来：如实拒绝', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(QQ_OUTBOUND_MAX_BYTES + 1)])
    const prepared = prepareOutboundImage(huge, () => null)
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.error).toContain('3MB')

    const hugeGif = Buffer.concat([GIF, Buffer.alloc(QQ_OUTBOUND_MAX_BYTES + 1)])
    expect(prepareOutboundImage(hugeGif).ok).toBe(false)
  })

  it('不是图 / 空图：认不出来就说认不出来', () => {
    expect(prepareOutboundImage(Buffer.from('hello')).ok).toBe(false)
    expect(prepareOutboundImage(Buffer.alloc(0)).ok).toBe(false)
  })
})

describe('发图闸门（D96 §6.4）', () => {
  const DAY = 24 * 60 * 60_000

  it('同一张表情 24h 内不连发，换一张可以', () => {
    let now = 1_760_000_000_000
    const gate = new QqMediaGate({ file: join(tempDir(), 'usage.json'), now: () => now })
    expect(gate.allow('sticker', 'aaa')).toBe(true)
    expect(gate.allow('sticker', 'aaa')).toBe(false)
    expect(gate.allow('sticker', 'bbb')).toBe(true)
    now += DAY + 1
    expect(gate.allow('sticker', 'aaa')).toBe(true)
  })

  it('每日上限：表情 / 图片各 20 张，超了挡住（计数落盘，重启不清零）', () => {
    const file = join(tempDir(), 'usage.json')
    let now = 1_760_000_000_000
    const gate = new QqMediaGate({ file, now: () => now, stickerPerDay: 2, imagePerDay: 1 })
    expect(gate.allow('sticker', 's1')).toBe(true)
    expect(gate.allow('sticker', 's2')).toBe(true)
    expect(gate.allow('sticker', 's3')).toBe(false)
    expect(gate.allow('image')).toBe(true)
    expect(gate.allow('image')).toBe(false)

    // 重启：同一天额度还在
    const reopened = new QqMediaGate({ file, now: () => now, stickerPerDay: 2, imagePerDay: 1 })
    expect(reopened.view()).toMatchObject({ stickers: 2, images: 1 })
    expect(reopened.allow('sticker', 's4')).toBe(false)

    // 第二天：额度归零
    now += DAY
    expect(reopened.view()).toMatchObject({ stickers: 0, images: 0 })
    expect(reopened.allow('sticker', 's1')).toBe(true)
  })

  it('坏文件：按新的一天开始，不抛', () => {
    const file = join(tempDir(), 'usage.json')
    writeFileSync(file, 'not json', 'utf8')
    const gate = new QqMediaGate({ file, now: () => 1_760_000_000_000 })
    expect(gate.view().stickers).toBe(0)
    expect(gate.allow('image')).toBe(true)
  })
})
