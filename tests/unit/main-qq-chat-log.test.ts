/**
 * QQ 聊天台账（D96 / PR1）
 *
 * 守五件事：短号单调递增且跨重启不变、QQ id ↔ 短号映射、500 条淘汰、
 * 会话数上限、坏文件按空台账启动（不删用户文件）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ChatLog, QQ_CHAT_TEXT_MAX_CHARS } from '../../src/main/qq/chat-log'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-qq-log-'))
  dirs.push(dir)
  return join(dir, 'qq', 'chat-log.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('短号与映射', () => {
  it('seq 从 1 开始、单调递增；QQ id ↔ 短号双向可查；recent 从旧到新', () => {
    const file = tempFile()
    const log = new ChatLog({ file, flushDelayMs: 0 })
    const a = log.append('qq-1', { qqId: 1001, role: 'user', text: '第一句', at: 1_700_000_000_000 })
    const b = log.append('qq-1', { qqId: 1002, role: 'ta', text: '第二句', at: 1_700_000_010_000 })
    expect([a.seq, b.seq]).toEqual([1, 2])
    expect(log.byQqId('qq-1', 1001)?.seq).toBe(1)
    expect(log.bySeq('qq-1', 2)?.text).toBe('第二句')
    expect(log.recent('qq-1', 2).map((record) => record.seq)).toEqual([1, 2])
    expect(log.recentSeqs('qq-1', 2)).toEqual([1, 2])
    log.dispose()
  })

  it('不同会话各自编号、互不串（引用只在本人聊天里有效）', () => {
    const file = tempFile()
    const log = new ChatLog({ file, flushDelayMs: 0 })
    expect(log.append('qq-1', { qqId: 11, role: 'user', text: 'a', at: 1 }).seq).toBe(1)
    expect(log.append('qq-2', { qqId: 22, role: 'user', text: 'b', at: 2 }).seq).toBe(1)
    expect(log.bySeq('qq-2', 1)?.qqId).toBe(22)
    log.dispose()
  })

  it('重启后短号与 nextSeq 不变（引用旧消息靠它）', () => {
    const file = tempFile()
    const first = new ChatLog({ file, flushDelayMs: 0 })
    first.append('qq-1', { qqId: 1001, role: 'user', text: '重启前的话', at: 1_700_000_000_000 })
    first.append('qq-1', { qqId: 1002, role: 'ta', text: '重启前的回答', at: 1_700_000_010_000 })
    first.dispose()

    const second = new ChatLog({ file, flushDelayMs: 0 })
    expect(second.bySeq('qq-1', 2)?.text).toBe('重启前的回答')
    expect(second.append('qq-1', { qqId: 1003, role: 'user', text: '重启后', at: 1_700_000_020_000 }).seq).toBe(3)
    second.dispose()
  })

  it('正文归一：换行压平、最多 500 字；图片只存张数', () => {
    const file = tempFile()
    const log = new ChatLog({ file, flushDelayMs: 0 })
    const long = '字'.repeat(QQ_CHAT_TEXT_MAX_CHARS + 30)
    const record = log.append('qq-1', {
      qqId: 1,
      role: 'user',
      text: `  第一行\r\n第二行  ${long}`,
      at: 5,
      imageCount: 2
    })
    expect(record.text.startsWith('第一行\n第二行')).toBe(true)
    expect(Array.from(record.text).length).toBe(QQ_CHAT_TEXT_MAX_CHARS)
    expect(record.imageCount).toBe(2)
    log.dispose()
  })
})

describe('上限与淘汰', () => {
  it('每个会话最多 500 条，超出丢最旧（短号不复用）', () => {
    const file = tempFile()
    // 用默认合并写盘（500ms）：500 次同步写盘会把单测拖到超时
    const log = new ChatLog({ file })
    for (let i = 1; i <= 505; i += 1) {
      log.append('qq-1', { qqId: i, role: 'user', text: `第 ${i} 句`, at: i })
    }
    expect(log.recent('qq-1', 1000)).toHaveLength(500)
    expect(log.bySeq('qq-1', 5)).toBeNull()
    expect(log.bySeq('qq-1', 6)?.qqId).toBe(6)
    expect(log.append('qq-1', { qqId: 506, role: 'user', text: '新', at: 506 }).seq).toBe(506)
    log.dispose()
  })

  it('最多保留 20 个会话，新会话挤掉最久没动静的那个', () => {
    const file = tempFile()
    const log = new ChatLog({ file, flushDelayMs: 0 })
    for (let i = 0; i < 20; i += 1) {
      log.append(`qq-${i}`, { qqId: i + 1, role: 'user', text: `会话 ${i}`, at: i + 1 })
    }
    log.append('qq-new', { qqId: 99, role: 'user', text: '新会话', at: 100 })
    expect(log.recent('qq-0', 1)).toEqual([])
    expect(log.recent('qq-19', 1)).toHaveLength(1)
    expect(log.recent('qq-new', 1)).toHaveLength(1)
    log.dispose()
  })
})

describe('坏文件降级', () => {
  it('不是 JSON：按空台账启动，记一条 warn，不删用户文件', () => {
    const file = tempFile()
    const warnings: string[] = []
    const raw = 'not-json{{{'
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, raw, 'utf8')

    const second = new ChatLog({
      file,
      flushDelayMs: 0,
      log: (level, message) => {
        if (level === 'warn') warnings.push(message)
      }
    })
    expect(second.recent('qq-1', 6)).toEqual([])
    expect(second.append('qq-1', { qqId: 1, role: 'user', text: 'x', at: 1 }).seq).toBe(1)
    expect(warnings.some((message) => message.includes('corrupt'))).toBe(true)
    second.dispose()
    // 原坏文件被新内容覆盖（rename），但没被主动删除
    expect(readFileSync(file, 'utf8')).toContain('"version":1')
  })

  it('版本不认识：按空台账启动', () => {
    const file = tempFile()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 99, conversations: {} }), 'utf8')
    const warnings: string[] = []
    const log = new ChatLog({
      file,
      flushDelayMs: 0,
      log: (level, message) => {
        if (level === 'warn') warnings.push(message)
      }
    })
    expect(log.recent('qq-1', 6)).toEqual([])
    expect(warnings.some((message) => message.includes('version'))).toBe(true)
    log.dispose()
  })
})
