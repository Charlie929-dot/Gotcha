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
  serializeCommands,
  slugifyNodeName,
  type CompactOutcome
} from '../../src/main/commands'
import {
  ensureLineage,
  readLineage,
  toolsOfBranch,
  withBranchAdded,
  withGenerationAdded,
  withGenerationRealName,
  writeLineage,
  type Lineage
} from '../../src/main/lineage'
import type { MemoryRepo } from '../../src/main/memory-repo'
import type { ChainAskResult } from '../../src/chain/agent/types'
import { ASK_TOOL_NAMES } from '../../src/chain/agent/tool-catalog'

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
    clearConversations: async () => true,
    head: async () => ({ branch: 'default', detached: false, sha: 'abc1234' }),
    switchBranch: async (name) => ({ ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }),
    switchCreate: async (name) => ({ ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }),
    switchCreateOrphan: async (name) => ({ ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }),
    checkoutCommit: async (ref) => ({ ok: true, head: { branch: null, detached: true, sha: ref } }),
    deleteBranch: async () => ({ ok: true }),
    listBranches: async () => [{ branch: 'default', sha: 'abc1234', subject: 'memory: init', at: 1 }],
    branchLog: async () => [],
    mergeBase: async () => null,
    commitCount: async () => 0,
    git: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
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

/** D75 的样例家谱：life 主干 →（原始代 ask / 第一代 default → spring / 第二代 gen2） */
async function seededTree(file: string): Promise<Lineage> {
  const base = await ensureLineage(file, { now: 1 })
  const withLife = withBranchAdded(base.lineage, {
    branch: 'life',
    generation: 'gen-1',
    parent: 'default',
    at: 2,
    kind: 'life'
  })
  if (withLife === null) throw new Error('seed failed')
  const withAsk = withBranchAdded(withLife, {
    branch: 'ask',
    generation: 'gen-1',
    parent: 'life',
    at: 3,
    kind: 'assistant'
  })
  if (withAsk === null) throw new Error('seed failed')
  const withSpring = withBranchAdded(withAsk, {
    branch: 'spring',
    generation: 'gen-1',
    parent: 'default',
    at: 4
  })
  if (withSpring === null) throw new Error('seed failed')
  const withGen = {
    ...withSpring,
    generations: [
      ...withSpring.generations,
      {
        id: 'gen-2',
        branch: 'gen2',
        nickname: 'gen2',
        mother: 'gen-1',
        born_at: 5,
        died_at: null,
        life_tokens_used: 0,
        letter: null
      }
    ]
  }
  const next = withBranchAdded(withGen, {
    branch: 'gen2',
    generation: 'gen-2',
    parent: null,
    at: 5
  })
  if (next === null) throw new Error('seed failed')
  await writeLineage(file, next)
  return next
}

