/**
 * 生命耗尽时的兜底传承（2026-11-02，D97）
 *
 * 守这几件事：
 * 1. 生命耗尽、还活着、是 persona/chat、还没有女儿 → 闸门给「临终传承轮」（不再一句冻结）；
 * 2. 纯模型分支（assistant）不触发传承；出生主干 / dead / 已经有女儿 → 照旧拒绝；
 * 3. 模型不配合（没调 give_birth）/ 模型不可用：主进程兜底写信 + 生女儿，有明确结果；
 * 4. 信真的被带进女儿分支（未读）；重复触发不重复出生；
 * 5. 兜底失败不抛、不锁死，只回一句人话。
 *
 * 用真实 git 仓 + 真实家谱（不启动 Electron），与 `main-give-birth-real` 同一套做法。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { giveBirth } from '../../src/main/give-birth'
import { createLetterStore } from '../../src/main/letters'
import {
  ensureLineage,
  findBranch,
  generationOf,
  lineageSnapshot,
  readLineage,
  recordLineageUsage,
  withBranchAdded,
  type Lineage
} from '../../src/main/lineage'
import {
  fallbackDaughterName,
  fallbackLetterText,
  inheritAfterLife,
  lifeGateOf,
  settleLifeHandover
} from '../../src/main/life-inherit'
import { createMemoryRepo, type MemoryRepo } from '../../src/main/memory-repo'

const TIMEOUT = 90_000
const LIFE_LIMIT = 500_000
const NOW = new Date(2026, 10, 2, 15, 0, 0, 0).getTime()

const dirs: string[] = []
let dir: string
let repo: MemoryRepo
let lineageFile: string
let desktopDir: string

/** 纯家谱（不建 git 仓）：走闸门 / 名字 / 信那几条用不到仓 */
async function setupLineage(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'gotcha-life-inherit-'))
  dirs.push(dir)
  lineageFile = join(dir, 'memory-lineage.json')
  desktopDir = join(dir, 'desktop')
  await ensureLineage(lineageFile, { now: 1_000 })
}

/** 真实 git 仓（会生女儿 / 写信的那几条才建） */
async function setupRepo(): Promise<void> {
  repo = createMemoryRepo({ root: join(dir, 'memory-repo') })
  expect((await repo.ensure()).ok).toBe(true)
}

function letters() {
  return createLetterStore({ repo, desktopDir, now: () => NOW })
}

/** 生命推到额度之外（真机事故那一档：617550 / 500000） */
async function exhaust(): Promise<void> {
  expect(await recordLineageUsage(lineageFile, 'default', 617_550)).toBe(true)
}

beforeEach(async () => {
  await setupLineage()
})

afterEach(() => {
  for (const entry of dirs.splice(0)) rmSync(entry, { recursive: true, force: true })
})

/** 纯家谱：默认那一代（gen-1 / default，persona） */
async function seededLineage(): Promise<Lineage> {
  const read = await readLineage(lineageFile)
  if (read.status !== 'ok') throw new Error('lineage missing')
  return read.lineage
}

function withUsage(lineage: Lineage, branch: string, used: number): Lineage {
  return {
    ...lineage,
    branches: lineage.branches.map((item) =>
      item.branch === branch ? { ...item, life_tokens_used: used } : item
    )
  }
}

describe('lifeGateOf：生命闸门', () => {
  it('生命耗尽、还活着、是 persona、还没传承 → 交给兜底传承（不再冻结）', async () => {
    const lineage = withUsage(await seededLineage(), 'default', LIFE_LIMIT + 117_550)
    const gate = lifeGateOf(lineage)
    expect(gate).toMatchObject({ kind: 'inherit', branch: 'default' })
  })

  it('生命没耗尽 → 照常放行', async () => {
    const lineage = withUsage(await seededLineage(), 'default', LIFE_LIMIT - 1)
    expect(lifeGateOf(lineage)).toEqual({ kind: 'allow' })
  })

  it('纯模型分支（assistant）不触发传承：有生命但不冻结', async () => {
    const base = await seededLineage()
    const withAsk = withBranchAdded(base, {
      branch: 'ask',
      generation: 'gen-1',
      parent: 'default',
      at: 2,
      kind: 'assistant'
    })
    expect(withAsk).not.toBeNull()
    if (withAsk === null) return
    const lineage = withUsage({ ...withAsk, active: 'ask' }, 'ask', LIFE_LIMIT * 2)
    expect(lifeGateOf(lineage)).toEqual({ kind: 'allow' })
  })

  it('出生主干（life）耗尽 → 照旧拒绝（不在主干上传承）', async () => {
    const base = await seededLineage()
    const withTrunk = withBranchAdded(base, {
      branch: 'life',
      generation: 'gen-1',
      parent: 'default',
      at: 2,
      kind: 'life'
    })
    expect(withTrunk).not.toBeNull()
    if (withTrunk === null) return
    const lineage = withUsage({ ...withTrunk, active: 'life' }, 'life', LIFE_LIMIT * 2)
    const gate = lifeGateOf(lineage)
    expect(gate.kind).toBe('blocked')
    if (gate.kind === 'blocked') expect(gate.text).toContain('生命已经结束')
  })

  it('dead 的 persona → 照旧回「已经交给下一代」', async () => {
    const base = await seededLineage()
    const lineage: Lineage = {
      ...base,
      branches: base.branches.map((item) =>
        item.branch === 'default' ? { ...item, status: 'dead' as const } : item
      )
    }
    const gate = lifeGateOf(lineage)
    expect(gate.kind).toBe('blocked')
    if (gate.kind === 'blocked') expect(gate.text).toContain('已经把记忆线交给下一代')
  })

  it('已经有女儿（母亲还 alive 的坏家谱）→ 不再生第二个', async () => {
    const base = await seededLineage()
    const lineage: Lineage = {
      ...withUsage(base, 'default', LIFE_LIMIT + 1),
      generations: [
        ...base.generations,
        {
          id: 'gen-2',
          branch: 'yu-miao',
          nickname: '鱼苗',
          mother: 'gen-1',
          born_at: 2,
          died_at: null,
          life_tokens_used: 0,
          letter: null
        }
      ]
    }
    const gate = lifeGateOf(lineage)
    expect(gate.kind).toBe('blocked')
  })
})

