/**
 * 信存储（D81）：仓内草稿 / 待寄 / 未读 + 桌面落点。
 *
 * 在临时目录里跑真实 git 仓（不启动 Electron），守住：
 * 三个 at 的落点、桌面不覆盖、未读标已读、待寄在 give_birth 前独立存在。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildLetterContent,
  carryOutboxLetters,
  createLetterStore,
  parseLetterContent,
  readOutboxLetters,
  type LetterStore
} from '../../src/main/letters'
import { createMemoryRepo, type MemoryRepo } from '../../src/main/memory-repo'

const TIMEOUT = 90_000
const NOW = new Date(2026, 9, 31, 12, 0, 0, 0).getTime()

let dirs: string[] = []
let repo: MemoryRepo
let desktopDir: string
let store: LetterStore

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-letters-'))
  dirs.push(dir)
  repo = createMemoryRepo({ root: join(dir, 'memory-repo') })
  expect((await repo.ensure()).ok).toBe(true)
  desktopDir = join(dir, 'desktop')
  store = createLetterStore({ repo, desktopDir, now: () => NOW })
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('buildLetterContent / parseLetterContent', () => {
  it('往返：写给谁 / 来自谁 / 时间 / 正文都在', () => {
    const content = buildLetterContent({ from: '小鱼', to: '妈妈', at: NOW, text: '我很好。' })
    expect(parseLetterContent(content)).toMatchObject({
      from: '小鱼',
      to: '妈妈',
      at: NOW,
      text: '我很好。'
    })
  })

  it('缺头部 / 时间坏了：返回 null，不瞎猜', () => {
    expect(parseLetterContent('只有正文')).toBeNull()
    expect(parseLetterContent('写给：主人\n来自：小鱼\n写于：昨天\n\n---\n\n正文')).toBeNull()
  })
})

describe('write / list', () => {
  it('at=self：写进仓的 letters/，立即提交', { timeout: TIMEOUT }, async () => {
    const result = await store.write({ from: '小鱼', to: '妈妈', write: '我很好。', at: 'self' })
    expect(result.ok).toBe(true)
    expect(result.id).toBe('20261031-120000')
    expect(await repo.readFile('letters/20261031-120000.md')).toContain('我很好。')
    expect((await repo.lastCommit())?.subject).toBe('memory: letter 20261031-120000')

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: '20261031-120000', from: '小鱼', to: '妈妈', where: 'letters', unread: false })
  })

  it('at=daughter：写进 outbox，不标未读（还没出生）', { timeout: TIMEOUT }, async () => {
    const result = await store.write({ from: '小鱼', to: '女儿', write: '给你。', at: 'daughter' })
    expect(result.ok).toBe(true)
    expect(await repo.readFile('letters/outbox/20261031-120000.md')).toContain('给你。')
    const list = await store.list()
    expect(list[0]).toMatchObject({ where: 'outbox', unread: false })
  })

  it('at=desktop：写到你桌面，不进仓；同一秒再写不覆盖', { timeout: TIMEOUT }, async () => {
    const first = await store.write({ from: '小鱼', to: '主人', write: '今天也很晚。', at: 'desktop' })
    expect(first.ok).toBe(true)
    const path = join(desktopDir, '记忆球的信', '20261031-120000.md')
    expect(readFileSync(path, 'utf8')).toContain('今天也很晚。')

    const second = await store.write({ from: '小鱼', to: '主人', write: '第二封。', at: 'desktop' })
    expect(second.ok).toBe(true)
    expect(second.id).toBe('20261031-120000-2')
    expect(readFileSync(path, 'utf8')).toContain('今天也很晚。')
    expect(readFileSync(join(desktopDir, '记忆球的信', '20261031-120000-2.md'), 'utf8')).toContain('第二封。')

    // 桌面信不进仓
    expect(await store.list()).toHaveLength(0)
  })
})

describe('unread / read', () => {
  it('未读：read() 不传 id 读最新一封，读完标已读并提交', { timeout: TIMEOUT }, async () => {
    const id = '20261031-110000'
    expect(
      await repo.writeFile(
        `letters/${id}.md`,
        buildLetterContent({ from: '妈妈', to: '小鱼', at: NOW - 3_600_000, text: '好好长大。' })
      )
    ).toBe(true)
    expect(
      await repo.writeFile(
        'letters/unread.json',
        `${JSON.stringify(
          { unread: [{ id, file: `letters/${id}.md`, from: '妈妈', to: '小鱼', at: NOW - 3_600_000 }] },
          null,
          2
        )}\n`
      )
    ).toBe(true)
    await repo.commit('memory: seed letter')

    expect(await store.unreadCount()).toBe(1)
    const letter = await store.read()
    expect(letter).toMatchObject({ id, from: '妈妈', to: '小鱼', text: '好好长大。' })
    expect(await store.unreadCount()).toBe(0)
    expect(JSON.parse((await repo.readFile('letters/unread.json')) ?? '{}').unread).toEqual([])
    expect((await repo.lastCommit())?.subject).toBe(`memory: read ${id}`)

    // 读完还可以按 id 再读（自由读，不依赖未读）
    expect(await store.read(id)).toMatchObject({ text: '好好长大。' })
  })

  it('没有未读：read() 返回 null', { timeout: TIMEOUT }, async () => {
    expect(await store.read()).toBeNull()
    expect(await store.read('nope')).toBeNull()
  })
})

describe('outbox → give_birth 前独立存在', () => {
  it('读得出来，也带得进新分支并标未读', { timeout: TIMEOUT }, async () => {
    const id = '20261031-113000'
    await repo.writeFile(
      `letters/outbox/${id}.md`,
      buildLetterContent({ from: '小鱼', to: '女儿', at: NOW - 1_800_000, text: '给你。' })
    )
    await repo.commit('memory: letter outbox')

    const outbox = await readOutboxLetters(repo)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ id })

    // 新分支（模拟女儿）里带过去
    expect((await repo.switchCreateOrphan('daughter')).ok).toBe(true)
    expect(await carryOutboxLetters(repo, outbox)).toBe(true)
    expect(await repo.readFile(`letters/${id}.md`)).toContain('给你。')
    const unread = JSON.parse((await repo.readFile('letters/unread.json')) ?? '{}')
    expect(unread.unread).toHaveLength(1)
    expect(unread.unread[0]).toMatchObject({ id, to: '女儿' })
  })
})
