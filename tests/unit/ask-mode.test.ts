/**
 * 问记忆 · 模式与工具目录（D72「分支即模式」）
 *
 * 守四件事：
 * 1. 两档的名字 / 别名（ask = 纯模型，chat = 带 persona；mem / 问记忆 落到 chat）；
 * 2. 分支 kind ↔ 模式档位；只有 chat 注入「此刻 / 想到的」；
 * 3. 工具目录：集合 / 元素 / 说明齐全，`/tool` 的规范化丢掉不认识的名字；
 * 4. 默认工具：persona 全开（老行为），assistant 全关（纯模型）。
 */

import { describe, expect, it } from 'vitest'

import {
  ASK_MODE_LABELS,
  askModeKindFromName,
  askModeKindOfBranch,
  asksMemoryContext,
  modeSummary
} from '../../src/chain/agent/mode'
import {
  ASK_TOOL_DIARY_NAMES,
  ASK_TOOL_LABELS,
  ASK_TOOL_LETTER_NAMES,
  ASK_TOOL_NAMES,
  ASK_TOOL_SCREEN_NAMES,
  ASK_TOOL_SETS,
  askToolSetOf,
  defaultToolsForBranchKind,
  hasDiaryTools,
  hasLetterTools,
  hasScreenTools,
  isAskToolName,
  normalizeAskTools
} from '../../src/chain/agent/tool-catalog'

describe('/mode 的名称', () => {
  it('两档 + 中文名 + 旧别名', () => {
    expect(ASK_MODE_LABELS).toEqual({ ask: '纯模型', chat: '聊天' })
    expect(askModeKindFromName('ask')).toBe('ask')
    expect(askModeKindFromName('pure')).toBe('ask')
    expect(askModeKindFromName(' 纯模型 ')).toBe('ask')
    expect(askModeKindFromName('chat')).toBe('chat')
    expect(askModeKindFromName('聊天')).toBe('chat')
    // D62 的三个旧名字：mem / memory / 问记忆 都落到 chat（带 persona 的记忆模式）
    expect(askModeKindFromName('mem')).toBe('chat')
    expect(askModeKindFromName('MEMORY')).toBe('chat')
    expect(askModeKindFromName('问记忆')).toBe('chat')
    expect(askModeKindFromName('随便')).toBeNull()
  })
})

describe('分支 kind ↔ 模式', () => {
  it('assistant = ask，persona / life = chat', () => {
    expect(askModeKindOfBranch('assistant')).toBe('ask')
    expect(askModeKindOfBranch('persona')).toBe('chat')
    expect(askModeKindOfBranch('life')).toBe('chat')
  })

  it('只有 chat 带「此刻 / 想到的」开场', () => {
    expect(asksMemoryContext('chat')).toBe(true)
    expect(asksMemoryContext('ask')).toBe(false)
  })

  it('一行摘要带分支与工具数', () => {
    expect(
      modeSummary({ kind: 'ask', branch: 'assistant', tools: [] })
    ).toBe('纯模型（分支 ✨assistant · 无工具）')
    expect(
      modeSummary({ kind: 'chat', branch: 'default', tools: [...ASK_TOOL_SCREEN_NAMES] })
    ).toBe('聊天（分支 ✨default · 5 个工具）')
  })
})

describe('工具目录', () => {
  it('三个集合：屏幕记忆 5 个 / 日记 3 个 / 信 3 个，编号顺序固定', () => {
    expect(ASK_TOOL_SETS.map((set) => set.id)).toEqual(['screen', 'diary', 'letter'])
    expect(ASK_TOOL_SETS.map((set) => set.label)).toEqual(['屏幕记忆', '日记', '信'])
    expect(ASK_TOOL_SCREEN_NAMES).toEqual([
      'search_info',
      'get_freshness',
      'read_segment',
      'recall',
      'ask_history'
    ])
    expect(ASK_TOOL_DIARY_NAMES).toEqual(['recall_diary', 'read_diary', 'memory_profile'])
    expect(ASK_TOOL_LETTER_NAMES).toEqual(['write_letter', 'list_letter', 'read_letter'])
    expect(ASK_TOOL_NAMES).toHaveLength(11)
  })

  it('每个元素都有说明，且只属于一个集合', () => {
    for (const name of ASK_TOOL_NAMES) {
      expect(ASK_TOOL_LABELS[name]).toBeTruthy()
      expect(askToolSetOf(name)?.tools).toContain(name)
    }
    expect(askToolSetOf('give_birth')).toBeNull()
  })

  it('规范化：丢掉不认识的、去重、按目录顺序', () => {
    expect(normalizeAskTools(['memory_profile', 'nope', 'search_info', 'search_info'])).toEqual([
      'search_info',
      'memory_profile'
    ])
    expect(normalizeAskTools([])).toEqual([])
    expect(isAskToolName('read_diary')).toBe(true)
    expect(isAskToolName('give_birth')).toBe(false)
  })

  it('屏幕 / 日记 / 信判定按元素算，不按整个集合', () => {
    expect(hasScreenTools(['get_freshness'])).toBe(true)
    expect(hasScreenTools(['read_diary'])).toBe(false)
    expect(hasDiaryTools(['memory_profile'])).toBe(true)
    expect(hasDiaryTools(['search_info'])).toBe(false)
    expect(hasLetterTools(['read_letter'])).toBe(true)
    expect(hasLetterTools(['search_info'])).toBe(false)
  })

  it('默认值：persona / life 全开，assistant 全关', () => {
    expect(defaultToolsForBranchKind('persona')).toEqual([...ASK_TOOL_NAMES])
    expect(defaultToolsForBranchKind('life')).toEqual([...ASK_TOOL_NAMES])
    expect(defaultToolsForBranchKind('assistant')).toEqual([])
  })
})
