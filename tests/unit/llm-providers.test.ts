import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFile, parseEnvFile } from '../../src/understand/cloud/env-file'
import {
  DEFAULT_PROVIDERS_CONFIG,
  parseProvider,
  parseProvidersConfig,
  resolveLlmProvider
} from '../../src/understand/cloud/providers'

describe('parseEnvFile', () => {
  it('支持注释、空行、export 前缀、单双引号与 CRLF', () => {
    const env = parseEnvFile(
      [
        '# comment',
        '',
        'DEEPSEEK_API_KEY=sk-1',
        'export QUOTED="a b c"',
        "SINGLE='x=y'",
        'EMPTY=',
        'INVALID LINE',
        '=nokey',
        'WITHSPACE= value '
      ].join('\r\n')
    )
    expect(env).toEqual({
      DEEPSEEK_API_KEY: 'sk-1',
      QUOTED: 'a b c',
      SINGLE: 'x=y',
      EMPTY: '',
      WITHSPACE: 'value'
    })
    expect(env['INVALID LINE']).toBeUndefined()
  })

  it('loadEnvFile 读取临时文件；文件不存在返回空对象', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-env-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, 'MY_KEY=abc\n', 'utf8')
      expect(loadEnvFile(file)).toEqual({ MY_KEY: 'abc' })
      expect(loadEnvFile(join(dir, 'missing.env'))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('providers · 多供应商配置（D21）', () => {
  it('缺失 / 非法配置回退默认 DeepSeek 预设', () => {
    expect(parseProvidersConfig(null)).toEqual(DEFAULT_PROVIDERS_CONFIG)
    expect(parseProvidersConfig('{oops')).toEqual(DEFAULT_PROVIDERS_CONFIG)
    expect(parseProvidersConfig('{"active":"x","providers":[]}')).toEqual(DEFAULT_PROVIDERS_CONFIG)
    expect(parseProvidersConfig('{"providers":[{"id":""}]}')).toEqual(DEFAULT_PROVIDERS_CONFIG)
  })

  it('解析自定义 OpenAI 兼容供应商、去重并保留 active', () => {
    const config = parseProvidersConfig(
      JSON.stringify({
        active: 'local',
        providers: [
          { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
          { id: 'local', label: '本地网关', baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen', apiKeyEnv: 'LOCAL_KEY' },
          { id: 'local', label: '重复', baseUrl: 'https://dup.example.com', model: 'dup', apiKeyEnv: 'DUP' },
          { id: 'bad', label: '非法', baseUrl: 'ftp://nope', model: 'x', apiKeyEnv: 'X' }
        ]
      })
    )
    expect(config.active).toBe('local')
    expect(config.providers.map((p) => p.id)).toEqual(['deepseek', 'local'])
    // baseUrl 末尾斜杠被规范化掉，避免拼出 //chat/completions
    expect(config.providers[0].baseUrl).toBe('https://api.deepseek.com')
    expect(config.providers[1].baseUrl).toBe('http://127.0.0.1:8000/v1')
  })

  it('active 缺省时取第一个供应商', () => {
    const config = parseProvidersConfig(
      JSON.stringify({ providers: [{ id: 'a', label: 'A', baseUrl: 'https://a.example.com', model: 'm', apiKeyEnv: 'A_KEY' }] })
    )
    expect(config.active).toBe('a')
  })

  it('密钥优先取进程环境，其次 .env；缺失 / 未知供应商给出原因', () => {
    const config = parseProvidersConfig(
      JSON.stringify({
        active: 'deepseek',
        providers: [
          { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' }
        ]
      })
    )
    expect(resolveLlmProvider(config, { DEEPSEEK_API_KEY: 'from-env' }, { DEEPSEEK_API_KEY: 'from-file' })).toMatchObject({
      ok: true,
      apiKey: 'from-env'
    })
    expect(resolveLlmProvider(config, {}, { DEEPSEEK_API_KEY: 'from-file' })).toMatchObject({
      ok: true,
      apiKey: 'from-file'
    })
    expect(resolveLlmProvider(config, {}, {})).toEqual({
      ok: false,
      reason: 'missing-key',
      providerId: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY'
    })
    expect(resolveLlmProvider({ active: 'nope', providers: config.providers }, {}, {})).toEqual({
      ok: false,
      reason: 'unknown-provider',
      providerId: 'nope'
    })
  })

  it('parseProvider 拒绝非法 URL / 空字段', () => {
    expect(parseProvider(null)).toBeNull()
    expect(parseProvider({ id: 'a', label: 'A', baseUrl: 'not-a-url', model: 'm', apiKeyEnv: 'K' })).toBeNull()
    expect(parseProvider({ id: 'a', label: 'A', baseUrl: 'https://a.example.com', model: '', apiKeyEnv: 'K' })).toBeNull()
  })
})
