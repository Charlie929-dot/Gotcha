/**
 * 个人记忆 · 性格架构（persona）
 *
 * 重点：人设可改，红线删不掉；用户追加的红线有数量上限（配置不能把 prompt 撑爆）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, type Db } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import {
  buildPersonaPrompt,
  listPersonaCards,
  PERSONA_CARD_MAX_CHARS,
  PERSONA_HARD_RED_LINES,
  parseRedLines,
  personaCardDir,
  readPersona,
  readPersonaCard,
  resolveVaultDir,
  sanitizePersonaCardName,
  savePersona,
  savePersonaCard
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
    expect(persona.name).toBe('贴心大肥鱼')
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

  it('prompt 只给事实：名字、口吻、逐条红线（编号从 1 开始）', () => {
    const prompt = buildPersonaPrompt(readPersona(db))
    expect(prompt).toContain('贴心大肥鱼')
    expect(prompt).toContain('你说话的样子')
    expect(prompt).toContain('1) ')
    expect(prompt).toContain('3) ')
  })

  it('prompt 不写「你是谁」的宣言（D61：独立靠处境长出来，不直接告诉它）', () => {
    const prompt = buildPersonaPrompt(readPersona(db))
    for (const slogan of ['不是助理', '不是检索工具', '有自己的记忆', '脾气']) {
      expect(prompt).not.toContain(slogan)
    }
  })

  it('parseRedLines：空串 / 全空白 → 没有追加', () => {
    expect(parseRedLines('')).toEqual([])
    expect(parseRedLines('  |  | ')).toEqual([])
  })
})

describe('人格卡（D62）', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'gotcha-persona-card-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('卡名归一：去 .md、挡路径分隔符与非法字符、限长', () => {
    expect(sanitizePersonaCardName('  女儿版.md ')).toBe('女儿版')
    expect(sanitizePersonaCardName('a/b')).toBeNull()
    expect(sanitizePersonaCardName('..')).toBeNull()
    expect(sanitizePersonaCardName('.hidden')).toBeNull()
    expect(sanitizePersonaCardName('x'.repeat(41))).toBeNull()
  })

  it('存 → 列 → 读：标题取第一行 #，字数如实', () => {
    const saved = savePersonaCard(userData, '女儿版', '# 鲸鱼娘\n\n我是小鲸鱼。')
    expect(saved).toEqual({ ok: true, name: '女儿版.md' })
    const cards = listPersonaCards(userData)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ name: '女儿版.md', title: '鲸鱼娘' })
    expect(readPersonaCard(userData, '女儿版.md')).toContain('我是小鲸鱼')
  })

  it('空卡 / 超长卡直接报错（不静默截断）', () => {
    expect(savePersonaCard(userData, '空', '   ')).toMatchObject({ ok: false })
    const tooLong = savePersonaCard(userData, '长', '好'.repeat(PERSONA_CARD_MAX_CHARS + 1))
    expect(tooLong).toMatchObject({ ok: false, error: expect.stringContaining(String(PERSONA_CARD_MAX_CHARS)) })
    expect(listPersonaCards(userData)).toHaveLength(0)
  })

  it('启用的卡：全文进 prompt，名字 / 口吻让位，红线仍压在最上面', () => {
    savePersonaCard(userData, '女儿版', '# 鲸鱼娘\n\n我是爸爸的小鲸鱼。')
    setSetting(db, 'memory.persona_card', '女儿版.md')
    const persona = readPersona(db, { userDataDir: userData })
    expect(persona.card?.text).toContain('爸爸的小鲸鱼')
    const prompt = buildPersonaPrompt(persona)
    expect(prompt).toContain('我是爸爸的小鲸鱼')
    expect(prompt).not.toContain('你叫「贴心大肥鱼」')
    expect(prompt).not.toContain('你说话的样子')
    expect(prompt).toContain('和上面的设定冲突时以这里为准')
    for (const line of PERSONA_HARD_RED_LINES) expect(prompt).toContain(line)
    // 三条红线仍在最后
    expect(prompt.trimEnd().endsWith('3) ' + PERSONA_HARD_RED_LINES[2])).toBe(true)
  })

  it('设置里指向的卡被删了：回落到名字 / 口吻，不炸', () => {
    setSetting(db, 'memory.persona_card', 'gone.md')
    const persona = readPersona(db, { userDataDir: userData })
    expect(persona.card).toBeNull()
    expect(buildPersonaPrompt(persona)).toContain('你叫「贴心大肥鱼」')
  })

  it('目录里有坏文件：列表跳过，不影响其它卡', () => {
    mkdirSync(personaCardDir(userData), { recursive: true })
    writeFileSync(join(personaCardDir(userData), '好卡.md'), '# 好卡\n正文', 'utf8')
    expect(listPersonaCards(userData).map((card) => card.name)).toEqual(['好卡.md'])
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
