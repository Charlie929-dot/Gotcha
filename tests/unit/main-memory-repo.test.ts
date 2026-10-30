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

describe('记忆仓 git 封装', { timeout: 30_000 }, () => {
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
