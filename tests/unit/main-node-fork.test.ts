/**
 * 历史提交自动分叉（memory-life M2）。
 * 假仓，不碰真 git：只验命名规则、分叉后家谱与缓存重载；真 git 切换在 main-memory-repo.test.ts。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureLineage, readLineage } from '../../src/main/lineage'
import type { MemoryRepo } from '../../src/main/memory-repo'
import { forkDetachedIfNeeded, nextForkName } from '../../src/main/node-fork'

const dirs: string[] = []

function tempLineageFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-fork-'))
  dirs.push(dir)
  return join(dir, 'memory-lineage.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeRepo(overrides: Partial<MemoryRepo> = {}): MemoryRepo {
  const base = {
    root: 'C:/tmp/memory-repo',
    ensure: async () => ({ ok: true as const, root: 'C:/tmp/memory-repo', branch: 'default', head: 'abc1234', dirty: false }),
    status: async () => ({ ok: true as const, root: 'C:/tmp/memory-repo', branch: 'default', head: 'abc1234', dirty: false }),
    commit: async () => ({ committed: false, reason: 'clean' as const }),
    commitDay: async () => ({ committed: false, reason: 'clean' as const }),
    push: async () => ({ ok: false, reason: 'no-remote' as const }),
    lastCommit: async () => ({ hash: 'abc1234', subject: 'memory: init' }),
    writeFile: async () => true,
    readFile: async () => null,
    deleteFile: async () => true,
    head: async () => ({ branch: null, detached: true, sha: 'abc1234' }),
    switchBranch: async () => ({ ok: true }),
    switchCreate: async () => ({ ok: true }),
    checkoutCommit: async () => ({ ok: true }),
    deleteBranch: async () => ({ ok: true }),
    listBranches: async () => [{ branch: 'default', sha: 'abc1234', subject: 'memory: init', at: 1 }],
    branchLog: async () => [],
    revParse: async () => null
  }
  return { ...base, ...overrides } as MemoryRepo
}

describe('分叉命名', () => {
  it('取已有分叉的最大编号 +1；没有就从 2 开始', () => {
    expect(nextForkName('spring', ['spring'])).toBe('spring-2')
    expect(nextForkName('spring', ['spring', 'spring-2'])).toBe('spring-3')
    expect(nextForkName('spring', ['spring', 'spring-2', 'spring-7'])).toBe('spring-8')
    expect(nextForkName('spring', ['spring', 'spring-x', 'other-9'])).toBe('spring-2')
  })
})

describe('历史提交自动分叉', () => {
  it('detached 时开 <原分支>-2，家谱记新节点并切 active', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    let created: string | null = null
    let reloads = 0
    const result = await forkDetachedIfNeeded({
      repo: fakeRepo({
        switchCreate: async (name) => {
          created = name
          return { ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }
        }
      }),
      lineageFile,
      reloadConversations: () => {
        reloads += 1
      }
    })
    expect(result).toEqual({ forked: true, branch: 'default-2' })
    expect(created).toBe('default-2')
    expect(reloads).toBe(1)

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('default-2')
    expect(read.lineage.branches.map((item) => item.branch)).toEqual(['default', 'default-2'])
    expect(read.lineage.branches[1]).toMatchObject({ parent: 'default', generation: 'gen-1' })
  })

  it('已经分叉过：序号接着往上加', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    let created: string | null = null
    await forkDetachedIfNeeded({
      repo: fakeRepo({
        listBranches: async () => [
          { branch: 'default', sha: 'abc1234', subject: 'memory: init', at: 1 },
          { branch: 'default-2', sha: 'def5678', subject: 'memory: fork', at: 2 },
          { branch: 'default-3', sha: 'fedcba9', subject: 'memory: fork', at: 3 }
        ],
        switchCreate: async (name) => {
          created = name
          return { ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }
        }
      }),
      lineageFile
    })
    expect(created).toBe('default-4')
  })

  it('不在 detached（正常分支）时什么都不做', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    let called = false
    const result = await forkDetachedIfNeeded({
      repo: fakeRepo({
        head: async () => ({ branch: 'spring', detached: false, sha: 'abc1234' }),
        switchCreate: async () => {
          called = true
          return { ok: true }
        }
      }),
      lineageFile
    })
    expect(result.forked).toBe(false)
    expect(called).toBe(false)
  })

  it('开分支失败时不改家谱、不阻塞提问', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const logs: string[] = []
    const result = await forkDetachedIfNeeded({
      repo: fakeRepo({ switchCreate: async () => ({ ok: false, reason: 'exists' }) }),
      lineageFile,
      log: (_level, message) => {
        logs.push(message)
      }
    })
    expect(result.forked).toBe(false)
    expect(logs).toContain('memory fork failed')

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.branches.map((item) => item.branch)).toEqual(['default'])
  })
})
