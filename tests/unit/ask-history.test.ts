/**
 * 问记忆对话记录：JSONL 落盘 / 读回 / 清空 / 折条
 *
 * 重点：永久保留（不自动删）、坏行跳过而不是整份作废、读失败不当异常抛。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendAskHistory,
  ASK_HISTORY_FILE,
  clearAskHistory,
  parseAskHistoryEntry,
  readAskHistory,
  removeAskHistoryConversation,
  toHistoryEntry,
  type AskHistoryEntry
} from '../../src/main/ask-history'
import type { ChainAskCitation, ChainAskResult } from '../../src/chain/agent/types'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-ask-history-'))
  dirs.push(dir)
  return join(dir, ASK_HISTORY_FILE)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function entry(at: number, question: string): AskHistoryEntry {
  return {
    id: `id-${at}`,
    at,
    question,
    kind: 'no-evidence',
    citations: [],
    stats: { hits: 0, evidence: 0, cited: 0, questionChars: question.length }
  }
}

const CITATION: ChainAskCitation = {
  segmentId: 12,
  at: 1_000,
  app: 'Firefox',
  title: '文档',
  why: '在这里看过《编译错误》'
}

describe('对话记录：读写', () => {
  it('文件不存在时读到空列表，且不建文件', () => {
    const path = tempFile()
    expect(readAskHistory(path)).toEqual([])
  })

  it('追加后按「最新在前」读回，字段原样保留', () => {
    const path = tempFile()
    appendAskHistory(path, entry(1_000, '早的问题'))
    appendAskHistory(path, entry(2_000, '晚的问题'))
    const list = readAskHistory(path)
    expect(list.map((item) => item.question)).toEqual(['晚的问题', '早的问题'])
    expect(list[1]).toMatchObject({ id: 'id-1000', at: 1_000, kind: 'no-evidence' })
    // 一行一条（追加写，不重写整份）
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('坏行 / 空行跳过，好行照读', () => {
    const path = tempFile()
    const good = JSON.stringify(entry(3_000, '好的'))
    writeFileSync(path, `{\n\n${good}\n{"id":"broken"}\n`, 'utf8')
    const list = readAskHistory(path)
    expect(list).toHaveLength(1)
    expect(list[0].question).toBe('好的')
  })

  it('清空后读回空列表，文件还在（下一条继续追加）', () => {
    const path = tempFile()
    appendAskHistory(path, entry(1_000, 'a'))
    clearAskHistory(path)
    expect(readAskHistory(path)).toEqual([])
    appendAskHistory(path, entry(2_000, 'b'))
    expect(readAskHistory(path).map((item) => item.question)).toEqual(['b'])
  })

  it('目录不存在时追加会自动建目录', () => {
    const path = join(tempFile(), 'nested', 'ask-history.jsonl')
    appendAskHistory(path, entry(1_000, 'a'))
    expect(readAskHistory(path)).toHaveLength(1)
  })
})

// 文件永久保留、无界增长：每问都要读它（开场时间戳 + ask_history 工具）。
// 缓存按 path + mtime + size 命中，自己追加/清空时推进；外部改写要能失效。
describe('对话记录：进程内缓存', () => {
  it('返回的是副本：改返回值不会污染下一次读', () => {
    const path = tempFile()
    appendAskHistory(path, entry(1_000, '第一问'))
    const first = readAskHistory(path)
    first.push(entry(9_999, '伪造'))
    expect(readAskHistory(path).map((item) => item.question)).toEqual(['第一问'])
  })

  it('自己追加后不重读文件也能读到新条目（最新在前）', () => {
    const path = tempFile()
    appendAskHistory(path, entry(1_000, '一早'))
    readAskHistory(path) // 建缓存
    appendAskHistory(path, entry(2_000, '一晚'))
    expect(readAskHistory(path).map((item) => item.question)).toEqual(['一晚', '一早'])
    // 缓存与文件一致：文件里就是两行
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('外部改写（手工编辑 / 拷回）后按 mtime/size 失效重解析', () => {
    const path = tempFile()
    appendAskHistory(path, entry(1_000, '旧的'))
    expect(readAskHistory(path).map((item) => item.question)).toEqual(['旧的'])
    writeFileSync(path, JSON.stringify(entry(2_000, '手工改过的一版记录')), 'utf8')
    expect(readAskHistory(path).map((item) => item.question)).toEqual(['手工改过的一版记录'])
  })

  it('清空后缓存也空，再追加能读到', () => {
    const path = tempFile()
    appendAskHistory(path, entry(1_000, '一问'))
    expect(readAskHistory(path)).toHaveLength(1)
    clearAskHistory(path)
    expect(readAskHistory(path)).toEqual([])
    appendAskHistory(path, entry(3_000, '二问'))
    expect(readAskHistory(path).map((item) => item.question)).toEqual(['二问'])
  })
})

describe('对话记录：单行校验', () => {
  it('拒绝坏形状（非对象 / 未知 kind / citations 不是数组 / stats 缺字段 / answer 类型错）', () => {
    const base = entry(1_000, 'q')
    expect(parseAskHistoryEntry(null)).toBeNull()
    expect(parseAskHistoryEntry('x')).toBeNull()
    expect(parseAskHistoryEntry({ ...base, kind: 'unknown' })).toBeNull()
    expect(parseAskHistoryEntry({ ...base, citations: 'nope' })).toBeNull()
    expect(parseAskHistoryEntry({ ...base, stats: { hits: 0 } })).toBeNull()
    expect(parseAskHistoryEntry({ ...base, id: '' })).toBeNull()
    expect(
      parseAskHistoryEntry({ ...base, kind: 'answer', answer: 42 })
    ).toBeNull()
  })

  it('合法行原样返回', () => {
    const base = entry(1_000, 'q')
    expect(parseAskHistoryEntry(base)).toEqual(base)
  })
})

describe('对话记录：折条', () => {
  it('answer 带回答与引用', () => {
    const result: ChainAskResult = {
      kind: 'answer',
      answer: '你问了 B 站',
      citations: [CITATION],
      stats: { hits: 3, evidence: 2, cited: 1, questionChars: 4 }
    }
    const record = toHistoryEntry('问', result, 5_000)
    expect(record).toMatchObject({
      at: 5_000,
      question: '问',
      kind: 'answer',
      answer: '你问了 B 站',
      citations: [CITATION],
      stats: result.stats
    })
    expect(record.id).not.toBe('')
  })

  it('no-evidence 只留类型与统计', () => {
    const result: ChainAskResult = {
      kind: 'no-evidence',
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 2 }
    }
    const record = toHistoryEntry('问', result, 5_000)
    expect(record).toMatchObject({ kind: 'no-evidence', citations: [] })
    expect(record.answer).toBeUndefined()
  })

  it('no-evidence 带说明与引用：落盘保留，不再整段丢掉', () => {
    const result: ChainAskResult = {
      kind: 'no-evidence',
      note: '信息链里没找到 LNK1104 的解决记录；只查到两条相关报错。',
      citations: [CITATION],
      stats: { hits: 2, evidence: 2, cited: 1, questionChars: 6 }
    }
    const record = toHistoryEntry('问', result, 5_000)
    expect(record).toMatchObject({
      kind: 'no-evidence',
      note: '信息链里没找到 LNK1104 的解决记录；只查到两条相关报错。',
      citations: [CITATION]
    })
    expect(parseAskHistoryEntry(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('insufficient 保留说明、引用与相关段', () => {
    const related = [
      { segmentId: 9, at: 1_000, app: 'DSH NEXT', title: '继续任务 — DeepSeek Harness' }
    ]
    const result: ChainAskResult = {
      kind: 'insufficient',
      answer: '只查到界面上的零散段落，没有「第一次打开」的时间锚点。',
      citations: [],
      related,
      stats: { hits: 40, evidence: 27, cited: 0, questionChars: 14, turns: 9, toolCalls: 9 }
    }
    const record = toHistoryEntry('我第一次打开这个界面是啥时候', result, 5_000, 'conv-1')
    expect(record).toMatchObject({ kind: 'insufficient', answer: result.answer, related })
    expect(parseAskHistoryEntry(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('trace 落盘 / 读回；坏 trace 整行跳过', () => {
    const result: ChainAskResult = {
      kind: 'answer',
      answer: '你问了 B 站',
      citations: [CITATION],
      trace: {
        steps: [
          {
            turn: 1,
            thinking: '先检索。',
            tools: [
              {
                name: 'search_info',
                arguments: { keywords: ['B站'] },
                summary: '检索命中 1 段（keywords）'
              }
            ]
          },
          { turn: 2, tools: [] }
        ]
      },
      stats: { hits: 1, evidence: 1, cited: 1, questionChars: 3 }
    }
    const record = toHistoryEntry('问', result, 5_000)
    expect(record.trace?.steps).toHaveLength(2)
    expect(parseAskHistoryEntry(JSON.parse(JSON.stringify(record)))).toEqual(record)
    expect(
      parseAskHistoryEntry({ ...record, trace: { steps: [{ turn: 'x', tools: [] }] } })
    ).toBeNull()
  })

  it('error 留原因与可读消息', () => {
    const result: ChainAskResult = {
      kind: 'error',
      reason: 'consent',
      message: '未确认',
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 2 }
    }
    const record = toHistoryEntry('问', result, 5_000)
    expect(record).toMatchObject({ kind: 'error', reason: 'consent', message: '未确认', citations: [] })
  })

  it('clarify 留确认问题与候选，且带会话 id', () => {
    const result: ChainAskResult = {
      kind: 'clarify',
      question: '想找上午还是下午的？',
      options: ['上午', '下午'],
      stats: { hits: 2, evidence: 2, cited: 0, questionChars: 3, turns: 2, toolCalls: 1 }
    }
    const record = toHistoryEntry('问', result, 5_000, 'conv-1')
    expect(record).toMatchObject({
      kind: 'clarify',
      conversationId: 'conv-1',
      citations: [],
      clarify: { question: '想找上午还是下午的？', options: ['上午', '下午'] }
    })
    expect(record.answer).toBeUndefined()
  })

  it('单行校验：clarify 缺 confirm 字段拒绝；conversationId 非法拒绝；老行（无新字段）照样读', () => {
    const base = entry(1_000, 'q')
    expect(parseAskHistoryEntry({ ...base, kind: 'clarify' })).toBeNull()
    expect(
      parseAskHistoryEntry({ ...base, kind: 'clarify', clarify: { question: ' ', options: [] } })
    ).toBeNull()
    expect(parseAskHistoryEntry({ ...base, conversationId: 42 })).toBeNull()
    expect(parseAskHistoryEntry(base)).toEqual(base)
  })

  it('单行校验：related 坏形状整行拒绝；空数组原样保留', () => {
    const base = entry(1_000, 'q')
    expect(parseAskHistoryEntry({ ...base, related: 'nope' })).toBeNull()
    expect(
      parseAskHistoryEntry({ ...base, related: [{ segmentId: 0, at: 1, app: 'A', title: 'T' }] })
    ).toBeNull()
    expect(parseAskHistoryEntry({ ...base, related: [] })).toEqual({ ...base, related: [] })
  })

  it('同一毫秒的两次折条 id 不重复', () => {
    const result: ChainAskResult = {
      kind: 'no-evidence',
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 1 }
    }
    const ids = new Set(Array.from({ length: 20 }, () => toHistoryEntry('问', result, 1_000).id))
    expect(ids.size).toBe(20)
  })
})

describe('传承（M4）：conceived 与按会话删除', () => {
  it('conceived 随记录落盘 / 读回', () => {
    const path = tempFile()
    const result: ChainAskResult = {
      kind: 'answer',
      answer: '我会记得你。',
      citations: [],
      stats: { hits: 0, evidence: 0, cited: 0, questionChars: 6 },
      conceived: true
    }
    appendAskHistory(path, toHistoryEntry('快没电了', result, 1_000, 'conv-1'))
    const [entry] = readAskHistory(path)
    expect(entry).toMatchObject({ conceived: true, question: '快没电了' })
    // 普通记录没有这个字段
    appendAskHistory(path, toHistoryEntry('普通问题', { kind: 'no-evidence', stats: { hits: 0, evidence: 0, cited: 0, questionChars: 4 } }, 2_000, 'conv-2'))
    expect(readAskHistory(path).find((item) => item.question === '普通问题')?.conceived).toBeUndefined()
  })

  it('removeAskHistoryConversation 只删该会话，其他会话 / 文件顺序不变', () => {
    const path = tempFile()
    appendAskHistory(path, { ...entry(1_000, '旧一'), conversationId: 'conv-1' })
    appendAskHistory(path, { ...entry(2_000, '旧二'), conversationId: 'conv-2' })
    appendAskHistory(path, { ...entry(3_000, '旧三'), conversationId: 'conv-1' })
    expect(removeAskHistoryConversation(path, 'conv-1')).toBe(2)
    const list = readAskHistory(path)
    expect(list.map((item) => item.question)).toEqual(['旧二'])
    // 再删一次：没有可删的
    expect(removeAskHistoryConversation(path, 'conv-1')).toBe(0)
  })
})
