/**
 * 信息链 · 归档容器（契约 §2.3 / §5.1，D44）
 *
 * cold / archive 两层把当天同一层的证据图打成一个容器文件（`<day>-<tier>.cgar`），
 * 行里 `path` 置空、`container` 指向它。目的不是省字节（JPEG 已经压过，gzip 再压
 * 几乎没收益），而是**别把几十万个单文件堆在文件系统里**，也让归档 / 备份是一整份文件。
 *
 * 格式（自描述、无第三方依赖；顺序读一次索引就能随机取任意一张）：
 *
 * ```text
 * [payload 0][payload 1]…[payload n-1][索引 JSON][u32 索引长度][magic "CGA1"]
 * ```
 *
 * 索引 JSON：`{"version":1,"entries":[{"shotId":3,"offset":0,"length":81234,
 * "width":1920,"height":1021,"codec":"jpeg"}]}`
 *
 * 为什么不用 zip / tar：仓库不引新依赖（D30 的口径是「能不引就不引」），而归档要的
 * 随机读取这个格式天生就有。索引在**尾部**，所以写入是「先写载荷、最后写索引」，
 * 半截文件（写了一半就崩）的尾部一定是坏的，解析会如实报错，不会把半张图当成证据。
 *
 * **字节级可逆**：解出来的 payload 与打包前逐字节相同（有单测钉住）。
 */
export const ARCHIVE_MAGIC = 'CGA1'
export const ARCHIVE_VERSION = 1

/** 尾部：索引长度（u32 LE）+ magic（4 字节） */
const TRAILER_BYTES = 8

export type ArchiveCodec = 'jpeg' | 'png'

export interface ArchiveEntryInput {
  shotId: number
  bytes: Buffer
  width: number
  height: number
  /** 缺省 jpeg（现在所有层都是 JPEG） */
  codec?: ArchiveCodec
}

export interface ArchiveEntry {
  shotId: number
  /** 载荷在容器里的起始偏移 */
  offset: number
  length: number
  width: number
  height: number
  codec: ArchiveCodec
}

export interface ArchiveIndex {
  version: number
  entries: ArchiveEntry[]
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}非法：${String(value)}`)
}

/**
 * 组装一个容器。**顺序即偏移顺序**：调用方按稳定顺序给（同一天的截图按 id 排），
 * 这样同一批数据重复打包得到同一份字节。
 */
export function buildArchive(entries: readonly ArchiveEntryInput[]): Buffer {
  const payloads: Buffer[] = []
  const indexEntries: ArchiveEntry[] = []
  const seen = new Set<number>()
  let offset = 0

  for (const entry of entries) {
    assertPositiveInt(entry.shotId, '归档条目 shotId')
    assertPositiveInt(entry.width, '归档条目宽')
    assertPositiveInt(entry.height, '归档条目高')
    if (entry.bytes.length === 0) throw new Error(`归档条目 ${entry.shotId} 的图片是空的`)
    if (seen.has(entry.shotId)) throw new Error(`归档条目 shotId 重复：${entry.shotId}`)
    seen.add(entry.shotId)

    indexEntries.push({
      shotId: entry.shotId,
      offset,
      length: entry.bytes.length,
      width: entry.width,
      height: entry.height,
      codec: entry.codec ?? 'jpeg'
    })
    payloads.push(entry.bytes)
    offset += entry.bytes.length
  }

  const indexJson = Buffer.from(
    JSON.stringify({ version: ARCHIVE_VERSION, entries: indexEntries }),
    'utf8'
  )
  const trailer = Buffer.alloc(TRAILER_BYTES)
  trailer.writeUInt32LE(indexJson.length, 0)
  trailer.write(ARCHIVE_MAGIC, 4, 'latin1')
  return Buffer.concat([...payloads, indexJson, trailer])
}

/**
 * 解析索引并校验结构。**半截 / 损坏的容器直接抛错**——宁可当「读不出来」，
 * 也不把越界或半张图当证据（与「错证据比没证据更糟」同一条纪律）。
 */
export function parseArchiveIndex(buffer: Buffer): ArchiveIndex {
  if (buffer.length < TRAILER_BYTES) throw new Error('归档容器太短，不是有效文件')
  const magic = buffer.toString('latin1', buffer.length - 4)
  if (magic !== ARCHIVE_MAGIC) throw new Error(`归档容器 magic 不对：${JSON.stringify(magic)}`)

  const indexLength = buffer.readUInt32LE(buffer.length - TRAILER_BYTES)
  const indexStart = buffer.length - TRAILER_BYTES - indexLength
  if (indexLength <= 0 || indexStart < 0) throw new Error('归档容器索引长度越界')

  let parsed: unknown
  try {
    parsed = JSON.parse(buffer.toString('utf8', indexStart, indexStart + indexLength))
  } catch (error) {
    throw new Error(`归档容器索引不是合法 JSON：${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('归档容器索引结构非法')
  const record = parsed as { version?: unknown; entries?: unknown }
  if (record.version !== ARCHIVE_VERSION) {
    throw new Error(`归档容器版本不支持：${String(record.version)}`)
  }
  if (!Array.isArray(record.entries)) throw new Error('归档容器索引缺少 entries')

  const seen = new Set<number>()
  const entries: ArchiveEntry[] = []
  for (const raw of record.entries) {
    if (typeof raw !== 'object' || raw === null) throw new Error('归档条目结构非法')
    const item = raw as Record<string, unknown>
    const shotId = item.shotId
    const offset = item.offset
    const length = item.length
    const width = item.width
    const height = item.height
    const codec = item.codec
    assertPositiveInt(shotId as number, '归档条目 shotId')
    if (!Number.isInteger(offset) || (offset as number) < 0) throw new Error('归档条目 offset 非法')
    if (!Number.isInteger(length) || (length as number) <= 0) throw new Error('归档条目 length 非法')
    assertPositiveInt(width as number, '归档条目宽')
    assertPositiveInt(height as number, '归档条目高')
    if (codec !== 'jpeg' && codec !== 'png') throw new Error(`归档条目 codec 非法：${String(codec)}`)
    if ((offset as number) + (length as number) > indexStart) throw new Error('归档条目越界')
    if (seen.has(shotId as number)) throw new Error(`归档条目 shotId 重复：${String(shotId)}`)
    seen.add(shotId as number)
    entries.push({
      shotId: shotId as number,
      offset: offset as number,
      length: length as number,
      width: width as number,
      height: height as number,
      codec
    })
  }
  return { version: ARCHIVE_VERSION, entries }
}

export interface ExtractedArchiveEntry {
  bytes: Buffer
  width: number
  height: number
  codec: ArchiveCodec
}

/** 按 shotId 取出一张（拷贝成独立 Buffer，调用方可以随便用）。找不到返回 null。 */
export function extractArchiveEntry(buffer: Buffer, shotId: number): ExtractedArchiveEntry | null {
  const { entries } = parseArchiveIndex(buffer)
  const entry = entries.find((item) => item.shotId === shotId)
  if (!entry) return null
  return {
    bytes: Buffer.from(buffer.subarray(entry.offset, entry.offset + entry.length)),
    width: entry.width,
    height: entry.height,
    codec: entry.codec
  }
}

/** 容器里有哪些 shotId（重建时用来对齐已有条目） */
export function archiveShotIds(buffer: Buffer): number[] {
  return parseArchiveIndex(buffer).entries.map((entry) => entry.shotId)
}
