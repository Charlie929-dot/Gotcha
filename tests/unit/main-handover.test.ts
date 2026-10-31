/**
 * 交接回执（D82）：母亲生命耗尽、下一代接手时给界面的那一行字。
 *
 * 三块：
 * - 文案格式照拍的样板（`=== <母亲> 生命耗尽  ta的女儿 <女儿> 将接续ta的使命===`）；
 * - 什么时候有：这一代已经不在（dead / 有 died_at）且有女儿；
 * - 名字从家谱来（真名优先，老数据回退分支名）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { giveBirth } from '../../src/main/give-birth'
import { displayNameOf, handoverReceiptOf, handoverReceiptText } from '../../src/main/handover'
import {
  ensureLineage,
  generationOf,
  readLineage,
  recordLineageUsage,
  withBranchAdded,
  withGenerationAdded,
  withGenerationRealName,
  type Lineage
} from '../../src/main/lineage'
import { createMemoryRepo, type MemoryRepo } from '../../src/main/memory-repo'

const LIFE_LIMIT = 500_000
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-handover-'))
  dirs.push(dir)
  return dir
}

/** 一代已经交接过的家谱：default（dead）→ yumiao（真名 鱼苗） */
async function handoverLineage(): Promise<{ lineage: Lineage; file: string }> {
  const file = join(tempDir(), 'memory-lineage.json')
  const base = await ensureLineage(file, { now: 1_000 })
  const born = withGenerationAdded(base.lineage, {
    branch: 'yumiao',
    nickname: '鱼苗',
    mother: 'default',
    at: 2_000
  })
  if (born === null) throw new Error('seed failed')
  return { lineage: born, file }
}

describe('回执文案', () => {
  it('照样板拼：尖括号名字、两处空格、结尾紧跟 ===', () => {
    expect(handoverReceiptText({ mother: '贴心大肥鱼', daughter: '鱼苗' })).toBe(
      '=== <贴心大肥鱼> 生命耗尽  ta的女儿 <鱼苗> 将接续ta的使命==='
    )
  })

  it('名字取自家长谱：真名优先，没起过名回退分支名', async () => {
    const { lineage } = await handoverLineage()
    // 老数据：母亲那代 nickname = 分支名
    expect(handoverReceiptOf(lineage, 'default')).toBe(
      '=== <default> 生命耗尽  ta的女儿 <鱼苗> 将接续ta的使命==='
    )
    const named = withGenerationRealName(lineage, 'default', '贴心大肥鱼')
    expect(handoverReceiptOf(named, 'default')).toBe(
      '=== <贴心大肥鱼> 生命耗尽  ta的女儿 <鱼苗> 将接续ta的使命==='
    )
  })
})

describe('什么时候有回执', () => {
  it('这一代还活着：没有', async () => {
    const file = join(tempDir(), 'memory-lineage.json')
    const base = await ensureLineage(file, { now: 1_000 })
    expect(handoverReceiptOf(base.lineage, 'default')).toBeNull()
  })

  it('死了但没有女儿：没有', async () => {
    const file = join(tempDir(), 'memory-lineage.json')
    const base = await ensureLineage(file, { now: 1_000 })
    const dead = {
      ...base.lineage,
      branches: base.lineage.branches.map((item) =>
        item.branch === 'default' ? { ...item, status: 'dead' as const } : item
      )
    }
    expect(handoverReceiptOf(dead, 'default')).toBeNull()
  })

  it('家谱里没有这条分支：没有', async () => {
    const { lineage } = await handoverLineage()
    expect(handoverReceiptOf(lineage, 'nope')).toBeNull()
  })

  it('同代的其它分支（如 test-2）交接：也算这一代，出回执', async () => {
    const { lineage } = await handoverLineage()
    const withSide = withBranchAdded(lineage, {
      branch: 'test-2',
      generation: 'gen-1',
      parent: 'default',
      at: 1_500
    })
    if (withSide === null) throw new Error('seed failed')
    expect(handoverReceiptOf(withSide, 'test-2')).toBe(
      '=== <default> 生命耗尽  ta的女儿 <鱼苗> 将接续ta的使命==='
    )
  })
})

describe('withGenerationRealName', () => {
  it('没起过名（nickname = 分支名）才补；已有真名 / 空名不动', async () => {
    const { lineage } = await handoverLineage()
    const named = withGenerationRealName(lineage, 'default', ' 贴心大肥鱼 ')
    expect(generationOf(named, 'default')?.nickname).toBe('贴心大肥鱼')
    // 已经起过名：不覆盖
    expect(withGenerationRealName(named, 'default', '别的名字')).toBe(named)
    // 空名：不动
    expect(withGenerationRealName(lineage, 'default', '   ')).toBe(lineage)
  })

  it('displayNameOf：真名优先，空串回退分支名', () => {
    expect(
      displayNameOf({
        id: 'gen-1',
        branch: 'default',
        nickname: '',
        mother: null,
        born_at: 1,
        died_at: null,
        life_tokens_used: 0,
        letter: null
      })
    ).toBe('default')
  })
})

describe('真仓：give_birth 写进家谱的是真名，回执能用', () => {
  it('母亲补成人设名、女儿存模型原名；回执按真名拼', { timeout: 60_000 }, async () => {
    const dir = tempDir()
    const repo: MemoryRepo = createMemoryRepo({ root: join(dir, 'memory-repo') })
    expect((await repo.ensure()).ok).toBe(true)
    const lineageFile = join(dir, 'memory-lineage.json')
    await ensureLineage(lineageFile, { now: 1_000 })
    expect(await recordLineageUsage(lineageFile, 'default', Math.round(LIFE_LIMIT * 0.86))).toBe(true)

    const result = await giveBirth(
      { repo, lineageFile },
      { nickname: '鱼苗', motherBranch: 'default', motherName: '贴心大肥鱼' }
    )
    expect(result).toMatchObject({ ok: true, nickname: '鱼苗', branch: 'yu-miao' })

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(generationOf(read.lineage, 'yu-miao')?.nickname).toBe('鱼苗')
    expect(generationOf(read.lineage, 'default')?.nickname).toBe('贴心大肥鱼')
    expect(handoverReceiptOf(read.lineage, 'default')).toBe(
      '=== <贴心大肥鱼> 生命耗尽  ta的女儿 <鱼苗> 将接续ta的使命==='
    )
    // 女儿这一代还活着：她自己身上没有回执
    expect(handoverReceiptOf(read.lineage, 'yu-miao')).toBeNull()
  })
})
