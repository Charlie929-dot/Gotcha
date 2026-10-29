/**
 * 个人记忆 · 向量索引（vectors.ts，schema v10）
 *
 * 三条底线：
 * 1）增量：正文指纹没变就不重算（省 CPU，也省启动时间）；
 * 2）孤儿：条目删了 / 正文改了换 uid，旧向量必须被清掉，否则「想到的」会指向不存在的内容；
 * 3）坏数据不添乱：维度不符的向量跳过，不抛错、不写半批。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type Db } from '../../src/db'
import { textHash } from '../../src/memory/recall'
import { syncVault } from '../../src/memory/store'
import {
  countPendingVectors,
  indexDiaryVectors,
  listDiaryRecallCandidates,
  listDiaryVectors,
  memoryVectorStats,
  packVector,
  pruneOrphanVectors,
  unpackVector
} from '../../src/memory/vectors'

const MODEL = 'fake-embed-v1'
const DIM = 4

const dayA = `---
🌻日期🌻: 2026-10-28
---
# Tracking
- [ ] 写周报

# Diary
- 08:40 今天早上有点困，昨晚没睡好。
- 21:00 晚上整理了一遍记忆球的设计稿。
`

const dayB = `---
🌻日期🌻: 2026-10-29
---
# Diary
- 09:10 开始写周报，先把上周的数据翻出来。
`

interface FakeEmbedder {
  readonly model: string
  readonly dim: number
  calls: number
  embed(texts: readonly string[]): Promise<Float32Array[]>
}

/** 假 embedder：可注入维度（测坏数据），按输入顺序返回同数量向量 */
function fakeEmbedder(options: { dim?: number; returnDim?: number } = {}): FakeEmbedder {
  const dim = options.dim ?? DIM
  const returnDim = options.returnDim ?? dim
  return {
    model: MODEL,
    dim,
    calls: 0,
    async embed(texts) {
      this.calls += 1
      return texts.map((text, index) => {
        const vec = new Float32Array(returnDim)
        vec[0] = 1
        vec[1] = (text.length % 50) / 50
        vec[2] = index / 10
        return vec
      })
    }
  }
}

let db: Db
let dir = ''

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8')
}

