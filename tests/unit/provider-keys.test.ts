import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isValidKeyName,
  MAX_API_KEY_LENGTH,
  upsertEnvEntry,
  validateApiKey,
  writeEnvKey
} from '../../src/main/provider-keys'

describe('validateApiKey', () => {
  it('接受常见密钥并去掉首尾空白', () => {
    expect(validateApiKey('  sk-abc123  ')).toEqual({ ok: true, key: 'sk-abc123' })
    expect(validateApiKey('local-test')).toEqual({ ok: true, key: 'local-test' })
  })

  it('拒绝空值、空白 / 控制字符与超长输入', () => {
    expect(validateApiKey('')).toMatchObject({ ok: false })
    expect(validateApiKey('   ')).toMatchObject({ ok: false })
    expect(validateApiKey('sk-abc def')).toMatchObject({ ok: false })
    expect(validateApiKey('sk-abc\ndef')).toMatchObject({ ok: false })
    expect(validateApiKey('sk-abc\u0000def')).toMatchObject({ ok: false })
    expect(validateApiKey('a'.repeat(MAX_API_KEY_LENGTH + 1))).toMatchObject({ ok: false })
    expect(validateApiKey(123)).toMatchObject({ ok: false })
  })
})

describe('env 变量名与 .env 文本改写', () => {
  it('变量名只允许字母数字下划线且不以数字开头', () => {
    expect(isValidKeyName('DEEPSEEK_API_KEY')).toBe(true)
    expect(isValidKeyName('_local')).toBe(true)
    expect(isValidKeyName('1KEY')).toBe(false)
    expect(isValidKeyName('MY-KEY')).toBe(false)
    expect(isValidKeyName('KEY=1')).toBe(false)
  })

  it('追加到新文件内容末尾，带换行结尾', () => {
    expect(upsertEnvEntry('', 'MY_KEY', 'sk-1')).toBe('MY_KEY=sk-1\n')
  })

  it('原位替换已有行，保留注释与其它变量（含 export 写法）', () => {
    const content = ['# 手写注释', 'OTHER=1', 'export MY_KEY="old"', 'TAIL=2', ''].join('\n')
    expect(upsertEnvEntry(content, 'MY_KEY', 'sk-new')).toBe(
      ['# 手写注释', 'OTHER=1', 'MY_KEY=sk-new', 'TAIL=2', ''].join('\n')
    )
  })

  it('重复同名行只保留一条（旧值不能反过来覆盖新值）', () => {
    const content = 'MY_KEY=a\nMY_KEY=b\n'
    const next = upsertEnvEntry(content, 'MY_KEY', 'sk-c')
    expect(next).toBe('MY_KEY=sk-c\n')
    expect(next.match(/MY_KEY=/g)).toHaveLength(1)
  })

  it('非法变量名抛错', () => {
    expect(() => upsertEnvEntry('', 'BAD-NAME', 'x')).toThrow()
  })
})

describe('writeEnvKey', () => {
  it('创建目录并写入；保留既有变量后再次写入会更新同一行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-envkey-'))
    try {
      const file = join(dir, 'nested', '.env')
      writeEnvKey(file, 'DEEPSEEK_API_KEY', 'sk-first')
      expect(readFileSync(file, 'utf8')).toBe('DEEPSEEK_API_KEY=sk-first\n')

      writeFileSync(file, '# comment\nOTHER=keep\nDEEPSEEK_API_KEY=sk-first\n', 'utf8')
      writeEnvKey(file, 'DEEPSEEK_API_KEY', 'sk-second')
      expect(readFileSync(file, 'utf8')).toBe('# comment\nOTHER=keep\nDEEPSEEK_API_KEY=sk-second\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('变量名非法时拒绝写入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-envkey-'))
    try {
      expect(() => writeEnvKey(join(dir, '.env'), 'BAD NAME', 'sk-x')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
