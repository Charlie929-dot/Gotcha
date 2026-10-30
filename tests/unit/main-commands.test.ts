/**
 * 本地命令（memory-life M1/M2/M3）：解析 / /help / /log / /new / /use / /del / /compact / /backup / 未知。
 * 用假仓，不碰真 git（真仓行为在 main-memory-repo.test.ts）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COMMAND_WAIT_TIMEOUT_MS,
  commandResult,
  createCommandHandler,
  memoryDayKey,
  parseCommand,
  slugifyNodeName,
  type CompactOutcome
} from '../../src/main/commands'
import {
  ensureLineage,
  readLineage,
  withBranchAdded,
  writeLineage,
  type Lineage
} from '../../src/main/lineage'
import type { MemoryRepo } from '../../src/main/memory-repo'
import type { ChainAskResult } from '../../src/chain/agent/types'
import { ASK_MODE_PRESETS } from '../../src/chain/agent/mode'

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
    deleteFile: async () => true,
    head: async () => ({ branch: 'default', detached: false, sha: 'abc1234' }),
    switchBranch: async (name) => ({ ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }),
    switchCreate: async (name) => ({ ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }),
    switchCreateOrphan: async (name) => ({ ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }),
    checkoutCommit: async (ref) => ({ ok: true, head: { branch: null, detached: true, sha: ref } }),
    deleteBranch: async () => ({ ok: true }),
    listBranches: async () => [{ branch: 'default', sha: 'abc1234', subject: 'memory: init', at: 1 }],
    branchLog: async () => [],
    revParse: async () => null
  }
  return { ...base, ...overrides }
}

function textOf(result: ChainAskResult | null): string {
  expect(result?.kind).toBe('command')
  if (result === null || result.kind !== 'command') return ''
  return result.text
}

async function seededLineage(file: string): Promise<Lineage> {
  const seeded = await ensureLineage(file, { now: 1 })
  const next = withBranchAdded(seeded.lineage, {
    branch: 'spring',
    generation: 'gen-1',
    parent: 'default',
    at: 2
  })
  if (next === null) throw new Error('seed failed')
  await writeLineage(file, next)
  return next
}

function twoBranches(): Partial<MemoryRepo> {
  return {
    listBranches: async () => [
      { branch: 'default', sha: 'abc1234', subject: 'memory: init', at: 1 },
      { branch: 'spring', sha: 'def5678', subject: 'memory: save before new', at: 2 }
    ]
  }
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

  it('名字转 slug：中文转拼音、英文原样、符号转不出报 null', () => {
    expect(slugifyNodeName('春天')).toBe('chun-tian')
    expect(slugifyNodeName('Spring')).toBe('spring')
    expect(slugifyNodeName('foo bar')).toBe('foo-bar')
    expect(slugifyNodeName('a_b')).toBe('a-b')
    expect(slugifyNodeName('!!!')).toBeNull()
    expect(slugifyNodeName('   ')).toBeNull()
  })
})

describe('命令执行', () => {
  it('/help 报当前节点、仓状态与新命令', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const text = textOf(await run('/help'))
    expect(text).toContain('当前节点：default')
    expect(text).toContain('记忆仓：可用 · 分支 default · 最近提交「memory: 2026-10-30」')
    expect(text).toContain('/log')
    expect(text).toContain('/new <名字>')
    expect(text).toContain('/use')
    expect(text).toContain('/del')
    expect(text).toContain('/mode')
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

  it('/mode 切换预设，回执带上目标模式（界面据此落地）', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const chatted = await run('/mode chat')
    expect(chatted?.kind).toBe('command')
    if (chatted?.kind !== 'command') return
    expect(chatted.text).toContain('聊天')
    expect(chatted.text).toContain('下一条生效')
    expect(chatted.mode).toEqual(ASK_MODE_PRESETS.chat)
    expect(textOf(await run('/mode mem'))).toContain('问记忆')
    expect(textOf(await run('/mode ask'))).toContain('提问')
  })

  it('/mode 不带参数报当前模式；未知名字不切换', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const current = await run('/mode', { mode: ASK_MODE_PRESETS.chat })
    expect(current?.kind).toBe('command')
    if (current?.kind !== 'command') return
    expect(current.text).toContain('当前模式：聊天')
    expect(current.mode).toBeUndefined()

    const unknown = await run('/mode 随便')
    expect(unknown?.kind).toBe('command')
    if (unknown?.kind !== 'command') return
    expect(unknown.text).toContain('不认识')
    expect(unknown.mode).toBeUndefined()
  })

  it('/log 列出节点、标出当前与分叉来源', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    const run = createCommandHandler({
      repo: fakeRepo({
        head: async () => ({ branch: 'spring', detached: false, sha: 'def5678' }),
        status: async () => ({ ok: true, root: 'C:/tmp/memory-repo', branch: 'spring', head: 'def5678', dirty: false }),
        ...twoBranches()
      }),
      lineageFile
    })
    const text = textOf(await run('/log'))
    expect(text).toContain('[1] default')
    expect(text).toContain('[2] spring（从 default 分叉）  ← 当前')
    expect(text).toContain('def5678  memory: save before new')
    expect(text).toContain('/use <编号|名字>')
  })

  it('/log 在 detached 时提示「第一句话会分叉」', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({
      repo: fakeRepo({
        head: async () => ({ branch: null, detached: true, sha: 'abc1234' }),
        ...twoBranches()
      }),
      lineageFile
    })
    expect(textOf(await run('/log'))).toContain('HEAD 停在历史提交 abc1234')
  })

  it('/new 春天：中文转拼音开分支，家谱记一条并切过去', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const text = textOf(await run('/new 春天'))
    expect(text).toContain('===this is chun-tian===')
    expect(text).toContain('从 default 开出')

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.branches.map((item) => item.branch)).toEqual(['default', 'chun-tian'])
    expect(read.lineage.branches[1]).toMatchObject({ parent: 'default', generation: 'gen-1' })
  })

  it('/new 重名报错，不动仓', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    const run = createCommandHandler({ repo: fakeRepo(twoBranches()), lineageFile })
    expect(textOf(await run('/new Spring'))).toContain('节点 spring 已经存在')
  })

  it('/new 不带名字进入命名等待，下一条普通文本当名字', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    let clock = 1000
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile, now: () => clock })
    expect(textOf(await run('/new'))).toContain('给新节点起个名字')
    clock += 1000
    expect(textOf(await run('秋天'))).toContain('===this is qiu-tian===')
  })

  it('命名等待 60 秒后过期，普通文本照常走模型', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    let clock = 1000
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile, now: () => clock })
    await run('/new')
    clock += COMMAND_WAIT_TIMEOUT_MS + 1
    expect(await run('秋天')).toBeNull()
  })

  it('/use 分支：先保存当前、切分支、写家谱 active、重载会话', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    let reloads = 0
    let switched: string | null = null
    const run = createCommandHandler({
      repo: fakeRepo({
        ...twoBranches(),
        switchBranch: async (name) => {
          switched = name
          return { ok: true, head: { branch: name, detached: false, sha: 'def5678' } }
        }
      }),
      lineageFile,
      reloadConversations: () => {
        reloads += 1
      }
    })
    const text = textOf(await run('/use spring'))
    expect(text).toContain('===this is spring===')
    expect(switched).toBe('spring')
    expect(reloads).toBe(1)

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('spring')
  })

  it('/use 编号：按 /log 的顺序取节点', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    let switched: string | null = null
    const run = createCommandHandler({
      repo: fakeRepo({
        ...twoBranches(),
        switchBranch: async (name) => {
          switched = name
          return { ok: true, head: { branch: name, detached: false, sha: 'def5678' } }
        }
      }),
      lineageFile
    })
    expect(textOf(await run('/use 2'))).toContain('===this is spring===')
    expect(switched).toBe('spring')
    expect(textOf(await run('/use 9'))).toContain('没有第 9 个节点')
  })

  it('/use 短 sha：切到历史提交（detached），不写家谱 active', async () => {
    const lineageFile = tempLineageFile()
    const seeded = await seededLineage(lineageFile)
    let checkedOut: string | null = null
    const run = createCommandHandler({
      repo: fakeRepo({
        ...twoBranches(),
        revParse: async (ref) => (ref === 'abc1234' ? 'abc1234' : null),
        checkoutCommit: async (ref) => {
          checkedOut = ref
          return { ok: true, head: { branch: null, detached: true, sha: ref } }
        }
      }),
      lineageFile
    })
    const text = textOf(await run('/use abc1234'))
    expect(text).toContain('===this is 历史提交 abc1234===')
    expect(text).toContain('分叉成 default-<序号>')
    expect(checkedOut).toBe('abc1234')

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe(seeded.active)
  })

  it('/use 不存在的目标如实报错', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await run('/use nope'))).toContain('没找到节点或提交')
  })

  it('/del 需要 confirm：确认后删分支并移出家谱', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    let deleted: string | null = null
    const run = createCommandHandler({
      repo: fakeRepo({
        ...twoBranches(),
        deleteBranch: async (name) => {
          deleted = name
          return { ok: true }
        }
      }),
      lineageFile
    })
    expect(textOf(await run('/del spring'))).toContain('回复 confirm 确认')
    expect(textOf(await run('confirm'))).toContain('已删除节点 spring')
    expect(deleted).toBe('spring')

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.branches.map((item) => item.branch)).toEqual(['default'])
  })

  it('/del 当前节点 / 有后代 / 不存在都拒绝', async () => {
    const lineageFile = tempLineageFile()
    const seeded = await seededLineage(lineageFile)
    const run = createCommandHandler({ repo: fakeRepo(twoBranches()), lineageFile })
    expect(textOf(await run('/del default'))).toContain('不能删当前节点')
    expect(textOf(await run('/del nope'))).toContain('没有节点 nope')

    // spring 下面加一个 winter：有后代不许删
    const withWinter = withBranchAdded(seeded, {
      branch: 'winter',
      generation: 'gen-1',
      parent: 'spring',
      at: 3
    })
    expect(withWinter).not.toBeNull()
    if (withWinter === null) return
    await writeLineage(lineageFile, withWinter)
    const withChild = createCommandHandler({
      repo: fakeRepo({
        listBranches: async () => [
          { branch: 'default', sha: 'abc1234', subject: 'memory: init', at: 1 },
          { branch: 'spring', sha: 'def5678', subject: 'memory: save before new', at: 2 },
          { branch: 'winter', sha: 'fff9999', subject: 'memory: init', at: 3 }
        ]
      }),
      lineageFile
    })
    expect(textOf(await withChild('/del spring'))).toContain('下面还有 winter')
  })

  it('confirm 等待中发别的话：不删，照常走模型', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    const run = createCommandHandler({ repo: fakeRepo(twoBranches()), lineageFile })
    await run('/del spring')
    expect(await run('算了，继续聊')).toBeNull()
    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.branches.map((item) => item.branch)).toEqual(['default', 'spring'])
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

  it('未知命令与还没接上的命令分开回；/cancel 清等待', async () => {
    const lineageFile = tempLineageFile()
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await run('/nope'))).toContain('未知命令：/nope')
    expect(textOf(await run('/compact'))).toContain('/compact 还没接上')
    expect(textOf(await run('/cancel'))).toBe('没有等待中的操作。')
    await run('/new')
    expect(textOf(await run('/cancel'))).toBe('已取消。')
    expect(await run('秋天')).toBeNull()
  })

  it('普通问题不接管（返回 null）', async () => {
    const lineageFile = tempLineageFile()
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(await run('昨天下午我在改什么')).toBeNull()
  })

  it('/compact：成功回执带数字，且把 conversationId 传下去', async () => {
    const lineageFile = tempLineageFile()
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await run('/compact', { conversationId: 'c1' }))).toContain('/compact 还没接上')

    let received: string | undefined
    const compacted = createCommandHandler({
      repo: fakeRepo(),
      lineageFile,
      compact: async (id) => {
        received = id
        return { ok: true, dropped: 3, kept: 6, summaryChars: 380, beforeChars: 42_000, afterChars: 8_000 }
      }
    })
    const text = textOf(await compacted('/compact', { conversationId: 'c1' }))
    expect(received).toBe('c1')
    expect(text).toContain('===compact===')
    expect(text).toContain('压掉 3 轮（保留最近 6 轮原文），摘要 380 字')
    expect(text).toContain('从 42000 字降到 8000 字')
  })

  it('/compact：各种失败原因分开回，不漏底层异常', async () => {
    const lineageFile = tempLineageFile()
    const make = (outcome: CompactOutcome) =>
      createCommandHandler({ repo: fakeRepo(), lineageFile, compact: async () => outcome })
    expect(textOf(await make({ ok: false, reason: 'no-session' })('/compact'))).toContain('桌面窗口里用')
    expect(
      textOf(await make({ ok: false, reason: 'too-short', detail: '只有 2 轮，还不够压' })('/compact'))
    ).toContain('只有 2 轮')
    expect(textOf(await make({ ok: false, reason: 'consent' })('/compact'))).toContain('还没确认出云')
    expect(textOf(await make({ ok: false, reason: 'budget' })('/compact'))).toContain('额度用完')
    expect(textOf(await make({ ok: false, reason: 'blocked' })('/compact'))).toContain('敏感内容')
    expect(textOf(await make({ ok: false, reason: 'no-client' })('/compact'))).toContain('模型客户端')
    expect(textOf(await make({ ok: false, reason: 'failed' })('/compact'))).toContain('摘要失败')
  })
})
