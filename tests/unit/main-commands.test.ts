/**
 * 本地命令（memory-life M1）：解析 / /help / /backup / 未知 / 还没接上。
 * 用假仓，不碰真 git（真仓行为在 main-memory-repo.test.ts）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commandResult, createCommandHandler, memoryDayKey, parseCommand } from '../../src/main/commands'
import { ensureLineage, writeLineage } from '../../src/main/lineage'
import type { MemoryRepo } from '../../src/main/memory-repo'
import type { ChainAskResult } from '../../src/chain/agent/types'

const dirs: string[] = []

function tempLineageFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-commands-'))
  dirs.push(dir)
  return join(dir, 'memory-lineage.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeRepo(overrides: Partial<MemoryRepo> = {}): MemoryRepo {
  const base: MemoryRepo = {
    root: 'C:/tmp/memory-repo',
    ensure: async () => ({ ok: true, root: 'C:/tmp/memory-repo', branch: 'default', head: 'abc1234', dirty: false }),
    status: async () => ({ ok: true, root: 'C:/tmp/memory-repo', branch: 'default', head: 'abc1234', dirty: false }),
    commit: async () => ({ committed: false, reason: 'clean' }),
    commitDay: async () => ({ committed: false, reason: 'clean' }),
    push: async () => ({ ok: false, reason: 'no-remote' }),
    lastCommit: async () => ({ hash: 'abc1234', subject: 'memory: 2026-10-30' }),
    writeFile: async () => true,
    readFile: async () => null,
    deleteFile: async () => true
  }
  return { ...base, ...overrides }
}

function textOf(result: ChainAskResult | null): string {
  expect(result?.kind).toBe('command')
  if (result === null || result.kind !== 'command') return ''
  return result.text
}

describe('命令解析', () => {
  it('认斜杠命令、大小写与参数；普通文本不是命令', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: [] })
    expect(parseCommand('  /HELP  ')).toEqual({ name: 'help', args: [] })
    expect(parseCommand('/new 春天')).toEqual({ name: 'new', args: ['春天'] })
    expect(parseCommand('帮我看看昨天的记录')).toBeNull()
    expect(parseCommand('/')).toBeNull()
    expect(parseCommand(' / ')).toBeNull()
  })

  it('回执形状：command + 全 0 stats', () => {
    const result = commandResult('ok')
    expect(result).toMatchObject({
      kind: 'command',
      text: 'ok',
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
    })
  })

  it('提交主题按本地日', () => {
    expect(memoryDayKey(new Date(2026, 9, 30, 18, 5).getTime())).toBe('2026-10-30')
  })
})

describe('命令执行', () => {
  it('/help 报当前节点与仓状态', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const text = textOf(await run('/help'))
    expect(text).toContain('当前节点：default')
    expect(text).toContain('记忆仓：可用 · 分支 default · 最近提交「memory: 2026-10-30」')
    expect(text).toContain('/backup')
  })

  it('/help 在仓不可用时如实说，不假装可用', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({
      repo: fakeRepo({
        status: async () => ({ ok: false, root: 'C:/tmp/memory-repo', reason: 'git-missing' })
      }),
      lineageFile
    })
    expect(textOf(await run('/help'))).toContain('记忆仓：不可用 · 没找到 git')
  })

  it('/help 显示家谱里的活动节点（切过分支之后）', async () => {
    const lineageFile = tempLineageFile()
    const seeded = await ensureLineage(lineageFile, { now: 1 })
    await writeLineage(lineageFile, {
      ...seeded.lineage,
      active: 'spring',
      branches: [
        ...seeded.lineage.branches,
        { branch: 'spring', generation: 'gen-1', parent: 'default', created_at: 2, status: 'alive' }
      ]
    })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await run('/help'))).toContain('当前节点：spring')
  })

  it('/backup：提交成功 + 没配远端 → 明说只在本地', async () => {
    const lineageFile = tempLineageFile()
    const run = createCommandHandler({
      repo: fakeRepo({ commit: async () => ({ committed: true, hash: 'abc1234' }) }),
      lineageFile
    })
    const text = textOf(await run('/backup'))
    expect(text).toContain('已提交 abc1234。')
    expect(text).toContain('没配远端，只提交在本地。')
  })

  it('/backup：推送成功 / 推送失败 / 没有新内容 / 仓不可用', async () => {
    const lineageFile = tempLineageFile()
    const pushed = createCommandHandler({
      repo: fakeRepo({
        commit: async () => ({ committed: true, hash: 'abc1234' }),
        push: async () => ({ ok: true })
      }),
      lineageFile
    })
    expect(textOf(await pushed('/backup'))).toContain('推送成功。')

    const pushFailed = createCommandHandler({
      repo: fakeRepo({
        commit: async () => ({ committed: true, hash: 'abc1234' }),
        push: async () => ({ ok: false, reason: 'failed' })
      }),
      lineageFile
    })
    expect(textOf(await pushFailed('/backup'))).toContain('推送失败（网络 / 凭据）')

    const clean = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await clean('/backup'))).toBe('没有新内容要提交。')

    const unavailable = createCommandHandler({
      repo: fakeRepo({ commit: async () => ({ committed: false, reason: 'unavailable' }) }),
      lineageFile
    })
    expect(textOf(await unavailable('/backup'))).toContain('记忆仓不可用')
  })

  it('未知命令与还没接上的命令分开回', async () => {
    const lineageFile = tempLineageFile()
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await run('/nope'))).toContain('未知命令：/nope')
    const pending = textOf(await run('/log'))
    expect(pending).toContain('/log 还没接上')
    expect(textOf(await run('/use spring'))).toContain('/use 还没接上')
  })

  it('普通问题不接管（返回 null）', async () => {
    const lineageFile = tempLineageFile()
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(await run('昨天下午我在改什么')).toBeNull()
  })
})
