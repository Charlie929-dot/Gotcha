/**
 * 记忆仓 git 封装（memory-life M1）
 *
 * 用临时目录 + 真 git 跑：建仓 / 提交 / 一天一个提交 / 没远端不推 / 没装 git 的降级。
 * 不碰用户真仓（全部 mkdtemp，结束即删）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryRepo, type GitRunner } from '../../src/main/memory-repo'

const dirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-memory-repo-'))
  dirs.push(dir)
  return join(dir, 'memory-repo')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const missingGit: GitRunner = async () => ({
  ok: false,
  code: null,
  stdout: '',
  stderr: '',
  error: 'ENOENT'
})

describe('记忆仓 git 封装', { timeout: 60_000 }, () => {
  it('首次 ensure 建仓：default 分支、脚手架、首个提交', async () => {
    const repo = createMemoryRepo({ root: tempRoot(), log: () => undefined })
    const status = await repo.ensure()
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.branch).toBe('default')
    expect(status.head).not.toBeNull()
    expect(status.dirty).toBe(false)
    expect(existsSync(join(repo.root, '.gitattributes'))).toBe(true)
    expect(existsSync(join(repo.root, 'conversations', '.gitkeep'))).toBe(true)
    expect(existsSync(join(repo.root, 'letters', '.gitkeep'))).toBe(true)
    expect((await repo.lastCommit())?.subject).toBe('memory: init')
  })

  it('commit 只提交有变化的文件，干净时不重复提交', async () => {
    const repo = createMemoryRepo({ root: tempRoot(), log: () => undefined })
    await repo.ensure()
    await repo.writeFile('conversations/c1.jsonl', '{"v":1,"digest":""}\n')
    const first = await repo.commit('memory: backup 2026-10-30 10:00')
    expect(first.committed).toBe(true)
    expect(first.hash).toBeTruthy()
    expect((await repo.lastCommit())?.subject).toBe('memory: backup 2026-10-30 10:00')

    const again = await repo.commit('memory: backup 2026-10-30 10:01')
    expect(again).toMatchObject({ committed: false, reason: 'clean' })

    const status = await repo.status()
    expect(status.ok && status.dirty).toBe(false)
  })

  it('commitDay 一天一个提交：同一天即使有改动也不再提交', async () => {
    const repo = createMemoryRepo({ root: tempRoot(), log: () => undefined })
    await repo.ensure()
    await repo.writeFile('conversations/c1.jsonl', 'a\n')
    const today = await repo.commitDay('2026-10-30')
    expect(today.committed).toBe(true)
    expect((await repo.lastCommit())?.subject).toBe('memory: 2026-10-30')

    await repo.writeFile('conversations/c1.jsonl', 'b\n')
    const sameDay = await repo.commitDay('2026-10-30')
    expect(sameDay).toMatchObject({ committed: false, reason: 'already' })

    const nextDay = await repo.commitDay('2026-10-31')
    expect(nextDay.committed).toBe(true)
    expect((await repo.lastCommit())?.subject).toBe('memory: 2026-10-31')
  })

  it('没配远端时 push 只回 no-remote，不抛错', async () => {
    const repo = createMemoryRepo({ root: tempRoot(), log: () => undefined })
    await repo.ensure()
    expect(await repo.push()).toMatchObject({ ok: false, reason: 'no-remote' })
  })

  it('空仓（还没有任何提交）也算可用：分支读得到、HEAD 为 null', async () => {
    const root = tempRoot()
    mkdirSync(root, { recursive: true })
    execSync('git init -b default', { cwd: root, stdio: 'ignore' })
    const repo = createMemoryRepo({ root, log: () => undefined })
    const status = await repo.ensure()
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.branch).toBe('default')
    expect(status.head).toBeNull()
  })

  it('没装 git：ensure 报 git-missing，提交 / 推送都降级成 unavailable', async () => {
    const repo = createMemoryRepo({ root: tempRoot(), runGit: missingGit, log: () => undefined })
    const status = await repo.ensure()
    expect(status.ok).toBe(false)
    if (status.ok) return
    expect(status.reason).toBe('git-missing')
    expect(await repo.commit('memory: x')).toMatchObject({ committed: false, reason: 'unavailable' })
    expect(await repo.push()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await repo.lastCommit()).toBeNull()
  })

  it('writeFile 拒绝跳出仓根的路径', async () => {
    const repo = createMemoryRepo({ root: tempRoot(), log: () => undefined })
    await repo.ensure()
    expect(await repo.writeFile('../escape.txt', 'x')).toBe(false)
    expect(await repo.writeFile('conversations/../ok.json', 'ok')).toBe(true)
    expect(existsSync(join(repo.root, '..', 'escape.txt'))).toBe(false)
  })

  it('仓里有手写的非 git 目录 .git 时才判 broken', async () => {
    const root = tempRoot()
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.git'), 'not a repo')
    const repo = createMemoryRepo({ root, log: () => undefined })
    const status = await repo.ensure()
    // .git 在但不是合法仓：明确报 broken，不把它当成可用仓
    expect(status.ok).toBe(false)
    if (status.ok) return
    expect(status.reason).toBe('broken')
  })
})

describe('记忆仓节点（分支）操作', { timeout: 60_000 }, () => {
  async function readyRepo(): Promise<ReturnType<typeof createMemoryRepo>> {
    const repo = createMemoryRepo({ root: tempRoot(), log: () => undefined })
    await repo.ensure()
    return repo
  }

  it('开新分支并切回：HEAD 跟着走', async () => {
    const repo = await readyRepo()
    const created = await repo.switchCreate('spring')
    expect(created.ok).toBe(true)
    expect(created.head?.branch).toBe('spring')

    const head = await repo.head()
    expect(head).toMatchObject({ branch: 'spring', detached: false })
    expect(head.sha).not.toBeNull()

    const back = await repo.switchBranch('default')
    expect(back.ok).toBe(true)
    expect((await repo.head()).branch).toBe('default')
  })

  it('工作区有未提交改动时拒绝切换（dirty）', async () => {
    const repo = await readyRepo()
    await repo.switchCreate('spring')
    await repo.switchBranch('default')
    await repo.writeFile('conversations/c1.jsonl', 'x\n')
    expect(await repo.switchBranch('spring')).toMatchObject({ ok: false, reason: 'dirty' })
  })

  it('不存在的分支 / 已存在的名字分开报', async () => {
    const repo = await readyRepo()
    expect(await repo.switchBranch('nope')).toMatchObject({ ok: false, reason: 'not-found' })
    await repo.switchCreate('spring')
    expect(await repo.switchCreate('spring')).toMatchObject({ ok: false, reason: 'exists' })
  })

  it('切历史提交：detached，HEAD 指向那一刻；不存在的提交报 not-found', async () => {
    const repo = await readyRepo()
    const first = (await repo.lastCommit())?.hash
    expect(first).toBeTruthy()
    await repo.writeFile('conversations/c1.jsonl', 'later\n')
    await repo.commit('memory: later')

    const checkedOut = await repo.checkoutCommit(first as string)
    expect(checkedOut.ok).toBe(true)
    expect(checkedOut.head?.detached).toBe(true)
    expect(checkedOut.head?.branch).toBeNull()
    // short sha 前缀对得上（lastCommit 给完整 sha）
    expect(first?.startsWith(checkedOut.head?.sha ?? '')).toBe(true)

    expect(await repo.checkoutCommit('nope-nope')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await repo.revParse('nope-nope')).toBeNull()
    expect(await repo.revParse('HEAD')).not.toBeNull()
  })

  it('删分支：非当前成功；当前 / 不存在分开报', async () => {
    const repo = await readyRepo()
    await repo.switchCreate('spring')
    await repo.switchBranch('default')
    expect(await repo.deleteBranch('spring')).toMatchObject({ ok: true })
    expect(await repo.deleteBranch('default')).toMatchObject({ ok: false, reason: 'current' })
    expect(await repo.deleteBranch('spring')).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('orphan 分支：清空工作区只留脚手架，切回原分支内容还在', async () => {
    const repo = await readyRepo()
    await repo.writeFile('conversations/c1.jsonl', '母亲\n')
    await repo.commit('memory: save before birth')
    const orphan = await repo.switchCreateOrphan('xiaoyu')
    expect(orphan.ok).toBe(true)
    expect(orphan.head?.branch).toBe('xiaoyu')
    // 母亲的分支内容不在女儿的空白树里
    expect(await repo.readFile('conversations/c1.jsonl')).toBeNull()
    expect(await repo.readFile('.gitattributes')).not.toBeNull()
    await repo.writeFile('letters/xiaoyu.md', '给女儿\n')
    expect((await repo.commit('memory: born xiaoyu')).committed).toBe(true)

    expect((await repo.switchBranch('default')).ok).toBe(true)
    expect(await repo.readFile('conversations/c1.jsonl')).toBe('母亲\n')
  })

  it('分支列表与分支日志带最近提交', async () => {
    const repo = await readyRepo()
    await repo.switchCreate('spring')
    await repo.writeFile('conversations/c1.jsonl', 'a\n')
    await repo.commit('memory: save before new')

    const branches = await repo.listBranches()
    expect(branches.map((item) => item.branch).sort()).toEqual(['default', 'spring'])
    const spring = branches.find((item) => item.branch === 'spring')
    expect(spring?.subject).toBe('memory: save before new')

    const log = await repo.branchLog('spring', 2)
    expect(log[0]?.subject).toBe('memory: save before new')
    expect(log.length).toBeLessThanOrEqual(2)
    expect(await repo.branchLog('nope')).toEqual([])
  })
})
