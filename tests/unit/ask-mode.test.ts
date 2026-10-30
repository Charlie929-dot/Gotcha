/**
 * 问记忆 · 模式（D62）
 *
 * 三个预设只是起点：屏幕记忆 / 日记 / 人格卡是三个独立开关。
 * 这里守三件事：
 * 1. 预设的值就是拍板人说的组合；
 * 2. 渲染层 / 持久化来的脏值不炸，缺字段按关处理（不静默升级成「全开」）；
 * 3. 无工具模式真的没有工具（单轮请求的前提）。
 */

import { describe, expect, it } from 'vitest'

import {
  ASK_MODE_LABELS,
  ASK_MODE_PRESET_ORDER,
  ASK_MODE_PRESETS,
  askModePresetFromName,
  askModePresetOf,
  askToolGroupsOf,
  asksMemoryContext,
  DEFAULT_ASK_MODE,
  hasAskTools,
  normalizeAskMode
} from '../../src/chain/agent/mode'

describe('模式预设', () => {
  it('问记忆 = 屏幕 + 日记；聊天 = 日记 + 卡；提问 = 全关', () => {
    expect(ASK_MODE_PRESETS.memory).toEqual({ screen: true, diary: true, card: false })
    expect(ASK_MODE_PRESETS.chat).toEqual({ screen: false, diary: true, card: true })
    expect(ASK_MODE_PRESETS.plain).toEqual({ screen: false, diary: false, card: false })
    expect(ASK_MODE_PRESET_ORDER).toEqual(['memory', 'chat', 'plain'])
  })

  it('默认是问记忆（老调用方不传模式时行为不变）', () => {
    expect(DEFAULT_ASK_MODE).toEqual(ASK_MODE_PRESETS.memory)
  })

  it('组合与预设的对应：完全一致才算某个预设', () => {
    expect(askModePresetOf({ screen: true, diary: true, card: false })).toBe('memory')
    expect(askModePresetOf({ screen: false, diary: true, card: true })).toBe('chat')
    expect(askModePresetOf({ screen: true, diary: false, card: true })).toBeNull()
  })

  it('/mode 的别名：mem / chat / ask，另收 memory / plain / 中文名', () => {
    expect(askModePresetFromName('mem')).toBe('memory')
    expect(askModePresetFromName('MEMORY')).toBe('memory')
    expect(askModePresetFromName(' 问记忆 ')).toBe('memory')
    expect(askModePresetFromName('chat')).toBe('chat')
    expect(askModePresetFromName('聊天')).toBe('chat')
    expect(askModePresetFromName('ask')).toBe('plain')
    expect(askModePresetFromName('plain')).toBe('plain')
    expect(askModePresetFromName('提问')).toBe('plain')
    expect(askModePresetFromName('随便')).toBeNull()
    expect(ASK_MODE_LABELS).toEqual({ memory: '问记忆', chat: '聊天', plain: '提问' })
  })
})

describe('normalizeAskMode', () => {
  it('不是对象 → 默认；对象里缺字段 → 关（不猜用户想开）', () => {
    expect(normalizeAskMode(undefined)).toEqual(ASK_MODE_PRESETS.memory)
    expect(normalizeAskMode('chat')).toEqual(ASK_MODE_PRESETS.memory)
    expect(normalizeAskMode({ card: true })).toEqual({ screen: false, diary: false, card: true })
    expect(normalizeAskMode({ screen: true, diary: false, card: true })).toEqual({
      screen: true,
      diary: false,
      card: true
    })
  })

  it('非布尔值一律按关处理', () => {
    expect(normalizeAskMode({ screen: 'yes', diary: 1, card: null })).toEqual({
      screen: false,
      diary: false,
      card: false
    })
  })
})

describe('工具组与上下文', () => {
  it('卡不影响工具组', () => {
    expect(askToolGroupsOf({ screen: true, diary: true, card: true })).toEqual({
      screen: true,
      diary: true
    })
    expect(hasAskTools({ screen: false, diary: false, card: true })).toBe(false)
    expect(hasAskTools({ screen: true, diary: false, card: false })).toBe(true)
  })

  it('纯提问不带「此刻 / 想到的」；有屏幕或卡才带', () => {
    expect(asksMemoryContext(ASK_MODE_PRESETS.plain)).toBe(false)
    expect(asksMemoryContext(ASK_MODE_PRESETS.memory)).toBe(true)
    expect(asksMemoryContext(ASK_MODE_PRESETS.chat)).toBe(true)
  })
})
