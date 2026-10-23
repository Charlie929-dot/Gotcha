import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFile, parseEnvFile } from '../../src/understand/cloud/env-file'
import {
  DEFAULT_PROVIDER,
  normalizeBaseUrl,
  parseProvider,
  parseProviders,
  resolveFromSettings,
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
  const CUSTOM = {
    id: 'local',
    label: '本地网关',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'qwen',
    apiKeyEnv: 'LOCAL_KEY'
  }

  it('缺失 / 非法配置回退默认 DeepSeek 预设', () => {
    expect(parseProviders(null)).toEqual([{ ...DEFAULT_PROVIDER }])
    expect(parseProviders('{oops')).toEqual([{ ...DEFAULT_PROVIDER }])
    expect(parseProviders('{"active":"x"}')).toEqual([{ ...DEFAULT_PROVIDER }])
    expect(parseProviders('[]')).toEqual([{ ...DEFAULT_PROVIDER }])
    expect(parseProviders('[{"id":""}]')).toEqual([{ ...DEFAULT_PROVIDER }])
  })

  it('解析自定义 OpenAI 兼容供应商、去重并拒绝不安全 URL', () => {
    const providers = parseProviders(
      JSON.stringify([
        { ...DEFAULT_PROVIDER, baseUrl: 'https://api.deepseek.com/' },
        CUSTOM,
        { id: 'local', label: '重复', baseUrl: 'https://dup.example.com', model: 'dup', apiKeyEnv: 'DUP' },
        { id: 'bad-proto', label: 'FTP', baseUrl: 'ftp://nope', model: 'x', apiKeyEnv: 'X' },
        { id: 'bad-http', label: '明文远程', baseUrl: 'http://evil.example.com', model: 'x', apiKeyEnv: 'X' },
        { id: 'bad-cred', label: 'URL 带凭据', baseUrl: 'https://user:pass@example.com', model: 'x', apiKeyEnv: 'X' }
      ])
    )
    expect(providers.map((p) => p.id)).toEqual(['deepseek', 'local'])
    // 末尾斜杠被规范化掉，避免拼出 //chat/completions
    expect(providers[0].baseUrl).toBe('https://api.deepseek.com')
    expect(providers[1].baseUrl).toBe('http://127.0.0.1:8000/v1')
  })

  it('normalizeBaseUrl：https 任意主机；http 仅本机；拒绝凭据 / query / fragment', () => {
    expect(normalizeBaseUrl('https://gateway.example.com/v1/')).toBe('https://gateway.example.com/v1')
    expect(normalizeBaseUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000')
    expect(normalizeBaseUrl('http://[::1]:8000')).toBe('http://[::1]:8000')
    expect(normalizeBaseUrl('http://evil.example.com')).toBeNull()
    expect(normalizeBaseUrl('https://user:pass@example.com')).toBeNull()
    expect(normalizeBaseUrl('https://example.com/v1?token=x')).toBeNull()
    expect(normalizeBaseUrl('https://example.com/v1#frag')).toBeNull()
    expect(normalizeBaseUrl('not-a-url')).toBeNull()
  })

  it('parseProvider 拒绝空字段 / 非对象', () => {
    expect(parseProvider(null)).toBeNull()
    expect(parseProvider({ id: 'a', label: 'A', baseUrl: 'not-a-url', model: 'm', apiKeyEnv: 'K' })).toBeNull()
    expect(
      parseProvider({ id: 'a', label: 'A', baseUrl: 'https://a.example.com', model: '', apiKeyEnv: 'K' })
    ).toBeNull()
  })

  it('密钥优先取进程环境，其次 .env；空环境变量不遮蔽 .env', () => {
    const providers = parseProviders(JSON.stringify([DEFAULT_PROVIDER]))
    expect(
      resolveLlmProvider('deepseek', providers, { DEEPSEEK_API_KEY: 'from-env' }, { DEEPSEEK_API_KEY: 'from-file' })
    ).toMatchObject({ ok: true, apiKey: 'from-env' })
    expect(resolveLlmProvider('deepseek', providers, {}, { DEEPSEEK_API_KEY: 'from-file' })).toMatchObject({
      ok: true,
      apiKey: 'from-file'
    })
    // `FOO=` 在 shell / CI 里常见，视同未设置；不能遮蔽 .env 里的有效密钥
    expect(
      resolveLlmProvider('deepseek', providers, { DEEPSEEK_API_KEY: '' }, { DEEPSEEK_API_KEY: 'from-file' })
    ).toMatchObject({ ok: true, apiKey: 'from-file' })
    expect(resolveLlmProvider('deepseek', providers, {}, {})).toEqual({
      ok: false,
      reason: 'missing-key',
      providerId: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY'
    })
    expect(resolveLlmProvider('nope', providers, {}, {})).toEqual({
      ok: false,
      reason: 'unknown-provider',
      providerId: 'nope'
    })
  })

  it('active 缺省时优先 DeepSeek，否则取第一个', () => {
    const onlyCustom = parseProviders(JSON.stringify([CUSTOM]))
    expect(resolveLlmProvider(null, onlyCustom, {}, {})).toMatchObject({
      ok: false,
      reason: 'missing-key',
      providerId: 'local'
    })
    const withDefault = parseProviders(JSON.stringify([CUSTOM, DEFAULT_PROVIDER]))
    expect(resolveLlmProvider(undefined, withDefault, { DEEPSEEK_API_KEY: 'k' }, {})).toMatchObject({
      ok: true,
      provider: { id: 'deepseek' }
    })
  })

  it('resolveFromSettings 读取 llm.active_provider + llm.providers 两键契约', () => {
    expect(
      resolveFromSettings(
        { active: 'local', providers: JSON.stringify([DEFAULT_PROVIDER, CUSTOM]) },
        { LOCAL_KEY: 'local-key' },
        {}
      )
    ).toMatchObject({ ok: true, provider: { id: 'local' }, apiKey: 'local-key' })

    expect(resolveFromSettings({ active: null, providers: null }, {}, {})).toEqual({
      ok: false,
      reason: 'missing-key',
      providerId: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY'
    })
  })
})