describe('兜底女儿名 / 兜底信', () => {
  it('默认名 = <母亲名>的女儿；重名自动加数字后缀', () => {
    expect(fallbackDaughterName('贴心大肥鱼', { branches: new Set() })).toBe('贴心大肥鱼的女儿')
    const taken = { branches: new Set(['tie-xin-da-fei-yu-de-n-er']) }
    expect(fallbackDaughterName('贴心大肥鱼', taken)).toBe('贴心大肥鱼的女儿2')
  })

  it('兜底信是写给女儿的、落款是母亲（不是提示词，也不冒充模型口吻）', () => {
    const text = fallbackLetterText({ mother: '贴心大肥鱼', daughter: '小鱼苗' })
    expect(text.startsWith('小鱼苗：')).toBe(true)
    expect(text).toContain('—— 贴心大肥鱼')
    expect(text).toContain('道别')
  })
})

describe('inheritAfterLife · 真实 git 仓', () => {
  beforeEach(async () => {
    await setupRepo()
  })

  it('兜底传承：先写信再出生，信带进女儿分支并标未读；重复触发不再生', { timeout: TIMEOUT }, async () => {
    await exhaust()
    const result = await inheritAfterLife(
      { repo, lineageFile, letters: letters(), now: () => NOW },
      { motherBranch: 'default' }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.letterWritten).toBe(true)
    expect(result.daughter).toBe('default的女儿')
    expect(result.receipt).toContain('🎗️提示')
    expect(result.receipt).toContain('生命耗尽')
    expect(result.receipt).toContain('default的女儿')

    // 女儿分支出生了，母亲 dead，当前节点切到女儿
    const branches = (await repo.listBranches()).map((entry) => entry.branch)
    expect(branches).toContain(result.branch)
    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe(result.branch)
    expect(read.lineage.generations).toHaveLength(2)
    expect(findBranch(read.lineage, 'default')?.status).toBe('dead')
    // D98：代不置死，只死母亲那条分支
    expect(generationOf(read.lineage, 'default')?.died_at).toBeNull()
    expect(generationOf(read.lineage, result.branch)?.nickname).toBe('default的女儿')

    // 信真的带进女儿分支：letters/<id>.md 在、unread 里有她那一封
    const unread = JSON.parse((await repo.readFile('letters/unread.json')) ?? '{}')
    expect(unread.unread).toHaveLength(1)
    expect(unread.unread[0]).toMatchObject({ to: 'default的女儿' })
    const letterFile = await repo.readFile(`letters/${unread.unread[0].id}.md`)
    expect(letterFile).toContain('道别')
    expect(letterFile).toContain('来自：default')

    // 重复触发：不再生第二个（家谱两代，active 还在女儿）
    const again = await inheritAfterLife(
      { repo, lineageFile, letters: letters(), now: () => NOW + 1_000 },
      { motherBranch: 'default' }
    )
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.reason).toBe('already')
    const after = await readLineage(lineageFile)
    if (after.status === 'ok') {
      expect(after.lineage.generations).toHaveLength(2)
      expect(after.lineage.active).toBe(result.branch)
    }
  })

  it('模型自己写过待寄的信：兜底不再写第二封（只补出生）', { timeout: TIMEOUT }, async () => {
    await exhaust()
    const written = await letters().write({
      to: 'default的女儿',
      write: '我自己写的那封。',
      at: 'daughter',
      from: 'default'
    })
    expect(written.ok).toBe(true)
    const result = await inheritAfterLife(
      { repo, lineageFile, letters: letters(), now: () => NOW },
      { motherBranch: 'default' }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.letterWritten).toBe(false)
    const unread = JSON.parse((await repo.readFile('letters/unread.json')) ?? '{}')
    expect(unread.unread).toHaveLength(1)
  })

})

