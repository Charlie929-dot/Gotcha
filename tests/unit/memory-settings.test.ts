/**
 * 个人记忆 · 设置（日记目录 + 人设）
 *
 * 重点：目录必须存在才让存；名字 / 口吻 / 红线有长度与条数上限；红线是「每行一条」，
 * 存库仍沿用 `|` 分隔；写死的三条永远在视图里。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, type Db } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import { PERSONA_HARD_RED_LINES } from '../../src/memory/persona'
import {
  applyMemoryPatch,
  buildMemorySettingsView,
  parseMemoryPatch
} from '../../src/main/memory-settings'

let db: Db
let dir: string

beforeEach(() => {
  db = openDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'gotcha-memory-settings-'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('parseMemoryPatch', () => {
  it('非对象 / 空对象都拒绝', () => {
    expect(parseMemoryPatch(null)).toEqual({ ok: false, error: '参数不合法' })
    expect(parseMemoryPatch([])).toEqual({ ok: false, error: '参数不合法' })
    expect(parseMemoryPatch({})).toEqual({ ok: false, error: '没有要保存的改动' })
  })

  it('目录：必须存在且是目录；空串 = 自动找；会 trim', () => {
    expect(parseMemoryPatch({ vaultDir: '   ' })).toEqual({ ok: true, patch: { vaultDir: '' } })
    expect(parseMemoryPatch({ vaultDir: join(tmpdir(), 'gotcha-no-such-dir-xyz') })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不存在')
    })
    const file = join(dir, 'note.md')
    writeFileSync(file, '# 不是目录')
    expect(parseMemoryPatch({ vaultDir: file })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不是一个目录')
    })
    expect(parseMemoryPatch({ vaultDir: `  ${dir}  ` })).toEqual({
      ok: true,
      patch: { vaultDir: dir }
    })
  })

  it('名字 / 口吻有长度上限', () => {
    expect(parseMemoryPatch({ personaName: 'x'.repeat(21) })).toMatchObject({ ok: false })
    expect(parseMemoryPatch({ personaTone: 'x'.repeat(121) })).toMatchObject({ ok: false })
    expect(parseMemoryPatch({ personaName: '  小记  ', personaTone: ' 只说事实 ' })).toEqual({
      ok: true,
      patch: { personaName: '小记', personaTone: '只说事实' }
    })
  })

  it('红线：空行跳过、去重、最多 8 条、单条 60 字', () => {
    expect(
      parseMemoryPatch({ redLines: ['  别提成绩 ', '', '别提成绩', '别用感叹号'] })
    ).toEqual({ ok: true, patch: { redLines: ['别提成绩', '别用感叹号'] } })
    expect(
      parseMemoryPatch({ redLines: Array.from({ length: 9 }, (_, index) => `红线${index}`) })
    ).toMatchObject({ ok: false, error: expect.stringContaining('最多 8 条') })
    expect(parseMemoryPatch({ redLines: ['x'.repeat(61)] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('60')
    })
    expect(parseMemoryPatch({ redLines: ['ok', 42] })).toMatchObject({ ok: false })
  })
})

describe('applyMemoryPatch + buildMemorySettingsView', () => {
  it('保存目录与人设后视图反映；写死的红线永远在', () => {
    applyMemoryPatch(db, {
      vaultDir: dir,
      personaName: '小记',
      personaTone: '只说事实',
      redLines: ['别提成绩', '别用感叹号']
    })
    const view = buildMemorySettingsView(db)
    expect(view.vaultDir).toBe(dir)
    expect(view.resolvedDir).toBe(dir)
    expect(view.dirSource).toBe('setting')
    expect(view.personaName).toBe('小记')
    expect(view.personaTone).toBe('只说事实')
    expect(view.redLines).toEqual(['别提成绩', '别用感叹号'])
    expect(view.hardRedLines).toEqual([...PERSONA_HARD_RED_LINES])
    expect(view.stats.items).toBe(0)
  })

  it('只改人设不动目录；名字清空回落到默认', () => {
    setSetting(db, 'memory.vault_dir', dir)
    applyMemoryPatch(db, { personaName: '小记' })
    expect(buildMemorySettingsView(db).vaultDir).toBe(dir)
    applyMemoryPatch(db, { personaName: '' })
    expect(buildMemorySettingsView(db).personaName).toBe('记忆球')
  })

  it('环境变量优先于设置里的目录（source 如实上报）', () => {
    const saved = process.env.GOTCHA_MEMORY_VAULT
    const envDir = mkdtempSync(join(tmpdir(), 'gotcha-memory-env-'))
    try {
      setSetting(db, 'memory.vault_dir', dir)
      process.env.GOTCHA_MEMORY_VAULT = envDir
      const view = buildMemorySettingsView(db)
      expect(view.dirSource).toBe('env')
      expect(view.resolvedDir).toBe(envDir)
      // 设置里的原值仍原样回显（用户看得到自己填过什么）
      expect(view.vaultDir).toBe(dir)
    } finally {
      if (saved === undefined) delete process.env.GOTCHA_MEMORY_VAULT
      else process.env.GOTCHA_MEMORY_VAULT = saved
      rmSync(envDir, { recursive: true, force: true })
    }
  })

  it('设置里存了一个已不存在的目录：resolvedDir 回落，但原值仍回显', () => {
    setSetting(db, 'memory.vault_dir', join(tmpdir(), 'gotcha-vault-gone-xyz'))
    const view = buildMemorySettingsView(db)
    expect(view.vaultDir).toContain('gotcha-vault-gone-xyz')
    expect(view.resolvedDir).not.toBe(view.vaultDir)
  })
})
