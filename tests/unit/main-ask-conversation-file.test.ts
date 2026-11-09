/**
 * 会话落盘（memory-life M1）：JSONL + 图片二进制资产。
 *
 * 重点：图片不进 JSONL 文本（仓里是二进制、用时才转 base64）、同一张图只存一份、
 * 重启后能原样读回、资产丢了只丢那一张不整条报废、清空时连文件一起清。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  conversationFilePath,
  conversationFileName,
  createAskConversationFileStore,
  createAskConversationRegistry,
  createAskConversationStore,
  createCanonicalConversation,
  pickFallbackConversationId
} from '../../src/main/ask-conversation'
import type { CloudAskConversation } from '../../src/chain/agent/conversation'

const dirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-memory-conv-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dataUrl(bytes: number[]): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

const IMAGE_A = dataUrl([11, 22, 33])
const IMAGE_B = dataUrl([44, 55, 66])

function conversation(): CloudAskConversation {
  return {
    digest: 'd1',
    turns: [
      {
        question: '这张图里是什么',
        now: '2026-10-30 18:00',
        turns: [
          {
            toolCall: { name: 'read_segment', arguments: { segmentId: 7 } },
            toolResult: { kind: 'read_segment', text: { text: '...' } },
            images: [IMAGE_A],
            reasoning: '先看一眼'
          }
        ],
        answer: '一块蓝色',
        attachments: { images: [IMAGE_A], files: [{ name: 'a.txt', text: 'hello' }] }
      },
      {
        question: '再换一张',
        now: '',
        turns: [],
        answer: '好',
        attachments: { images: [IMAGE_B], files: [] }
      }
    ]
  }
}

describe('会话落盘', () => {
  it('图片写成二进制资产，JSONL 里只留引用（同图去重）', () => {
    const root = tempRoot()
    const store = createAskConversationFileStore({ root, conversationId: 'c1' })
    store.save(conversation())

    const file = conversationFilePath(root, 'c1')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('base64,')
    expect(raw).toContain('assets/')
    expect(raw).toContain('"digest":"d1"')

    const assets = readdirSync(join(root, 'conversations', 'assets'))
    // IMAGE_A 在工具轮和附件里各出现一次 → 只存一份；IMAGE_B 一份
    expect(assets).toHaveLength(2)
    const stored = assets.map((name) => readFileSync(join(root, 'conversations', 'assets', name)))
    expect(stored.some((bytes) => bytes.equals(Buffer.from([11, 22, 33])))).toBe(true)
    expect(stored.some((bytes) => bytes.equals(Buffer.from([44, 55, 66])))).toBe(true)
  })

  it('重开（新 store）能原样读回 data URL 与文本', () => {
    const root = tempRoot()
    createAskConversationFileStore({ root, conversationId: 'c1' }).save(conversation())

    const loaded = createAskConversationFileStore({ root, conversationId: 'c1' }).load()
    expect(loaded.digest).toBe('d1')
    expect(loaded.turns).toHaveLength(2)
    expect(loaded.turns[0].answer).toBe('一块蓝色')
    expect(loaded.turns[0].turns[0].images).toEqual([IMAGE_A])
    expect(loaded.turns[0].turns[0].reasoning).toBe('先看一眼')
    expect(loaded.turns[0].attachments).toEqual({
      images: [IMAGE_A],
      files: [{ name: 'a.txt', text: 'hello' }]
    })
    expect(loaded.turns[1].attachments?.images).toEqual([IMAGE_B])
    // 保留字段：空的 files / images 不凭空造
    expect(loaded.turns[1].attachments?.files).toEqual([])
  })

  it('资产丢了只丢那一张图，文本照常回放', () => {
    const root = tempRoot()
    createAskConversationFileStore({ root, conversationId: 'c1' }).save(conversation())
    rmSync(join(root, 'conversations', 'assets'), { recursive: true, force: true })

    const loaded = createAskConversationFileStore({ root, conversationId: 'c1' }).load()
    expect(loaded.turns[0].answer).toBe('一块蓝色')
    expect(loaded.turns[0].turns[0].images).toBeUndefined()
    // 文本附件不依赖资产，照常保留
    expect(loaded.turns[0].attachments).toEqual({ images: [], files: [{ name: 'a.txt', text: 'hello' }] })
  })

  it('坏行跳过，不影响其它轮', () => {
    const root = tempRoot()
    const file = conversationFilePath(root, 'c1')
    mkdirSync(join(root, 'conversations'), { recursive: true })
    writeFileSync(
      file,
      [
        '{"v":1,"digest":"d"}',
        'not json',
        '{"question":"q","now":"","turns":[],"answer":"a"}'
      ].join('\n'),
      'utf8'
    )
    const loaded = createAskConversationFileStore({
      root,
      conversationId: 'c1',
      log: () => undefined
    }).load()
    expect(loaded.digest).toBe('d')
    expect(loaded.turns).toHaveLength(1)
    expect(loaded.turns[0].question).toBe('q')
  })

  it('会话 id 不可直接当文件名时按哈希落名', () => {
    expect(conversationFileName('c1')).toBe('c1')
    expect(conversationFileName('qq-12345')).toBe('qq-12345')
    expect(conversationFileName('../../etc/passwd')).toMatch(/^h-[0-9a-f]{16}$/)
  })

  it('注册表：多个会话各自落盘，clear 连文件与资产一起清', () => {
    const root = tempRoot()
    const registry = createAskConversationRegistry({ root, log: () => undefined })
    registry.for('c1').save(conversation())
    registry.for('qq-12345').save({ digest: '', turns: [] })
    expect(registry.size()).toBe(2)

    const dir = join(root, 'conversations')
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toHaveLength(2)
    expect(existsSync(join(dir, 'assets'))).toBe(true)

    registry.clear()
    expect(registry.size()).toBe(0)
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toEqual([])
    expect(existsSync(join(dir, 'assets'))).toBe(false)
    // 清完再取是新会话，不会「记得」已删的对话
    expect(registry.for('c1').load()).toEqual({ digest: '', turns: [] })
  })

  it('reload 只清内存缓存：盘上内容变了再取会重读（切节点用）', () => {
    const root = tempRoot()
    const registry = createAskConversationRegistry({ root, log: () => undefined })
    registry.for('c1').save({ digest: '旧节点', turns: [] })

    // 模拟 checkout：盘上同名文件被换成另一个节点的内容
    createAskConversationFileStore({ root, conversationId: 'c1' }).save({ digest: '新节点', turns: [] })

    // 不 reload 时仍是内存里的旧内容（前缀缓存不变）
    expect(registry.for('c1').load().digest).toBe('旧节点')
    registry.reload()
    expect(registry.for('c1').load().digest).toBe('新节点')
    // 文件没被删
    expect(readdirSync(join(root, 'conversations')).some((name) => name === 'c1.jsonl')).toBe(true)
  })

  it('clear 只清内存：这一问之后的会话从空白开始（M4 传承）', () => {
    const root = tempRoot()
    const store = createAskConversationFileStore({ root, conversationId: 'c1', log: () => undefined })
    store.save(conversation())
    expect(store.load().turns).toHaveLength(2)
    store.clear?.()
    expect(store.load()).toEqual({ digest: '', turns: [] })
  })

  it('`/compact` 的覆盖轮数落进 meta 行：重启后占位口径不变（D97）', () => {
    const root = tempRoot()
    createAskConversationFileStore({ root, conversationId: 'c1' }).save({
      ...conversation(),
      compactedTurns: 2
    })
    const raw = readFileSync(conversationFilePath(root, 'c1'), 'utf8')
    expect(raw).toContain('"compactedTurns":2')
    // 原文照旧在文件里（不删轮、不用摘要替换）
    expect(raw).toContain('一块蓝色')

    const loaded = createAskConversationFileStore({ root, conversationId: 'c1' }).load()
    expect(loaded.compactedTurns).toBe(2)
    expect(loaded.turns).toHaveLength(2)
    expect(loaded.turns[0]?.answer).toBe('一块蓝色')
  })

  it('内存实现也保留覆盖轮数；没压过的会话读回来仍是空形状', () => {
    const store = createAskConversationStore()
    expect(store.load()).toEqual({ digest: '', turns: [] })
    store.save({ ...conversation(), compactedTurns: 1 })
    expect(store.load().compactedTurns).toBe(1)
    expect(store.load().turns).toHaveLength(2)
  })
})

describe('桌面当前会话的回退（D109）', () => {
  function seed(root: string, id: string, mtimeSec: number): void {
    mkdirSync(join(root, 'conversations'), { recursive: true })
    const file = conversationFilePath(root, id)
    writeFileSync(file, '{"v":1,"digest":""}\n', 'utf8')
    utimesSync(file, mtimeSec, mtimeSec)
  }

  it('优先最后一条 QQ 用户消息所在的会话，即使任务会话的 mtime 更新', () => {
    const root = tempRoot()
    seed(root, 'cmw-old', 1_700_000_000)
    seed(root, 'cmw-task', 1_700_000_100)
    expect(pickFallbackConversationId(root, 'cmw-old')).toBe('cmw-old')
  })

  it('优先项不存在（切了分支 / 已清空）时退回 mtime 最新的非 qq-* 会话', () => {
    const root = tempRoot()
    seed(root, 'cmw-old', 1_700_000_000)
    seed(root, 'cmw-new', 1_700_000_100)
    seed(root, 'qq-1', 1_700_000_200)
    expect(pickFallbackConversationId(root, 'cmw-missing')).toBe('cmw-new')
  })

  it('旧 qq-* 会话只读：台账最后一条用户消息在那边也不选（D106 ⑤）', () => {
    const root = tempRoot()
    seed(root, 'qq-1', 1_700_000_300)
    seed(root, 'cmw-old', 1_700_000_000)
    expect(pickFallbackConversationId(root, 'qq-1')).toBe('cmw-old')
  })

  it('一个会话文件都没有时返回 null，由调用方退回固定 id', () => {
    const root = tempRoot()
    expect(pickFallbackConversationId(root, null)).toBeNull()
  })
})

describe('一条会话（D110）', () => {
  function seed(root: string, id: string, mtimeSec: number): void {
    mkdirSync(join(root, 'conversations'), { recursive: true })
    const file = conversationFilePath(root, id)
    writeFileSync(file, '{"v":1,"digest":""}\n', 'utf8')
    utimesSync(file, mtimeSec, mtimeSec)
  }

  it('第一次解析后永远返回同一个 id：台账后来变了也不跟着走', () => {
    const root = tempRoot()
    seed(root, 'cmw-chat', 1_700_000_000)
    seed(root, 'cmw-other', 1_700_000_100)
    let lastUser = 'cmw-chat'
    const current = createCanonicalConversation({ root, lastUserConversation: () => lastUser })
    expect(current()).toBe('cmw-chat')
    // 中途有别的会话更新了、台账也指向了它：仍然不换（换 = 记忆被劈开）
    lastUser = 'cmw-other'
    utimesSync(conversationFilePath(root, 'cmw-other'), 1_700_000_900, 1_700_000_900)
    expect(current()).toBe('cmw-chat')
  })

  it('一点线索都没有时退回固定 id（默认 main）', () => {
    const root = tempRoot()
    expect(createCanonicalConversation({ root, lastUserConversation: () => null })()).toBe('main')
    expect(
      createCanonicalConversation({ root, lastUserConversation: () => null, fallback: 'self' })()
    ).toBe('self')
  })
})
