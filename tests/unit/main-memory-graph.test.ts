/**
 * 记忆仓 · 图与纯模型分支（D74）
 *
 * 真 git 仓（临时目录），验证三件事：
 * 1. `/mode ask` 建 `life` 主干（首个提交 = 出生 default）并从它分叉出 `ask`；
 * 2. `ask` 上的 `/new` 从 ask 分叉、**清空会话**（新会话从空白开始）；
 * 3. `/log` 画家谱树（D75），`/log <编号>` 看该节点的记忆历史。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createCommandHandler } from '../../src/main/commands'
import { ensureLineage, readLineage, TRUNK_BRANCH } from '../../src/main/lineage'
import { createMemoryRepo, type MemoryRepo } from '../../src/main/memory-repo'

const TIMEOUT = 90_000

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(): Promise<{ repo: MemoryRepo; lineageFile: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-graph-'))
  dirs.push(dir)
  const repo = createMemoryRepo({ root: join(dir, 'memory-repo') })
  await repo.ensure()
  const lineageFile = join(dir, 'memory-lineage.json')
  await ensureLineage(lineageFile, { now: 1_000 })
  return { repo, lineageFile }
}

function textOf(result: { kind: string; text?: string } | null): string {
  expect(result?.kind).toBe('command')
  return result?.text ?? ''
}

describe('life 主干 + ask 分支（真 git 仓）', { timeout: TIMEOUT }, () => {
  it('/mode ask：life 的第一个提交是出生 default，ask 从 life 分叉', async () => {
    const { repo, lineageFile } = await setup()
    const run = createCommandHandler({ repo, lineageFile })
    expect(textOf(await run('/mode ask'))).toContain('纯模型')

    const trunk = await repo.branchLog(TRUNK_BRANCH)
    expect(trunk.map((item) => item.subject)).toContain('memory: birth default')

    // ask 是 life 的后代（分叉 = 继承主干的出生提交），且有自己的首个提交
    const askLog = await repo.branchLog('ask')
    expect(askLog.map((item) => item.subject)).toContain('memory: birth default')
    expect(askLog[0]?.subject).toBe('memory: ask ask')

    const read = await readLineage(lineageFile)
    if (read.status !== 'ok') throw new Error('lineage unreadable')
    expect(read.lineage.active).toBe('ask')
    expect(read.lineage.branches.find((node) => node.branch === 'ask')?.parent).toBe(TRUNK_BRANCH)
  })

  it('ask 上的 /new：从 ask 分叉并清空会话（新会话空白）', async () => {
    const { repo, lineageFile } = await setup()
    const run = createCommandHandler({ repo, lineageFile })
    await run('/mode ask')
    // ask 上先有一轮对话并落盘
    expect(await repo.writeFile('conversations/c1.jsonl', '{"v":1}\n')).toBe(true)
    await repo.commit('memory: 2026-10-30')

    expect(textOf(await run('/new 第二会话'))).toContain('上下文清空')
    expect(await repo.readFile('conversations/c1.jsonl')).toBeNull()
    const created = await repo.branchLog('di-er-hui-hua')
    expect(created[0]?.subject).toBe('memory: ask di-er-hui-hua')
    // 分叉：继承 ask 的历史（提问会话 ask）
    expect(created.map((item) => item.subject)).toContain('memory: ask ask')

    const read = await readLineage(lineageFile)
    if (read.status !== 'ok') throw new Error('lineage unreadable')
    expect(read.lineage.branches.find((node) => node.branch === 'di-er-hui-hua')?.parent).toBe('ask')
  })

  it('/log：画家谱树；/log 0-0 看 ask 的记忆历史', async () => {
    const { repo, lineageFile } = await setup()
    const run = createCommandHandler({ repo, lineageFile })
    await run('/mode ask')
    const tree = textOf(await run('/log'))
    expect(tree).toBe(
      ['[0] life · 主干', '[0-0] ask · 纯模型 · 0 个工具  ← 当前', '[0-1] default · 7 个工具'].join('\n')
    )
    const history = textOf(await run('/log 0-0'))
    expect(history.split('\n')[0]).toBe('[0] ask  ← 当前')
    // ask 的最新提交就是 HEAD：正在用的那条记忆
    expect(history).toMatch(/\[0-0\] 提问会话 ask · [0-9a-f]{7,}  ← 正在用/u)
    expect(history).toMatch(/\[0-1\] 出生 default · [0-9a-f]{7,}/u)
  })
})
