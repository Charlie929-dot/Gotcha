import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_MAGIC,
  archiveShotIds,
  buildArchive,
  extractArchiveEntry,
  parseArchiveIndex
} from '../../src/chain/archive'

const jpeg = (tag: string): Buffer => Buffer.from(`JPEG:${tag}`, 'utf8')

describe('归档容器', () => {
  it('打进容器再解出来：字节和宽高一模一样', () => {
    const buffer = buildArchive([
      { shotId: 1, bytes: jpeg('a'), width: 1920, height: 1021 },
      { shotId: 2, bytes: jpeg('bb'), width: 1440, height: 766 }
    ])

    const first = extractArchiveEntry(buffer, 1)
    const second = extractArchiveEntry(buffer, 2)
    expect(first?.bytes.equals(jpeg('a'))).toBe(true)
    expect(first).toMatchObject({ width: 1920, height: 1021, codec: 'jpeg' })
    expect(second?.bytes.equals(jpeg('bb'))).toBe(true)
    expect(second).toMatchObject({ width: 1440, height: 766 })
  })

  it('索引在尾部：magic 对、条目偏移不重叠', () => {
    const buffer = buildArchive([
      { shotId: 7, bytes: jpeg('x'), width: 10, height: 10 },
      { shotId: 9, bytes: jpeg('y'), width: 11, height: 11 }
    ])
    expect(buffer.toString('latin1', buffer.length - 4)).toBe(ARCHIVE_MAGIC)
    const index = parseArchiveIndex(buffer)
    expect(index.entries.map((entry) => entry.shotId)).toEqual([7, 9])
    expect(index.entries[0].offset).toBe(0)
    expect(index.entries[1].offset).toBe(index.entries[0].length)
  })

  it('找不存在的 shotId：返回 null，不抛错', () => {
    const buffer = buildArchive([{ shotId: 1, bytes: jpeg('a'), width: 1, height: 1 }])
    expect(extractArchiveEntry(buffer, 999)).toBeNull()
  })

  it('空容器：合法（0 条），只是没东西', () => {
    const buffer = buildArchive([])
    expect(parseArchiveIndex(buffer).entries).toEqual([])
    expect(archiveShotIds(buffer)).toEqual([])
  })

  it('重复的 shotId：打包时就拒绝（否则解出哪一张全靠运气）', () => {
    expect(() =>
      buildArchive([
        { shotId: 1, bytes: jpeg('a'), width: 1, height: 1 },
        { shotId: 1, bytes: jpeg('b'), width: 1, height: 1 }
      ])
    ).toThrow(/重复/)
  })

  it('空的图片：拒绝（不能往证据里塞零字节）', () => {
    expect(() => buildArchive([{ shotId: 1, bytes: Buffer.alloc(0), width: 1, height: 1 }])).toThrow(
      /空的/
    )
  })

  it('半截 / 被改坏的文件：如实抛错，不当成证据', () => {
    const buffer = buildArchive([{ shotId: 1, bytes: jpeg('a'), width: 1, height: 1 }])
    // 截掉尾部（写到一半崩掉）
    expect(() => parseArchiveIndex(buffer.subarray(0, buffer.length - 10))).toThrow()
    // 改 magic
    const broken = Buffer.from(buffer)
    broken.write('XXXX', broken.length - 4, 'latin1')
    expect(() => parseArchiveIndex(broken)).toThrow(/magic/)
    // 索引长度超过文件
    const huge = Buffer.from(buffer)
    huge.writeUInt32LE(0x7fffffff, huge.length - 8)
    expect(() => parseArchiveIndex(huge)).toThrow(/越界/)
  })

  it('索引里偏移越界的条目：拒绝（不读别人的字节）', () => {
    const buffer = buildArchive([{ shotId: 1, bytes: jpeg('a'), width: 1, height: 1 }])
    const indexStart = buffer.length - 8 - buffer.readUInt32LE(buffer.length - 8)
    const json = JSON.parse(buffer.toString('utf8', indexStart, indexStart + buffer.readUInt32LE(buffer.length - 8)))
    json.entries[0].offset = json.entries[0].length
    json.entries[0].length = 999
    const forged = Buffer.from(JSON.stringify(json), 'utf8')
    const trailer = Buffer.from(buffer.subarray(buffer.length - 8))
    trailer.writeUInt32LE(forged.length, 0)
    expect(() => parseArchiveIndex(Buffer.concat([buffer.subarray(0, indexStart), forged, trailer]))).toThrow(
      /越界/
    )
  })
})
