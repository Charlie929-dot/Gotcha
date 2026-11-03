/**
 * 出生前「先落盘、再切分支」的重试（2026-11-03，D98 配套修）
 *
 * 2026-11-02 22:41 真机事故：兜底生女儿时工作区刚好有信 / 日记在写，
 * `switchBranch` 判 `dirty` → 整条出生失败，只留下 `{"reason":"birth"}`。
 * 这里锁住三个行为：脏就提交后重试、非脏不瞎重试、重试有上限。
 */

import { describe, expect, it, vi } from 'vitest'

import { switchFailureText, switchWhenClean } from '../../src/main/give-birth'

describe('switchWhenClean', () => {
  it('第一次 dirty：提交后再切一次，成功', async () => {
    const commit = vi.fn(async () => ({ committed: true }))
    const switchTo = vi
      .fn<() => Promise<{ ok: boolean; reason?: 'dirty' | 'unavailable' }>>()
      .mockResolvedValueOnce({ ok: false, reason: 'dirty' })
      .mockResolvedValueOnce({ ok: true })
    const result = await switchWhenClean({ commit, switchTo, message: 'memory: save', delayMs: 0 })
    expect(result.ok).toBe(true)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledWith('memory: save')
    expect(switchTo).toHaveBeenCalledTimes(2)
  })

  it('不是 dirty 就不重复切（重试也没用）', async () => {
    const commit = vi.fn(async () => ({ committed: false, reason: 'clean' as const }))
    const switchTo = vi.fn(async () => ({ ok: false, reason: 'unavailable' as const }))
    const result = await switchWhenClean({ commit, switchTo, message: 'memory: save', delayMs: 0 })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(switchTo).toHaveBeenCalledTimes(1)
  })

  it('一直 dirty：到 attempts 上限就停，不无限转', async () => {
    const commit = vi.fn(async () => ({ committed: true }))
    const switchTo = vi.fn(async () => ({ ok: false, reason: 'dirty' as const }))
    const result = await switchWhenClean({
      commit,
      switchTo,
      message: 'memory: save',
      attempts: 2,
      delayMs: 0
    })
    expect(result).toMatchObject({ ok: false, reason: 'dirty' })
    expect(commit).toHaveBeenCalledTimes(2)
    expect(switchTo).toHaveBeenCalledTimes(2)
  })

  it('提交抛错不阻断切换（提交失败也要尽量把这一次生出来）', async () => {
    const commit = vi.fn(async () => {
      throw new Error('index.lock')
    })
    const switchTo = vi.fn(async () => ({ ok: true }))
    const result = await switchWhenClean({ commit, switchTo, message: 'memory: save', delayMs: 0 })
    expect(result.ok).toBe(true)
  })
})

describe('switchFailureText', () => {
  it('dirty / unavailable / 未知都给中文原因', () => {
    expect(switchFailureText('dirty')).toContain('没提交')
    expect(switchFailureText('unavailable')).toContain('记忆仓')
    expect(switchFailureText(undefined)).toBe('仓库操作失败')
  })
})