function vectorRows(): Array<{ item_id: string; text_hash: string; len: number }> {
  return db
    .prepare('SELECT item_id, text_hash, length(vector) AS len FROM mem_vectors ORDER BY item_id')
    .all() as Array<{ item_id: string; text_hash: string; len: number }>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotcha-mem-vectors-'))
  db = openDatabase(':memory:')
  write('2026-10-28.md', dayA)
  write('2026-10-29.md', dayB)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('packVector / unpackVector', () => {
  it('往返一致；长度对不上返回 null', () => {
    const vec = new Float32Array([0.1, -0.2, 0.3, 0.4])
    const blob = packVector(vec)
    expect(blob.byteLength).toBe(DIM * 4)
    expect(Array.from(unpackVector(blob, DIM)!)).toEqual(Array.from(vec))
    expect(unpackVector(blob, 8)).toBeNull()
    expect(unpackVector(null, DIM)).toBeNull()
  })
})

describe('indexDiaryVectors', () => {
  it('首次索引全部条目，写过指纹；第二次一条都不重算', async () => {
    syncVault(db, dir, { now: 1_000 })
    const embedder = fakeEmbedder()
    const first = await indexDiaryVectors(db, embedder, { now: 2_000 })
    expect(first.embedded).toBe(4)
    expect(first.remaining).toBe(0)
    expect(first.model).toBe(MODEL)
    const rows = vectorRows()
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.len === DIM * 4)).toBe(true)

    const callsAfterFirst = embedder.calls
    const second = await indexDiaryVectors(db, embedder, { now: 3_000 })
    expect(second.embedded).toBe(0)
    expect(second.unchanged).toBe(4)
    expect(embedder.calls).toBe(callsAfterFirst)
  })

  it('指纹存的是正文哈希（和 recall.textHash 同口径）', async () => {
    syncVault(db, dir, { now: 1_000 })
    await indexDiaryVectors(db, fakeEmbedder(), { now: 2_000 })
    const { text } = db
      .prepare("SELECT text FROM mem_items WHERE text LIKE '%今天早上有点困%'")
      .get() as { text: string }
    const row = db
      .prepare('SELECT text_hash FROM mem_vectors WHERE item_id = (SELECT uid FROM mem_items WHERE text LIKE ?)')
      .get('%今天早上有点困%') as { text_hash: string }
    expect(row.text_hash).toBe(textHash(text))
  })

  it('limit 分批：一次只算一部分，剩下的下一次续', async () => {
    syncVault(db, dir, { now: 1_000 })
    const first = await indexDiaryVectors(db, fakeEmbedder(), { limit: 2, now: 2_000 })
    expect(first.embedded).toBe(2)
    expect(first.remaining).toBe(2)
    const second = await indexDiaryVectors(db, fakeEmbedder(), { limit: 2, now: 3_000 })
    expect(second.embedded).toBe(2)
    expect(second.remaining).toBe(0)
  })

  it('正文改了 → uid 换新，新条目被索引、旧的成孤儿', async () => {
    syncVault(db, dir, { now: 1_000 })
    const embedder = fakeEmbedder()
    await indexDiaryVectors(db, embedder, { now: 2_000 })
    const before = vectorRows().map((row) => row.item_id)

    // 改一句（同一行正文变了 → uid 变）
    write('2026-10-28.md', dayA.replace('昨晚没睡好。', '昨晚睡得还行。'))
    syncVault(db, dir, { now: 3_000 })
    const pruned = pruneOrphanVectors(db)
    expect(pruned).toBe(1)
    const result = await indexDiaryVectors(db, embedder, { now: 4_000 })
    expect(result.embedded).toBe(1)
    const after = vectorRows().map((row) => row.item_id)
    expect(after).toHaveLength(4)
    expect(after.filter((uid) => before.includes(uid))).toHaveLength(3)
  })

  it('维度不符的向量跳过，不写半批、不抛错', async () => {
    syncVault(db, dir, { now: 1_000 })
    const result = await indexDiaryVectors(db, fakeEmbedder({ dim: 4, returnDim: 8 }), { now: 2_000 })
    expect(result.embedded).toBe(0)
    expect(result.skipped).toBe(4)
    expect(vectorRows()).toHaveLength(0)
  })

  it('空正文不送进 embedder', async () => {
    syncVault(db, dir, { now: 1_000 })
    const task = db.prepare("SELECT uid FROM mem_items WHERE kind = 'task' LIMIT 1").get() as {
      uid: string
    }
    db.prepare('UPDATE mem_items SET text = ? WHERE uid = ?').run('   ', task.uid)
    const embedder = fakeEmbedder()
    const result = await indexDiaryVectors(db, embedder, { now: 2_000 })
    expect(result.skipped).toBe(1)
    expect(result.embedded).toBe(3)
  })
})

describe('孤儿清理 / 读取', () => {
  it('条目被删（不在 mem_items 里）→ 向量被清掉', async () => {
    syncVault(db, dir, { now: 1_000 })
    await indexDiaryVectors(db, fakeEmbedder(), { now: 2_000 })
    expect(vectorRows()).toHaveLength(4)
    db.prepare("DELETE FROM mem_items WHERE text LIKE '%写周报%'").run()
    const pruned = pruneOrphanVectors(db)
    expect(pruned).toBe(2)
    expect(vectorRows()).toHaveLength(2)
  })

  it('listDiaryVectors / 回想候选：带时间与 payload，坏长度行跳过', async () => {
    syncVault(db, dir, { now: 1_000 })
    await indexDiaryVectors(db, fakeEmbedder(), { now: 2_000 })
    const rows = listDiaryVectors(db, MODEL, DIM)
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.vec.length === DIM)).toBe(true)

    const candidates = listDiaryRecallCandidates(db, MODEL, DIM)
    expect(candidates).toHaveLength(4)
    expect(candidates.every((item) => item.id.startsWith('diary:'))).toBe(true)
    expect(candidates.some((item) => item.ts !== null)).toBe(true)
    const payload = candidates.find((item) => (item.payload as { text: string }).text.includes('周报'))
    expect(payload).toBeDefined()

    // 换成 8 维读：全是坏行，全部跳过
    expect(listDiaryVectors(db, MODEL, 8)).toHaveLength(0)
  })

  it('stats：条目数 / 向量数 / 待索引数 / 用过的模型', async () => {
    syncVault(db, dir, { now: 1_000 })
    expect(memoryVectorStats(db, MODEL).pending).toBe(4)
    await indexDiaryVectors(db, fakeEmbedder(), { now: 2_000 })
    const stats = memoryVectorStats(db, MODEL)
    expect(stats).toMatchObject({ items: 4, vectors: 4, pending: 0, models: [MODEL] })
    expect(countPendingVectors(db, MODEL)).toBe(0)
  })
})