function treeBranches(): Partial<MemoryRepo> {
  return {
    listBranches: async () => [
      { branch: 'ask', sha: 'a1', subject: 'memory: ask ask', at: 3 },
      { branch: 'default', sha: 'a2', subject: 'memory: 2026-10-30', at: 1 },
      { branch: 'gen2', sha: 'a3', subject: 'memory: birth gen2', at: 5 },
      { branch: 'life', sha: 'a4', subject: 'memory: birth default', at: 2 },
      { branch: 'spring', sha: 'a5', subject: 'memory: 2026-10-30 18:05', at: 4 }
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
    expect(text).toContain('/backup [-d]')
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

  it('/mode chat 切到 persona 分支；/mode ask 从 life 主干开 ask 分支（纯模型、无工具）', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const chatted = await run('/mode chat')
    expect(chatted?.kind).toBe('command')
    if (chatted?.kind !== 'command') return
    expect(chatted.text).toContain('聊天')
    expect(chatted.mode).toEqual({ kind: 'chat', branch: 'default', tools: [...ASK_TOOL_NAMES] })

    const asked = await run('/mode ask')
    expect(asked?.kind).toBe('command')
    if (asked?.kind !== 'command') return
    expect(asked.text).toContain('纯模型')
    expect(asked.mode).toEqual({ kind: 'ask', branch: 'ask', tools: [] })
    // 家谱：life 主干（D74 回到 life）+ ask 纯模型分支，ask 挂在 life 下
    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('ask')
    expect(read.lineage.branches.map((node) => node.branch)).toEqual(
      expect.arrayContaining(['life', 'ask'])
    )
    expect(read.lineage.branches.find((node) => node.branch === 'life')?.kind).toBe('life')
    expect(read.lineage.branches.find((node) => node.branch === 'ask')?.parent).toBe('life')
    expect(read.lineage.last).toEqual({ ask: 'ask', chat: 'default' })
  })

  it('纯模型分支的 /new：从 ask 分叉 + 清空会话', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const cleared: string[] = []
    const created: string[] = []
    let current = 'default'
    const run = createCommandHandler({
      repo: fakeRepo({
        head: async () => ({ branch: current, detached: false, sha: 'abc1234' }),
        switchBranch: async (name) => {
          current = name
          return { ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }
        },
        clearConversations: async () => {
          cleared.push('yes')
          return true
        },
        switchCreate: async (name) => {
          current = name
          created.push(name)
          return { ok: true, head: { branch: name, detached: false, sha: 'abc1234' } }
        }
      }),
      lineageFile
    })
    expect(textOf(await run('/mode ask'))).toContain('纯模型')
    expect(textOf(await run('/new 第二会话'))).toContain('上下文清空')
    expect(created).toContain('di-er-hui-hua')
    expect(cleared).toHaveLength(1)
    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('di-er-hui-hua')
    expect(read.lineage.branches.find((node) => node.branch === 'di-er-hui-hua')?.parent).toBe('ask')
  })

  it('/mode 不带参数报当前模式；未知名字不切换', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const current = await run('/mode')
    expect(current?.kind).toBe('command')
    if (current?.kind !== 'command') return
    expect(current.text).toContain('当前模式：聊天（分支 ✨default')
    expect(current.mode).toBeUndefined()

    const unknown = await run('/mode 随便')
    expect(unknown?.kind).toBe('command')
    if (unknown?.kind !== 'command') return
    expect(unknown.text).toContain('不认识')
    expect(unknown.mode).toBeUndefined()
  })

  it('/tool 列集合 / 元素；add / rm 改的是当前分支的工具', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await run('/tool set'))).toContain('[1] screen · 屏幕记忆（5 个）')
    expect(textOf(await run('/tool ele 1'))).toContain('[1] search_info')
    expect(textOf(await run('/tool'))).toContain('11 个工具')

    // 默认分支（persona）全开 → 先 rm 掉整组日记
    expect(textOf(await run('/tool rm diary'))).toContain('工具（8 个）')
    expect(textOf(await run('/tool add diary:recall_diary,memory_profile'))).toContain('工具（10 个）')
    expect(textOf(await run('/tool rm screen:get_freshness'))).toContain('工具（9 个）')
    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(toolsOfBranch(read.lineage, 'default')).toEqual([
      'search_info',
      'read_segment',
      'recall',
      'ask_history',
      'recall_diary',
      'memory_profile',
      'write_letter',
      'list_letter',
      'read_letter'
    ])
    // 不认识的名字 / 集合如实报错
    expect(textOf(await run('/tool add nope'))).toContain('没有集合')
    expect(textOf(await run('/tool add screen:nope'))).toContain('没有「nope」')
    expect(textOf(await run('/tool wat'))).toContain('不认识 /tool wat')
  })

  it('/log 画家谱树：按代排序、父子编号、当前标记', async () => {
    const lineageFile = tempLineageFile()
    await seededTree(lineageFile)
    const run = createCommandHandler({
      repo: fakeRepo({
        head: async () => ({ branch: 'spring', detached: false, sha: 'def5678' }),
        status: async () => ({ ok: true, root: 'C:/tmp/memory-repo', branch: 'spring', head: 'def5678', dirty: false }),
        ...treeBranches()
      }),
      lineageFile
    })
    expect(textOf(await run('/log'))).toBe(
      [
        '[0] life · 主干',
        '[0-0] ask · 纯模型 · 0 个工具',
        '[0-1] default · 11 个工具',
        '[0-1-0] spring · 11 个工具  ← 当前',
        '[0-2] gen2 · 11 个工具'
      ].join('\n')
    )
  })

  it('/log <编号>：看该节点的记忆（旧→新、带短 sha）；名字也行', async () => {
    const lineageFile = tempLineageFile()
    await seededTree(lineageFile)
    const run = createCommandHandler({
      repo: fakeRepo({
        ...treeBranches(),
        head: async () => ({ branch: 'default', detached: false, sha: 'bbb2222' }),
        commitCount: async (ref) => (ref === 'default' ? 2 : 0),
        branchLog: async (name, limit) =>
          name === 'default'
            ? [
                { hash: 'bbb2222', subject: 'memory: 2026-10-30 18:05', at: 2 },
                { hash: 'aaa1111', subject: 'memory: 2026-10-30', at: 1 }
              ].slice(0, limit)
            : []
      }),
      lineageFile
    })
    expect(textOf(await run('/log 0-1'))).toBe(
      [
        '[0] default  ← 当前',
        '[0-0] 记忆 2026-10-30 · aaa1111',
        '[0-1] 记忆 2026-10-30 18:05 · bbb2222  ← 正在用'
      ].join('\n')
    )
    // 不是当前节点：不标节点，也不标「正在用」
    expect(textOf(await run('/log ask')).split('\n')[0]).toBe('[0] ask')
    expect(textOf(await run('/log 9-9'))).toContain('没有节点 9-9')
  })

  it('/log <节点>：从某条提交分出去的分支挂在那条提交下面', async () => {
    const lineageFile = tempLineageFile()
    await seededTree(lineageFile)
    const run = createCommandHandler({
      repo: fakeRepo({
        ...treeBranches(),
        commitCount: async (ref) => (ref === 'default' ? 3 : 0),
        branchLog: async (name, limit) =>
          name === 'default'
            ? [
                { hash: 'ccc3333', subject: 'memory: 2026-10-30 20:00', at: 3 },
                { hash: 'bbb2222', subject: 'memory: 2026-10-30 12:00', at: 2 },
                { hash: 'aaa1111', subject: 'memory: 2026-10-30', at: 1 }
              ].slice(0, limit)
            : [],
        // spring 是从 default 的 aaa1111 分出去的
        mergeBase: async (a, b) =>
          a === 'spring' && b === 'default'
            ? 'aaa1111ffffffffffffffffffffffffffffffff'
            : null
      }),
      lineageFile
    })
    expect(textOf(await run('/log 0-1'))).toBe(
      [
        '[0] default  ← 当前',
        '[0-0] 记忆 2026-10-30 · aaa1111',
        '[0-0-0] spring',
        '[0-1] 记忆 2026-10-30 12:00 · bbb2222',
        '[0-2] 记忆 2026-10-30 20:00 · ccc3333'
      ].join('\n')
    )
  })

  it('/log n / /log l：一页 20 条，旧→新翻页', async () => {
    const lineageFile = tempLineageFile()
    await ensureLineage(lineageFile, { now: 1 })
    // 最新在前（跟 branchLog 一致）：all[0] = m24，all[24] = m0（最旧）
    const all = Array.from({ length: 25 }, (_, index) => {
      const n = 24 - index
      return {
        hash: `h${String(n).padStart(6, '0')}`,
        subject: `memory: m${n}`,
        at: n
      }
    })
    const run = createCommandHandler({
      repo: fakeRepo({
        commitCount: async (ref) => (ref === 'default' ? all.length : 0),
        branchLog: async (_name, limit) => all.slice(0, limit)
      }),
      lineageFile
    })
    const first = textOf(await run('/log 0'))
    const firstLines = first.split('\n')
    expect(firstLines[0]).toBe('[0] default  ← 当前')
    expect(firstLines[1]).toBe('[0-0] m0 · h000000')
    expect(firstLines[20]).toBe('[0-19] m19 · h000019')
    expect(first).toContain('/log n 下一页（更新）')

    const second = textOf(await run('/log n'))
    expect(second.split('\n')[1]).toBe('[0-0] m20 · h000020')
    expect(second.split('\n')[5]).toBe('[0-4] m24 · h000024')
    expect(second).toContain('/log l 上一页（更旧）')
    expect(second).not.toContain('/log n 下一页（更新）')

    const back = textOf(await run('/log l'))
    expect(back.split('\n')[1]).toBe('[0-0] m0 · h000000')
    expect(back).toContain('/log n 下一页（更新）')
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
    expect(text).toContain('新节点 ✨chun-tian')
    expect(text).toContain('从 ✨default 开出')

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
    expect(textOf(await run('秋天'))).toContain('新节点 ✨qiu-tian')
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
    expect(text).toContain('✨spring')
    expect(switched).toBe('spring')
    expect(reloads).toBe(1)

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('spring')
  })

  it('/use 回到已交接的母亲：补一条交接回执（D82：家谱真名）', async () => {
    const lineageFile = tempLineageFile()
    const base = await ensureLineage(lineageFile, { now: 1 })
    const born = withGenerationAdded(base.lineage, {
      branch: 'yumiao',
      nickname: '鱼苗',
      mother: 'default',
      at: 2
    })
    if (born === null) throw new Error('seed failed')
    await writeLineage(lineageFile, withGenerationRealName(born, 'default', '贴心大肥鱼'))
    let current = 'yumiao'
    const run = createCommandHandler({
      repo: fakeRepo({
        listBranches: async () => [
          { branch: 'default', sha: 'a1', subject: 'memory: 2026-10-31', at: 1 },
          { branch: 'yumiao', sha: 'a2', subject: 'memory: born yumiao', at: 2 }
        ],
        head: async () => ({ branch: current, detached: false, sha: 'a2' }),
        switchBranch: async (name) => {
          current = name
          return { ok: true, head: { branch: name, detached: false, sha: 'a1' } }
        }
      }),
      lineageFile
    })
    const text = textOf(await run('/use default'))
    expect(text).toContain('已切到节点 ✨default')
    expect(text).toContain('🎗️提示')
    expect(text).toContain('✨<贴心大肥鱼> 生命耗尽  ta的女儿 ✨<鱼苗> 将接续ta的使命')
  })

  it('/log 家谱树显示真名（D82）：有真名就「真名 (分支)」', async () => {
    const lineageFile = tempLineageFile()
    const base = await ensureLineage(lineageFile, { now: 1 })
    const born = withGenerationAdded(base.lineage, {
      branch: 'yumiao',
      nickname: '鱼苗',
      mother: 'default',
      at: 2
    })
    if (born === null) throw new Error('seed failed')
    await writeLineage(lineageFile, born)
    const run = createCommandHandler({
      repo: fakeRepo({
        listBranches: async () => [
          { branch: 'default', sha: 'a1', subject: 'memory: 2026-10-31', at: 1 },
          { branch: 'yumiao', sha: 'a2', subject: 'memory: born yumiao', at: 2 }
        ],
        head: async () => ({ branch: 'yumiao', detached: false, sha: 'a2' })
      }),
      lineageFile
    })
    const text = textOf(await run('/log'))
    expect(text).toContain('鱼苗 (yumiao)')
  })

  it('/use 编号：认家谱树的编号（0 / 0-1 / 0-1-0）', async () => {    const lineageFile = tempLineageFile()
    await seededTree(lineageFile)
    let current = 'life'
    const run = createCommandHandler({
      repo: fakeRepo({
        ...treeBranches(),
        head: async () => ({ branch: current, detached: false, sha: 'a1' }),
        switchBranch: async (name) => {
          current = name
          return { ok: true, head: { branch: name, detached: false, sha: 'a1' } }
        }
      }),
      lineageFile
    })
    expect(textOf(await run('/use 0-1-0'))).toContain('✨spring')
    expect(current).toBe('spring')
    expect(textOf(await run('/use 9'))).toContain('没有节点 9')
  })

  it('/use 0 是 life 主干：拒绝，免得把对话写进出生线', async () => {
    const lineageFile = tempLineageFile()
    await seededTree(lineageFile)
    let switched: string | null = null
    const run = createCommandHandler({
      repo: fakeRepo({
        ...treeBranches(),
        head: async () => ({ branch: 'default', detached: false, sha: 'a2' }),
        switchBranch: async (name) => {
          switched = name
          return { ok: true, head: { branch: name, detached: false, sha: 'a2' } }
        }
      }),
      lineageFile
    })
    expect(textOf(await run('/use 0'))).toContain('出生主干')
    expect(switched).toBeNull()
  })

  it('/use 起名：脏工作区先回执起名；回 0 = 默认时间戳名，回名字 = 自定义', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    const commits: string[] = []
    const switched: string[] = []
    const make = (): ReturnType<typeof createCommandHandler> =>
      createCommandHandler({
        repo: fakeRepo({
          ...twoBranches(),
          status: async () => ({ ok: true, root: 'C:/tmp/memory-repo', branch: 'default', head: 'abc1234', dirty: true }),
          commit: async (message) => {
            commits.push(message)
            return { committed: true, hash: 'aaa1111' }
          },
          switchBranch: async (name) => {
            switched.push(name)
            return { ok: true, head: { branch: name, detached: false, sha: 'def5678' } }
          }
        }),
        lineageFile,
        now: () => new Date(2026, 9, 30, 18, 5).getTime()
      })

    const run = make()
    expect(textOf(await run('/use 0-0'))).toContain('回 0 用默认：记忆 2026-10-30 18:05')
    expect(switched).toEqual([])
    expect(textOf(await run('0'))).toContain('✨spring')
    expect(commits).toEqual(['memory: 2026-10-30 18:05'])
    expect(switched).toEqual(['spring'])

    // 自定义名字原样存（不转拼音）
    const custom = make()
    expect(textOf(await custom('/use 0-0'))).toContain('给它起个名字')
    expect(textOf(await custom('装修预算'))).toContain('✨spring')
    expect(commits[1]).toBe('memory: 装修预算')

    // -d 直接用默认名，不问
    const defaulted = make()
    expect(textOf(await defaulted('/use 0-0 -d'))).toContain('✨spring')
    expect(commits[2]).toBe('memory: 2026-10-30 18:05')
  })

  it('/use 起名等待超时：按默认名保存并切换；/cancel 放弃', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    let clock = new Date(2026, 9, 30, 18, 5).getTime()
    const commits: string[] = []
    const switched: string[] = []
    const run = createCommandHandler({
      repo: fakeRepo({
        ...twoBranches(),
        status: async () => ({ ok: true, root: 'C:/tmp/memory-repo', branch: 'default', head: 'abc1234', dirty: true }),
        commit: async (message) => {
          commits.push(message)
          return { committed: true, hash: 'aaa1111' }
        },
        switchBranch: async (name) => {
          switched.push(name)
          return { ok: true, head: { branch: name, detached: false, sha: 'def5678' } }
        }
      }),
      lineageFile,
      now: () => clock
    })

    expect(textOf(await run('/use 0-0'))).toContain('给它起个名字')
    expect(textOf(await run('/cancel'))).toBe('已取消。')
    expect(commits).toEqual([])
    expect(switched).toEqual([])

    expect(textOf(await run('/use 0-0'))).toContain('给它起个名字')
    clock += COMMAND_WAIT_TIMEOUT_MS + 1
    expect(await run('随便问一句')).toBeNull()
    // 默认名按「真正落提交那一刻」算（18:05 起名提示，超时 60 秒后是 18:06）
    expect(commits).toEqual(['memory: 2026-10-30 18:06'])
    expect(switched).toEqual(['spring'])
  })

  it('/use 短 sha：切到历史提交（只读），家谱记作当前节点', async () => {
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
    expect(text).toContain('已停在历史提交 ✨abc1234')
    expect(text).toContain('家谱当前节点记作 ✨default')
    expect(text).toContain('从 ✨default 分叉成 ✨default-2')
    expect(checkedOut).toBe('abc1234')

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe(seeded.active)
  })

  it('/use 短 sha：刚看过哪个节点的历史，就记作那个节点（下一句从它分叉）', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
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
    // 先看 spring 的历史（它才是「我 use <sha> 之前在看的那页」）
    expect(textOf(await run('/log 0-0'))).toContain('[0] spring')
    const text = textOf(await run('/use abc1234'))
    expect(text).toContain('家谱当前节点记作 ✨spring')
    expect(text).toContain('从 ✨spring 分叉成 ✨spring-2')
    expect(checkedOut).toBe('abc1234')

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('spring')
  })

  it('/log 停在历史提交时，把「正在看」的节点标出来', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    const run = createCommandHandler({
      repo: fakeRepo({
        ...twoBranches(),
        head: async () => ({ branch: null, detached: true, sha: 'abc1234' })
      }),
      lineageFile
    })
    expect(textOf(await run('/log'))).toContain('[0] default · 11 个工具  ← 正在看')
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
    const text = textOf(await run('/backup -d'))
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
    expect(textOf(await pushed('/backup -d'))).toContain('推送成功。')

    const pushFailed = createCommandHandler({
      repo: fakeRepo({
        commit: async () => ({ committed: true, hash: 'abc1234' }),
        push: async () => ({ ok: false, reason: 'failed' })
      }),
      lineageFile
    })
    expect(textOf(await pushFailed('/backup -d'))).toContain('推送失败（网络 / 凭据）')

    const clean = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await clean('/backup -d'))).toBe('没有新内容要提交。')

    const unavailable = createCommandHandler({
      repo: fakeRepo({ commit: async () => ({ committed: false, reason: 'unavailable' }) }),
      lineageFile
    })
    expect(textOf(await unavailable('/backup -d'))).toContain('记忆仓不可用')
  })

  it('/backup 回执起名：回 0 用默认时间戳名；命令后面不跟名字', async () => {
    const lineageFile = tempLineageFile()
    const commits: string[] = []
    const run = createCommandHandler({
      repo: fakeRepo({
        commit: async (message) => {
          commits.push(message)
          return { committed: true, hash: 'abc1234' }
        }
      }),
      lineageFile,
      now: () => new Date(2026, 9, 30, 9, 7).getTime()
    })
    expect(textOf(await run('/backup'))).toContain('回 0 用默认：记忆 2026-10-30 09:07')
    expect(textOf(await run('0'))).toContain('已提交 abc1234。')
    expect(commits).toEqual(['memory: 2026-10-30 09:07'])

    expect(textOf(await run('/backup'))).toContain('给它起个名字')
    expect(textOf(await run('今天收拾房间'))).toContain('已提交 abc1234。')
    expect(commits[1]).toBe('memory: 今天收拾房间')

    expect(textOf(await run('/backup 起名'))).toContain('用法：/backup [-d]')
  })

  it('/git：在记忆仓里跑原生命令，回显输出与退出码；stderr 也回显', async () => {
    const lineageFile = tempLineageFile()
    const seen: string[][] = []
    const run = createCommandHandler({
      repo: fakeRepo({
        git: async (args) => {
          seen.push([...args])
          return {
            ok: false,
            code: 128,
            stdout: '1b2d9b3 save\nccf78e8 day\n',
            stderr: 'warning: 示例 stderr\n'
          }
        }
      }),
      lineageFile
    })
    const text = textOf(await run('/git log --oneline -2'))
    expect(seen).toEqual([['log', '--oneline', '-2']])
    expect(text).toContain('/git log --oneline -2')
    expect(text.split('\n')[1]).toBe('1b2d9b3 save')
    expect(text).toContain('[stderr]')
    expect(text).toContain('warning: 示例 stderr')
    expect(text).toContain('（第 1/1 页 · 退出码 128）')

    const missing = createCommandHandler({
      repo: fakeRepo({ git: async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'git-missing' }) }),
      lineageFile
    })
    expect(textOf(await missing('/git status'))).toContain('没找到 git')

    expect(textOf(await run('/git'))).toContain('用法：/git <git 参数>')
    const fresh = createCommandHandler({ repo: fakeRepo(), lineageFile })
    expect(textOf(await fresh('/git n'))).toContain('先跑一条 /git 命令')
  })

  it('/git：输出超过一页时 /git n / /git l 翻页（不重跑命令）', async () => {
    const lineageFile = tempLineageFile()
    let calls = 0
    const stdout = `${Array.from({ length: 45 }, (_, index) => `l${index}`).join('\n')}\n`
    const run = createCommandHandler({
      repo: fakeRepo({
        git: async () => {
          calls += 1
          return { ok: true, code: 0, stdout, stderr: '' }
        }
      }),
      lineageFile
    })
    const first = textOf(await run('/git log -45'))
    expect(first.split('\n')[1]).toBe('l0')
    expect(first.split('\n')[20]).toBe('l19')
    expect(first).toContain('第 1/3 页')
    expect(first).toContain('/git n 下一页')

    const second = textOf(await run('/git n'))
    expect(second.split('\n')[1]).toBe('l20')
    expect(second).toContain('/git l 上一页')
    expect(calls).toBe(1)

    expect(textOf(await run('/git l')).split('\n')[1]).toBe('l0')
  })

  it('/git：改了 HEAD 就同步家谱当前节点并重载会话', async () => {
    const lineageFile = tempLineageFile()
    await seededLineage(lineageFile)
    let current = 'default'
    let reloads = 0
    const run = createCommandHandler({
      repo: fakeRepo({
        head: async () => ({
          branch: current,
          detached: false,
          sha: current === 'default' ? 'abc1234' : 'def5678'
        }),
        git: async (args) => {
          if (args[0] === 'checkout') current = 'spring'
          return { ok: true, code: 0, stdout: '', stderr: '' }
        }
      }),
      lineageFile,
      reloadConversations: () => {
        reloads += 1
      }
    })
    const text = textOf(await run('/git checkout spring'))
    expect(text).toContain('（没有输出）')
    expect(text).toContain('HEAD 已切到 spring，家谱当前节点同步')
    expect(reloads).toBe(1)

    const read = await readLineage(lineageFile)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('spring')
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
        return { ok: true, dropped: 3, kept: 6, summaryTokens: 270, beforeTokens: 6_600, afterTokens: 5_100 }
      }
    })
    const text = textOf(await compacted('/compact', { conversationId: 'c1' }))
    expect(received).toBe('c1')
    expect(text.startsWith('🎗️提示')).toBe(true)
    expect(text).not.toContain('===')
    expect(text).toContain('压掉 3 轮（保留最近 6 轮原文），摘要 270 token')
    expect(text).toContain('上下文 6.6k → 5.1k token（估算）')
    expect(text).not.toContain('字')
  })

  it('/life：按格式报剩余生命（token）', async () => {
    const lineageFile = tempLineageFile()
    const seeded = await ensureLineage(lineageFile, { now: 1 })
    const active = seeded.lineage.active
    await writeLineage(lineageFile, {
      ...seeded.lineage,
      life_tokens: 1_000_000,
      branches: seeded.lineage.branches.map((item) =>
        item.branch === active ? { ...item, life_tokens_used: 200_000 } : item
      )
    })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const text = textOf(await run('/life'))
    expect(text).toBe('❤️剩余生命✨80%\n🔤上下文 已使用✨200k，剩余✨800k（1000k）')
  })

  it('/life：纯模型分支也有生命（同样 500K，只是不冻结）', async () => {
    const lineageFile = tempLineageFile()
    const seeded = await ensureLineage(lineageFile, { now: 1 })
    const withAsk = withBranchAdded(seeded.lineage, {
      branch: 'ask',
      generation: 'gen-1',
      parent: 'default',
      at: 2,
      kind: 'assistant'
    })
    expect(withAsk).not.toBeNull()
    if (withAsk === null) return
    await writeLineage(lineageFile, { ...withAsk, active: 'ask' })
    const run = createCommandHandler({ repo: fakeRepo(), lineageFile })
    const text = textOf(await run('/life'))
    expect(text).toContain('❤️剩余生命✨100%')
    expect(text).toContain('已使用✨0，剩余✨500k（500k）')
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

describe('命令串行锁（M5：桌面 + QQ 共用一份 handler）', () => {
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  it('两路同时发命令：一条跑完再跑下一条', async () => {
    const order: string[] = []
    const run = serializeCommands(async (text) => {
      order.push(`start:${text}`)
      await delay(5)
      order.push(`end:${text}`)
      return commandResult(`done:${text}`)
    })
    const both = await Promise.all([run('/log'), run('/life')])
    expect(order).toEqual(['start:/log', 'end:/log', 'start:/life', 'end:/life'])
    expect(both.map((result) => (result?.kind === 'command' ? result.text : ''))).toEqual([
      'done:/log',
      'done:/life'
    ])
  })

  it('前一条抛错不影响后一条', async () => {
    const seen: string[] = []
    const run = serializeCommands(async (text) => {
      seen.push(text)
      if (text === '/del') throw new Error('boom')
      return commandResult('ok')
    })
    await expect(run('/del')).rejects.toThrow('boom')
    const after = await run('/help')
    expect(after?.kind).toBe('command')
    expect(seen).toEqual(['/del', '/help'])
  })
})
