/**
 * 家谱（memory-life M1）：缺省创建 / 原子写 + .bak / 损坏备份重建 / 结构校验。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  birthDayOf,
  childBranches,
  emptyLineage,
  ensureLineage,
  generationOf,
  isMainlineBranch,
  lifeOf,
  lineageSnapshot,
  LINEAGE_LIFE_TOKENS,
  mainBranchForBranch,
  mainBranchOf,
  parseLineage,
  readLineage,
  recordLineageUsage,
  usageAfterCompact,
  withActive,
  withBranchAdded,
  withBranchRemoved,
  withGenerationAdded,
  withMainBranch,
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
        { branch: 'spring', generation: 'gen-1', parent: 'default', created_at: 2000, status: 'alive' as const, life_tokens_used: 0, kind: 'persona' as const }
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

describe('主线（2026-11-01：一代只有一条，只有主线写成长档案）', () => {
  function twoBranches() {
    const base = emptyLineage(1000)
    const next = withBranchAdded(base, {
      branch: 'ask-2',
      generation: 'gen-1',
      parent: 'default',
      at: 2_000
    })
    expect(next).not.toBeNull()
    return next ?? base
  }

  it('缺省 = 这一代出生那条分支；没写进文件也算数', () => {
    const base = emptyLineage(1000)
    expect(base.generations[0]?.main_branch).toBeUndefined()
    expect(mainBranchOf(base, 'gen-1')).toBe('default')
    expect(mainBranchForBranch(base, 'default')).toBe('default')
    expect(isMainlineBranch(base, 'default')).toBe(true)
    // 分支 / 代认不出来 = null，不猜
    expect(mainBranchOf(base, 'gen-9')).toBeNull()
    expect(mainBranchForBranch(base, 'nope')).toBeNull()
    expect(isMainlineBranch(base, 'nope')).toBe(false)
  })

  it('设主线：只认活着的代里的 persona 分支；同一代只有一条', () => {
    const lineage = twoBranches()
    const next = withMainBranch(lineage, 'ask-2')
    expect(next).not.toBeNull()
    if (next === null) return
    expect(next.generations[0]?.main_branch).toBe('ask-2')
    expect(mainBranchOf(next, 'gen-1')).toBe('ask-2')
    // 一代只有一条：default 与 ask-2 都在 gen-1，主线只有一个
    expect(isMainlineBranch(next, 'ask-2')).toBe(true)
    expect(isMainlineBranch(next, 'default')).toBe(false)
    // 纯函数：原来的对象不动
    expect(lineage.generations[0]?.main_branch).toBeUndefined()

    // 不存在的分支
    expect(withMainBranch(next, 'ghost')).toBeNull()
  })

  it('assistant 分支 / 已结束的代不能当主线', () => {
    const base = emptyLineage(1000)
    const withAssistant = withBranchAdded(base, {
      branch: 'plain',
      generation: 'gen-1',
      parent: 'default',
      at: 2_000,
      kind: 'assistant'
    })
    expect(withAssistant).not.toBeNull()
    if (withAssistant === null) return
    expect(withMainBranch(withAssistant, 'plain')).toBeNull()

    const dead = {
      ...withAssistant,
      generations: withAssistant.generations.map((item) => ({ ...item, died_at: 3_000 }))
    }
    expect(withMainBranch(dead, 'default')).toBeNull()
  })

  it('显式主线：写进快照能读回；指向不存在的分支就回落到代分支', () => {
    const lineage = twoBranches()
    const next = withMainBranch(lineage, 'ask-2')
    expect(next).not.toBeNull()
    if (next === null) return
    const parsed = parseLineage(JSON.parse(lineageSnapshot(next)))
    expect(parsed?.generations[0]?.main_branch).toBe('ask-2')
    expect(mainBranchForBranch(parsed ?? next, 'default')).toBe('ask-2')

    // 文件里写着一条已经删掉的分支：不编造，回落
    const dangling = {
      ...next,
      generations: next.generations.map((item) => ({ ...item, main_branch: 'ghost' }))
    }
    expect(mainBranchOf(dangling, 'gen-1')).toBe('default')
  })
})

describe('传承（M4）', () => {
  it('加一代：母亲置 dead、女儿开新 generation + 分支、active 切过去', () => {
    const base = emptyLineage(1000)
    const next = withGenerationAdded(base, {
      branch: 'xiaoyu',
      nickname: 'xiaoyu',
      mother: 'default',
      at: 2_000,
      letter: 'letters/xiaoyu.md'
    })
    expect(next).not.toBeNull()
    if (next === null) return
    expect(next.active).toBe('xiaoyu')
    expect(next.generations).toHaveLength(2)
    expect(next.generations[0]).toMatchObject({ id: 'gen-1', died_at: 2_000 })
    expect(next.generations[1]).toMatchObject({
      id: 'gen-2',
      branch: 'xiaoyu',
      nickname: 'xiaoyu',
      mother: 'gen-1',
      born_at: 2_000,
      died_at: null,
      life_tokens_used: 0,
      letter: 'letters/xiaoyu.md'
    })
    expect(next.branches).toEqual([
      expect.objectContaining({ branch: 'default', status: 'dead' }),
      expect.objectContaining({ branch: 'xiaoyu', generation: 'gen-2', parent: null, status: 'alive', life_tokens_used: 0 })
    ])
    expect(birthDayOf(next, 'xiaoyu')).toBe('1970-01-01')
    expect(withBranchRemoved(next, 'xiaoyu')).toBeNull()
  })

  it('重名 / 母亲不存在 / 母亲已 dead 都返回 null', () => {
    const base = emptyLineage(1000)
    const next = withGenerationAdded(base, {
      branch: 'xiaoyu',
      nickname: 'xiaoyu',
      mother: 'default',
      at: 2_000
    })
    expect(next).not.toBeNull()
    if (next === null) return
    expect(
      withGenerationAdded(next, { branch: 'xiaoyu', nickname: 'x', mother: 'default', at: 3_000 })
    ).toBeNull()
    expect(
      withGenerationAdded(base, { branch: 'x', nickname: 'x', mother: 'nope', at: 3_000 })
    ).toBeNull()
    expect(
      withGenerationAdded(next, { branch: 'x', nickname: 'x', mother: 'default', at: 3_000 })
    ).toBeNull()
  })

  it('birthDayOf 用本地日；不是代分支返回 null', () => {
    const at = new Date(2026, 9, 30, 23, 30).getTime()
    const next = withGenerationAdded(emptyLineage(1), {
      branch: 'xiaoyu',
      nickname: 'xiaoyu',
      mother: 'default',
      at
    })
    expect(next).not.toBeNull()
    if (next === null) return
    expect(birthDayOf(next, 'xiaoyu')).toBe('2026-10-30')
    expect(birthDayOf(next, 'nope')).toBeNull()
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

  it('纯模型分支也记账（D86），dead 仍拒绝', async () => {
    const file = tempFile()
    await ensureLineage(file, { now: 1 })
    const withAsk = withBranchAdded(emptyLineage(1), {
      branch: 'ask',
      generation: 'gen-1',
      parent: 'default',
      at: 2,
      kind: 'assistant'
    })
    expect(withAsk).not.toBeNull()
    if (withAsk === null) return
    await writeLineage(file, withAsk)
    expect(await recordLineageUsage(file, 'ask', 42_000)).toBe(true)
    const read = await readLineage(file)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(lifeOf(read.lineage, 'ask')).toMatchObject({ used: 42_000, percent: 92 })
    const dead = {
      ...read.lineage,
      branches: read.lineage.branches.map((item) =>
        item.branch === 'ask' ? { ...item, status: 'dead' as const } : item
      )
    }
    await writeLineage(file, dead)
    expect(await recordLineageUsage(file, 'ask', 1)).toBe(false)
  })

  it('usageAfterCompact：按送云字符量缩放上一次用量（D97；不调模型就没有摘要 token）', () => {
    // 压掉 90% 正文 → 用量按 10% 算（system / 工具占位符两边都有，不入比值）
    expect(usageAfterCompact(10_000, 100_000, 10_000)).toBe(1_000)
    // 压完反而更大 / 一样大：用量不动（不凭空多扣，也不凭空多给）
    expect(usageAfterCompact(10_000, 10_000, 10_000)).toBe(10_000)
    expect(usageAfterCompact(10_000, 10_000, 12_000)).toBe(10_000)
    // 没有可比正文量（空会话 / 全是短句）：用量不动
    expect(usageAfterCompact(10_000, 0, 0)).toBe(10_000)
    // 坏数据按 0 算，不把 NaN 写进家谱
    expect(usageAfterCompact(Number.NaN, Number.NaN, Number.NaN)).toBe(0)
  })

  it('usageAfterCompact：压完能把越过额度的用量拉回额度以内（不再「压完仍被冻结」）', () => {
    const limit = 500_000
    // 真机事故那一档：617550 / 500000，正文 500k 字压到 40k
    const used = 617_550
    const after = usageAfterCompact(used, 500_000, 40_000)
    expect(after).toBeLessThan(used)
    expect(after).toBeLessThan(limit)
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
