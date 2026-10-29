/**
 * 个人记忆 · 性格架构（persona）
 *
 * 重点：人设可改，红线删不掉；用户追加的红线有数量上限（配置不能把 prompt 撑爆）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, type Db } from '../../src/db'
import {
  buildPersonaPrompt,
  PERSONA_HARD_RED_LINES,
  parseRedLines,
  readPersona,
  resolveVaultDir,
  savePersona
} from '../../src/memory/persona'

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('persona', () => {
  it('默认：名字 / 口吻 / 三条写死的红线', () => {
    const persona = readPersona(db)
    expect(persona.name).toBe('记忆球')
    expect(persona.tone).toContain('朋友')
    expect(persona.redLines).toEqual([...PERSONA_HARD_RED_LINES])
  })

  it('可以改名字与口吻，但三条红线一条都不能少', () => {
    savePersona(db, { name: '小记', tone: '只说事实，不煽情' })
    const persona = readPersona(db)
    expect(persona.name).toBe('小记')
    expect(persona.tone).toBe('只说事实，不煽情')
    expect(persona.redLines.slice(0, 3)).toEqual([...PERSONA_HARD_RED_LINES])
  })

  it('追加红线：`|` 分隔、去空、最多 8 条；顺序在写死的三条之后', () => {
    savePersona(db, { redLines: ' 别提成绩 | 别用感叹号 ||别提成绩 ' })
    const persona = readPersona(db)
    expect(persona.redLines.slice(3)).toEqual(['别提成绩', '别用感叹号'])

    savePersona(db, { redLines: Array.from({ length: 12 }, (_, index) => `红线${index}`).join('|') })
    expect(readPersona(db).redLines).toHaveLength(3 + 8)
  })

  it('prompt 里带名字、口吻与逐条红线（编号从 1 开始）', () => {
    const prompt = buildPersonaPrompt(readPersona(db))
    expect(prompt).toContain('记忆球')
    expect(prompt).toContain('怎么说话')
    expect(prompt).toContain('1) ')
    expect(prompt).toContain('3) ')
  })

  it('parseRedLines：空串 / 全空白 → 没有追加', () => {
    expect(parseRedLines('')).toEqual([])
    expect(parseRedLines('  |  | ')).toEqual([])
  })
})

describe('resolveVaultDir', () => {
  const saved = process.env.GOTCHA_MEMORY_VAULT

  afterEach(() => {
    if (saved === undefined) delete process.env.GOTCHA_MEMORY_VAULT
    else process.env.GOTCHA_MEMORY_VAULT = saved
  })

  it('环境变量指向存在的目录时优先', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-vault-'))
    try {
      process.env.GOTCHA_MEMORY_VAULT = dir
      expect(resolveVaultDir(db)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('环境变量指向不存在的目录时忽略它（不返回坏路径）', () => {
    process.env.GOTCHA_MEMORY_VAULT = join(tmpdir(), 'gotcha-vault-does-not-exist-xyz')
    const resolved = resolveVaultDir(db)
    expect(resolved).not.toContain('does-not-exist-xyz')
  })
})