/** 不该碰记忆仓的路径：一碰就抛（能证明兜底没有乱走） */
function stubRepo(): MemoryRepo {
  return new Proxy({} as MemoryRepo, {
    get() {
      throw new Error('这条路径不该用到记忆仓')
    }
  })
}

/** 记忆仓坏掉：状态读不出来、分支列不出来 */
function brokenRepo(): MemoryRepo {
  return {
    root: join(tmpdir(), 'gotcha-life-inherit-broken'),
    status: async () => ({ ok: false as const, reason: 'broken' as const }),
    listBranches: async () => []
  } as unknown as MemoryRepo
}

describe('兜底失败 / 约束不放开（不碰真仓）', () => {
  it('还没到 85% 门槛：兜底也生不了（give_birth 的约束不放开）', async () => {
    expect(await recordLineageUsage(lineageFile, 'default', Math.round(LIFE_LIMIT * 0.5))).toBe(true)
    const result = await inheritAfterLife(
      { repo: stubRepo(), lineageFile, now: () => NOW },
      { motherBranch: 'default' }
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too-early')
  })

  it('记忆仓不可用：兜底如实失败（家谱不动、active 不变）', async () => {
    await exhaust()
    const result = await inheritAfterLife(
      { repo: brokenRepo(), lineageFile, now: () => NOW },
      { motherBranch: 'default' }
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('birth')
    const read = await readLineage(lineageFile)
    if (read.status === 'ok') {
      expect(read.lineage.active).toBe('default')
      expect(read.lineage.generations).toHaveLength(1)
    }
  })
})

describe('settleLifeHandover：临终那一问的收口', () => {
  it('模型自己传承了：不重复出生（完全不碰记忆仓）', async () => {
    await exhaust()
    const settled = await settleLifeHandover(
      { repo: stubRepo(), lineageFile, now: () => NOW },
      { motherBranch: 'default', modelInherited: true }
    )
    expect(settled).toEqual({ inherited: true })
  })

  it('兜底失败（节点已经切走）：不抛，回一句人话，家谱不动', async () => {
    await exhaust()
    const settled = await settleLifeHandover(
      { repo: stubRepo(), lineageFile, now: () => NOW },
      { motherBranch: 'not-here', modelInherited: false }
    )
    expect(settled.inherited).toBe(false)
    expect(settled.message).toBeTruthy()
    const read = await readLineage(lineageFile)
    if (read.status === 'ok') {
      expect(read.lineage.generations).toHaveLength(1)
      expect(read.lineage.active).toBe('default')
    }
  })

  describe('真实 git 仓：模型不配合 / 模型不可用', () => {
    beforeEach(async () => {
      await setupRepo()
    })

    it('模型不配合（没调 give_birth）→ 兜底出生并给交接回执', { timeout: TIMEOUT }, async () => {
      await exhaust()
      const settled = await settleLifeHandover(
        { repo, lineageFile, letters: letters(), now: () => NOW },
        { motherBranch: 'default', modelInherited: false }
      )
      expect(settled.inherited).toBe(true)
      expect(settled.receipt).toContain('生命耗尽')
      expect((await repo.listBranches()).length).toBeGreaterThanOrEqual(2)
      const read = await readLineage(lineageFile)
      expect(read.status === 'ok' ? read.lineage.generations.length : 0).toBe(2)
    })
  })
})

describe('giveBirth 的既有约束没有被兜底绕过', () => {
  beforeEach(async () => {
    await setupRepo()
  })

  it('女儿重名：兜底自动换名（不报错），家谱两代', { timeout: TIMEOUT }, async () => {
    await exhaust()
    // 先占掉默认名字对应的分支
    expect((await repo.switchCreateOrphan('tie-xin-da-fei-yu-de-n-er')).ok).toBe(true)
    await repo.writeFile('lineage.snapshot.json', lineageSnapshot(await seededLineage()))
    await repo.commit('memory: occupy name')
    expect((await repo.switchBranch('default')).ok).toBe(true)

    const result = await inheritAfterLife(
      { repo, lineageFile, letters: letters(), now: () => NOW },
      { motherBranch: 'default', motherName: '贴心大肥鱼' }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daughter).toBe('贴心大肥鱼的女儿2')
    const read = await readLineage(lineageFile)
    if (read.status === 'ok') expect(read.lineage.generations).toHaveLength(2)
  })
})
