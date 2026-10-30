/**
 * 家谱（memory-life M1）：缺省创建 / 原子写 + .bak / 损坏备份重建 / 结构校验。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  childBranches,
  emptyLineage,
  ensureLineage,
  generationOf,
  lifeOf,
  lineageSnapshot,
  LINEAGE_LIFE_TOKENS,
  parseLineage,
  readLineage,
  recordLineageUsage,
  withActive,
  withBranchAdded,
  withBranchRemoved,
  writeLineage
} from '../../src/main/lineage'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-lineage-'))
  dirs.push(dir)
  return join(dir, 'memory-lineage.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('家谱', () => {
  it('文件不存在时建第一代 default，并写下文件', async () => {
    const file = tempFile()
    const result = await ensureLineage(file, { now: 1000 })
    expect(result.created).toBe(true)
    expect(result.recovered).toBe(false)
    expect(result.lineage.active).toBe('default')
    expect(result.lineage.life_tokens).toBe(LINEAGE_LIFE_TOKENS)
    expect(result.lineage.generations).toEqual([
      expect.objectContaining({ id: 'gen-1', branch: 'default', nickname: 'default', mother: null, born_at: 1000 })
    ])
    expect(result.lineage.branches).toEqual([
      expect.objectContaining({ branch: 'default', generation: 'gen-1', parent: null, status: 'alive' })
    ])
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('写入再读回一致；第二次写留一份 .bak', async () => {
    const file = tempFile()
    const first = emptyLineage(1000)
    expect(await writeLineage(file, first)).toBe(true)
    const second = {
      ...first,
      active: 'spring',
      branches: [
        ...first.branches,
        { branch: 'spring', generation: 'gen-1', parent: 'default', created_at: 2000, status: 'alive' as const, life_tokens_used: 0 }
      ]
    }
    expect(await writeLineage(file, second)).toBe(true)
    expect(existsSync(`${file}.bak`)).toBe(true)
    // .bak 是上一次的内容
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).active).toBe('default')

    const read = await readLineage(file)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('spring')
    expect(read.lineage.branches.map((branch) => branch.branch)).toEqual(['default', 'spring'])
  })

  it('坏 JSON：备份成 .corrupt-<时间> 后重建，不静默丢原文件', async () => {
    const file = tempFile()
    writeFileSync(file, '{oops', 'utf8')
    const result = await ensureLineage(file, { now: 4242 })
    expect(result.recovered).toBe(true)
    expect(result.created).toBe(false)
    expect(result.backupPath).toBe(`${file}.corrupt-4242`)
    expect(existsSync(`${file}.corrupt-4242`)).toBe(true)
    expect(readFileSync(`${file}.corrupt-4242`, 'utf8')).toBe('{oops')

    const read = await readLineage(file)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('default')
  })

  it('结构不认识（缺字段 / active 不在分支表里）也算坏，按重建处理', async () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8')
    expect((await readLineage(file)).status).toBe('invalid')
    expect((await ensureLineage(file, { now: 1 })).recovered).toBe(true)

    const lineage = emptyLineage(1)
    writeFileSync(file, JSON.stringify({ ...lineage, active: 'nope' }), 'utf8')
    expect((await readLineage(file)).status).toBe('invalid')
  })

  it('仓内快照是稳定格式（缩进 2、末尾换行），能被 parseLineage 认回', () => {
    const lineage = emptyLineage(7)
    const text = lineageSnapshot(lineage)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "version": 1,')
    expect(parseLineage(JSON.parse(text))).toEqual(lineage)
  })
})

describe('家谱 · 节点（分支）操作', () => {
  it('追加节点：重名 / 代不存在 / 父节点不存在都返回 null', () => {
    const base = emptyLineage(1000)
    const added = withBranchAdded(base, {
      branch: 'spring',
      generation: 'gen-1',
      parent: 'default',
      at: 2000
    })
    expect(added?.branches.map((item) => item.branch)).toEqual(['default', 'spring'])
    expect(added?.branches[1]).toMatchObject({ parent: 'default', status: 'alive', created_at: 2000 })

    expect(added).not.toBeNull()
    if (added === null) return
    expect(withBranchAdded(added, { branch: 'spring', generation: 'gen-1', parent: 'default', at: 2 })).toBeNull()
    expect(withBranchAdded(base, { branch: 'x', generation: 'gen-9', parent: 'default', at: 2 })).toBeNull()
    expect(withBranchAdded(base, { branch: 'x', generation: 'gen-1', parent: 'nope', at: 2 })).toBeNull()
    expect(withBranchAdded(base, { branch: '  ', generation: 'gen-1', parent: 'default', at: 2 })).toBeNull()
  })

  it('切 active：存在才切；已经在该节点就原样返回', () => {
    const base = emptyLineage(1000)
    const added = withBranchAdded(base, {
      branch: 'spring',
      generation: 'gen-1',
      parent: 'default',
      at: 2000
    })
    expect(added).not.toBeNull()
    if (added === null) return
    expect(withActive(added, 'spring')?.active).toBe('spring')
    expect(withActive(added, 'nope')).toBeNull()
    expect(withActive(base, 'default')).toBe(base)
  })

  it('删节点：当前 / 代主分支 / 有子节点都不许删', () => {
    const base = emptyLineage(1000)
    const spring = withBranchAdded(base, {
      branch: 'spring',
      generation: 'gen-1',
      parent: 'default',
      at: 2
    })
    expect(spring).not.toBeNull()
    if (spring === null) return

    // default 同时是当前节点与 gen-1 的主分支
    expect(withBranchRemoved(spring, 'default')).toBeNull()
    // spring 不是当前节点，可以删
    expect(withBranchRemoved(spring, 'spring')?.branches.map((item) => item.branch)).toEqual(['default'])
    // 切到 spring 之后就不许删了
    const onSpring = withActive(spring, 'spring')
    expect(onSpring).not.toBeNull()
    if (onSpring === null) return
    expect(withBranchRemoved(onSpring, 'spring')).toBeNull()

    // spring 下面有 winter：有后代不许删
    const winter = withBranchAdded(spring, {
      branch: 'winter',
      generation: 'gen-1',
      parent: 'spring',
      at: 3
    })
    expect(winter).not.toBeNull()
    if (winter === null) return
    expect(childBranches(winter, 'spring').map((item) => item.branch)).toEqual(['winter'])
    expect(withBranchRemoved(winter, 'spring')).toBeNull()
    expect(withBranchRemoved(winter, 'winter')?.branches.map((item) => item.branch)).toEqual([
      'default',
      'spring'
    ])
    expect(withBranchRemoved(winter, 'nope')).toBeNull()
  })

  it('generationOf 找到所属代', () => {
    const base = emptyLineage(1000)
    expect(generationOf(base, 'default')?.id).toBe('gen-1')
    expect(generationOf(base, 'nope')).toBeNull()
  })
})

describe('生命记账（M3）', () => {
  it('recordUsage 按节点记；lifeOf 算剩余与百分比', async () => {
    const file = tempFile()
    await ensureLineage(file, { now: 1 })
    const base = emptyLineage(1)
    const spring = withBranchAdded(base, {
      branch: 'spring',
      generation: 'gen-1',
      parent: 'default',
      at: 2
    })
    expect(spring).not.toBeNull()
    if (spring === null) return
    await writeLineage(file, spring)

    expect(await recordLineageUsage(file, 'spring', 150_000)).toBe(true)
    const read = await readLineage(file)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(lifeOf(read.lineage, 'spring')).toMatchObject({
      used: 150_000,
      limit: LINEAGE_LIFE_TOKENS,
      remaining: 350_000,
      percent: 70
    })
    // 兄弟节点各记各的
    expect(lifeOf(read.lineage, 'default')).toMatchObject({ used: 0, percent: 100 })
    // 不存在的节点不记
    expect(await recordLineageUsage(file, 'nope', 1)).toBe(false)
    // 用完时剩余 0、百分比 0（不出现负数）
    expect(await recordLineageUsage(file, 'spring', 600_000)).toBe(true)
    const done = await readLineage(file)
    if (done.status !== 'ok') return
    expect(lifeOf(done.lineage, 'spring')).toMatchObject({ remaining: 0, percent: 0 })
  })

  it('旧家谱没有 life_tokens_used 字段时按 0 读（向后兼容）', async () => {
    const file = tempFile()
    const raw = {
      version: 1,
      life_tokens: 500_000,
      active: 'default',
      generations: [
        {
          id: 'gen-1',
          branch: 'default',
          nickname: 'default',
          mother: null,
          born_at: 1,
          died_at: null,
          life_tokens_used: 0,
          letter: null
        }
      ],
      branches: [{ branch: 'default', generation: 'gen-1', parent: null, created_at: 1, status: 'alive' }]
    }
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    const read = await readLineage(file)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.branches[0]?.life_tokens_used).toBe(0)
    expect(lifeOf(read.lineage, 'default')?.percent).toBe(100)
  })
})
