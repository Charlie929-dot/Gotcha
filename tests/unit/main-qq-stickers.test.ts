/**
 * QQ 表情包池（D96 / PR2）
 *
 * 守这些事：哈希 id 去重、分层（收藏 / 候选 / 回收站）、各层上限最旧淘汰、
 * 总容量满了如实拒绝、索引落盘能重读、坏索引按空启动、图鉴按常用度排、
 * 设置抽屉视图的缩略图只给小图。
 */

import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildQqStickerListView,
  QqStickerStore,
  QQ_STICKER_DESC_MAX_CHARS,
  type QqStickerStoreOptions
} from '../../src/main/qq/stickers'

/** 1×1 PNG / GIF（只验字节口径，不验像素） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** 同一张图但改一个字节：仍然合法 PNG 头，哈希不同（测试多层淘汰用） */
function variant(base: Buffer, index: number): Buffer {
  const copy = Buffer.from(base)
  // 改 PNG 末尾的 IEND CRC 区（解码不验，哈希会变）
  copy[copy.length - 1] = (index + 1) % 250
  return copy
}

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gotcha-stickers-'))
  roots.push(root)
  return root
}

function storeOf(overrides: Partial<QqStickerStoreOptions> = {}): QqStickerStore {
  const root = overrides.root ?? tempRoot()
  return new QqStickerStore({
    root,
    now: () => 1_760_000_000_000,
    ...overrides
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('收图与去重（D96 / PR2）', () => {
  it('收一张：id 是 sha256 前 12 位，文件落在 library，索引里有一条', () => {
    const store = storeOf()
    const added = store.add({ bytes: PNG, label: '  无语  ', desc: '被问住的时候' })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.duplicate).toBe(false)
    expect(added.entry.id).toMatch(/^[a-f0-9]{12}$/u)
    expect(added.entry.label).toBe('无语')
    expect(added.entry.desc).toBe('被问住的时候')
    expect(added.entry.layer).toBe('library')
    expect(added.entry.ext).toBe('png')
    expect(existsSync(join(store.path(), 'library', `${added.entry.id}.png`))).toBe(true)
    expect(readdirSync(join(store.path(), 'library'))).toHaveLength(1)
    expect(store.list('library')).toHaveLength(1)
  })

  it('同一张图再收一次：同一个 id，不重复落盘，标签按新的更新', () => {
    const store = storeOf()
    const first = store.add({ bytes: PNG, label: '无语' })
    expect(first.ok).toBe(true)
    const second = store.add({ bytes: Buffer.from(PNG), label: '翻白眼', desc: '看傻子' })
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.duplicate).toBe(true)
    expect(second.entry.label).toBe('翻白眼')
    expect(second.entry.desc).toBe('看傻子')
    expect(readdirSync(join(store.path(), 'library'))).toHaveLength(1)
  })

  it('只收 png / jpg / gif / webp；空图、超大图、没标签都如实拒绝', () => {
    const store = storeOf({ maxFileBytes: 64 })
    expect(store.add({ bytes: Buffer.from('not an image'), label: 'x' }).ok).toBe(false)
    expect(store.add({ bytes: Buffer.alloc(0), label: 'x' }).ok).toBe(false)
    expect(store.add({ bytes: PNG, label: 'x' }).ok).toBe(false)
    const big = storeOf()
    expect(big.add({ bytes: PNG, label: '   ' }).ok).toBe(false)
    const tooBig = storeOf({ maxFileBytes: 10 })
    const refused = tooBig.add({ bytes: PNG, label: 'x' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain('太大')
  })

  it('描述超长截断（不劈坏 emoji）', () => {
    const store = storeOf()
    const added = store.add({ bytes: PNG, label: 'a', desc: '长'.repeat(200) })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(Array.from(added.entry.desc)).toHaveLength(QQ_STICKER_DESC_MAX_CHARS)
  })

  it('GIF 原样保留（扩展名 gif，字节不变）', () => {
    const store = storeOf()
    const added = store.add({ bytes: GIF, label: '动图' })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.entry.ext).toBe('gif')
    const read = store.read(added.entry.id)
    expect(read?.bytes.equals(GIF)).toBe(true)
  })
})

describe('分层与上限（D96 / PR2）', () => {
  it('移入回收站 / 还原：文件跟着换目录，索引跟着改', () => {
    const store = storeOf()
    const added = store.add({ bytes: PNG, label: '无语' })
    if (!added.ok) throw new Error('收图失败')
    const trashed = store.move(added.entry.id, 'trash')
    expect(trashed.ok).toBe(true)
    expect(store.get(added.entry.id)?.layer).toBe('trash')
    expect(existsSync(join(store.path(), 'trash', `${added.entry.id}.png`))).toBe(true)
    expect(existsSync(join(store.path(), 'library', `${added.entry.id}.png`))).toBe(false)

    const restored = store.move(added.entry.id, 'library')
    expect(restored.ok).toBe(true)
    expect(store.get(added.entry.id)?.layer).toBe('library')
    expect(store.list('trash')).toHaveLength(0)
  })

  it('收藏层超上限：最旧的软删进回收站（还能还原）', () => {
    const store = storeOf({ maxLibrary: 2 })
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const added = store.add({ bytes: variant(PNG, index), label: `第${index}张` })
      if (!added.ok) throw new Error('收图失败')
      ids.push(added.entry.id)
    }
    expect(store.list('library')).toHaveLength(2)
    expect(store.list('trash')).toHaveLength(1)
    expect(store.get(ids[0]!)?.layer).toBe('trash')
    expect(store.get(ids[2]!)?.layer).toBe('library')
  })

  it('回收站超上限：按最旧物理删（文件也删掉）', () => {
    const store = storeOf({ maxLibrary: 1, maxTrash: 1 })
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const added = store.add({ bytes: variant(PNG, index + 10), label: `第${index}张` })
      if (!added.ok) throw new Error('收图失败')
      ids.push(added.entry.id)
    }
    expect(store.list('trash')).toHaveLength(1)
    expect(store.get(ids[0]!)).toBeNull()
    expect(existsSync(join(store.path(), 'trash', `${ids[0]!}.png`))).toBe(false)
  })

  it('总容量放不下：先清回收站，还放不下就如实拒绝（不偷偷删收藏）', () => {
    // 只放得下两张：收第三张时必须先把回收站里的 a 物理删掉
    const store = storeOf({ maxTotalBytes: PNG.length * 2 + 10 })
    const first = store.add({ bytes: variant(PNG, 1), label: 'a' })
    const second = store.add({ bytes: variant(PNG, 2), label: 'b' })
    if (!first.ok || !second.ok) throw new Error('收图失败')
    // 把 a 扔进回收站：总容量不变，但再收一张会先清回收站腾地方
    store.move(first.entry.id, 'trash')
    const third = store.add({ bytes: variant(PNG, 3), label: 'c' })
    expect(third.ok).toBe(true)
    expect(store.get(first.entry.id)).toBeNull()

    // 池子塞满后再收：拒绝，且已有收藏还在
    const refused = store.add({ bytes: variant(PNG, 4), label: 'd' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain('满')
    expect(store.list('library').length).toBeGreaterThan(0)
  })

  it('彻底删：索引与文件一起没', () => {
    const store = storeOf()
    const added = store.add({ bytes: PNG, label: '无语' })
    if (!added.ok) throw new Error('收图失败')
    expect(store.remove(added.entry.id)).toBe(true)
    expect(store.get(added.entry.id)).toBeNull()
    expect(existsSync(join(store.path(), 'library', `${added.entry.id}.png`))).toBe(false)
    expect(store.remove(added.entry.id)).toBe(false)
  })

  it('文件丢了：读返回 null，载入时把幽灵条目清掉', () => {
    const root = tempRoot()
    const store = storeOf({ root })
    const added = store.add({ bytes: PNG, label: '无语' })
    if (!added.ok) throw new Error('收图失败')
    unlinkSync(join(root, 'library', `${added.entry.id}.png`))
    expect(store.read(added.entry.id)).toBeNull()
    const reloaded = storeOf({ root })
    expect(reloaded.get(added.entry.id)).toBeNull()
    expect(reloaded.list()).toHaveLength(0)
  })
})

describe('落盘与视图（D96 / PR2）', () => {
  it('换一个实例还能读到（重启后图鉴还在）', () => {
    const root = tempRoot()
    const first = storeOf({ root })
    const added = first.add({ bytes: PNG, label: '无语', desc: '被问住', tags: ['无语', '翻白眼'] })
    if (!added.ok) throw new Error('收图失败')
    const second = storeOf({ root })
    const got = second.get(added.entry.id)
    expect(got?.label).toBe('无语')
    expect(got?.desc).toBe('被问住')
    expect(got?.tags).toEqual(['无语', '翻白眼'])
    expect(second.catalog()).toHaveLength(1)
  })

  it('索引坏了：按空池启动，不删用户的文件、也不抛', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'index.json'), '{ 这不是 json', 'utf8')
    const store = storeOf({ root })
    expect(store.list()).toHaveLength(0)
    // 还能继续收
    expect(store.add({ bytes: PNG, label: '新的' }).ok).toBe(true)
  })

  it('图鉴按「用过几次 / 最近用过」排，最多 40 条', () => {
    // 时钟往前走：先收的在前，再靠 touch 把「用过的那张」顶上来
    let clock = 1_760_000_000_000
    const store = storeOf({ now: () => (clock += 1_000) })
    const a = store.add({ bytes: variant(PNG, 20), label: 'a' })
    const b = store.add({ bytes: variant(PNG, 21), label: 'b' })
    if (!a.ok || !b.ok) throw new Error('收图失败')
    expect(store.catalog()[0]?.label).toBe('b')
    store.touch(a.entry.id)
    expect(store.catalog()[0]?.label).toBe('a')
    expect(store.catalog(1)).toHaveLength(1)
  })

  it('视图：统计张数 / 字节；小图给缩略图，大图只列标签', () => {
    const store = storeOf()
    const small = store.add({ bytes: PNG, label: '小图' })
    const big = store.add({ bytes: Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), label: '大图' })
    // 大图字节头还是 PNG，能收；但超过 256KB 的缩略图上限
    if (!small.ok || !big.ok) throw new Error('收图失败')
    const view = buildQqStickerListView(store)
    expect(view.ok).toBe(true)
    expect(view.stats.library).toBe(2)
    expect(view.stats.bytes).toBe(PNG.length + big.entry.bytes)
    const smallItem = view.items.find((item) => item.id === small.entry.id)
    const bigItem = view.items.find((item) => item.id === big.entry.id)
    expect(smallItem?.thumb?.startsWith('data:image/png;base64,')).toBe(true)
    expect(bigItem?.thumb).toBeUndefined()
    // 视图里不带路径 / 字节
    expect(JSON.stringify(view)).not.toContain(store.path())
  })
})
