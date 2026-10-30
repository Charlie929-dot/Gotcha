/**
 * 传承 · 真机集成（D73）
 *
 * 不是 fakeRepo：在临时目录里跑**真实 git 仓 + 真实家谱文件**，用假模型触发工具，
 * 覆盖「母亲提交 → 主干出生提交 → 女儿 orphan 空树 → 家谱新代 → 信」。
 * 不启动 Electron（不弹窗口），所以可以在后台跑。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askChain } from '../../src/chain/agent/ask'
import { createLocalAskOutbound } from '../../src/chain/agent/payload'
import { ensureChainSchema } from '../../src/chain/schema'
import type { ChainDb } from '../../src/chain/store'
import { ASK_TOOL_NAMES } from '../../src/chain/agent/tool-catalog'
import { conceiveDaughter } from '../../src/main/conceive'
import {
  ensureLineage,
  findBranch,
  generationOf,
  readLineage,
  recordLineageUsage,
  TRUNK_BRANCH
} from '../../src/main/lineage'
import { createMemoryRepo, type MemoryRepo } from '../../src/main/memory-repo'
import { createCloudAskOutbound } from '../../src/understand/cloud/ask-outbound'
import { FakeLlmClient } from '../../src/understand/cloud/llm-client'

const TIMEOUT = 90_000
const LIFE_LIMIT = 500_000

let dirs: string[] = []
let repo: MemoryRepo
let lineageFile: string
let db: ChainDb

async function setupRepo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-conceive-real-'))
  dirs.push(dir)
  repo = createMemoryRepo({ root: join(dir, 'memory-repo') })
  const ensured = await repo.ensure()
  expect(ensured.ok).toBe(true)
  lineageFile = join(dir, 'memory-lineage.json')
  await ensureLineage(lineageFile, { now: 1_000 })
  // 生命到 86%：conceive_daughter 才允许出现
  expect(await recordLineageUsage(lineageFile, 'default', Math.round(LIFE_LIMIT * 0.86))).toBe(true)
}

beforeEach(async () => {
  db = new Database(':memory:')
  ensureChainSchema(db)
  await setupRepo()
})

afterEach(() => {
  db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('conceiveDaughter · 真实 git 仓', () => {
  it('母亲提交 → ask 主干出生提交 → 女儿 orphan（信 + 快照）→ 家谱换代', { timeout: TIMEOUT }, async () => {
    const result = await conceiveDaughter(
      { repo, lineageFile },
      { nickname: '小雨', letter: '给女儿的话', motherBranch: 'default' }
    )
    expect(result).toMatchObject({ ok: true, nickname: 'xiao-yu' })

    // 分支：主干 + 女儿 + 原来的 default 都还在
    const branches = (await repo.listBranches()).map((entry) => entry.branch)
    expect(branches).toEqual(expect.arrayContaining([TRUNK_BRANCH, 'xiao-yu', 'default']))

    // 主干上有出生提交；女儿只有自己的出生提交（orphan，不继承母亲的提交）
    const trunkLog = await repo.branchLog(TRUNK_BRANCH)
    expect(trunkLog[0]?.subject).toContain('memory: birth xiao-yu')
    const daughterLog = await repo.branchLog('xiao-yu')
    expect(daughterLog).toHaveLength(1)
    expect(daughterLog[0]?.subject).toContain('memory: born xiao-yu')

    // 当前在女儿分支：信与家谱快照都在她的空树里
    const head = await repo.head()
    expect(head).toMatchObject({ branch: 'xiao-yu', detached: false })
    expect(await repo.readFile('letters/xiao-yu.md')).toContain('给女儿的话')
    const snapshot = JSON.parse((await repo.readFile('lineage.snapshot.json')) ?? '{}')
    expect(snapshot.active).toBe('xiao-yu')

    // 家谱：新一代、母亲 dead、主干节点在
    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    const lineage = read.lineage
    expect(lineage.active).toBe('xiao-yu')
    expect(lineage.generations).toHaveLength(2)
    const daughter = generationOf(lineage, 'xiao-yu')
    expect(daughter?.mother).toBe('gen-1')
    expect(findBranch(lineage, 'default')?.status).toBe('dead')
    expect(findBranch(lineage, TRUNK_BRANCH)?.kind).toBe('life')
    expect(lineage.last).toEqual({ chat: 'xiao-yu' })
  })

  it('生命还够时不传承：仓与家谱都不动', { timeout: TIMEOUT }, async () => {
    expect(await recordLineageUsage(lineageFile, 'default', 10_000)).toBe(true)
    const result = await conceiveDaughter(
      { repo, lineageFile },
      { nickname: '小雨', motherBranch: 'default' }
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('还没到传承的时候')
    expect((await repo.listBranches()).map((entry) => entry.branch)).toEqual(['default'])
    const read = await readLineage(lineageFile)
    if (read.status === 'ok') expect(read.lineage.active).toBe('default')
  })

  it('旧仓只有 life 主干：出生提交写在 life 上，不新建 ask', { timeout: TIMEOUT }, async () => {
    expect((await repo.switchCreateOrphan('life')).ok).toBe(true)
    await repo.writeFile('lineage.snapshot.json', '{}\n')
    await repo.commit('memory: legacy life')
    expect((await repo.switchBranch('default')).ok).toBe(true)

    const result = await conceiveDaughter(
      { repo, lineageFile },
      { nickname: 'mimi', motherBranch: 'default' }
    )
    expect(result).toMatchObject({ ok: true, nickname: 'mimi' })
    const branches = (await repo.listBranches()).map((entry) => entry.branch)
    expect(branches).toEqual(expect.arrayContaining(['life', 'mimi']))
    expect(branches).not.toContain('ask')
    expect((await repo.branchLog('life'))[0]?.subject).toContain('memory: birth mimi')
  })
})

describe('假模型驱动整条链路（askChain → conceive_daughter 工具 → 真实仓）', () => {
  it('模型调工具后结果带 conceived，仓里女儿已出生', { timeout: TIMEOUT }, async () => {
    const client = new FakeLlmClient([
      {
        toolCalls: [
          {
            name: 'conceive_daughter',
            arguments: { nickname: '小雨', letter: '你要好好长大。' }
          }
        ]
      },
      { json: '好，我把之后的日子交给她了。' }
    ])
    const result = await askChain(
      {
        db,
        outbound: createCloudAskOutbound(),
        resolveClient: () => ({ ok: true, client }),
        tools: [...ASK_TOOL_NAMES],
        life: { used: Math.round(LIFE_LIMIT * 0.86), limit: LIFE_LIMIT },
        conceive: (nickname, letter) =>
          conceiveDaughter(
            { repo, lineageFile },
            {
              nickname,
              ...(letter !== undefined ? { letter } : {}),
              motherBranch: 'default'
            }
          )
      },
      '这一天到了，交给她吧'
    )
    expect(result.conceived).toBe(true)
    expect(result.kind).toBe('answer')

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('xiao-yu')
    expect((await repo.head()).branch).toBe('xiao-yu')
    expect(await repo.readFile('letters/xiao-yu.md')).toContain('你要好好长大。')
  })
})
