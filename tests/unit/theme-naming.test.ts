import { describe, expect, it } from 'vitest'
import { LLM_DEFAULTS } from '../../src/understand/cloud/constants'
import {
  FakeLlmClient,
  LlmAbortError,
  LlmHttpError
} from '../../src/understand/cloud/llm-client'
import type { RedactableMoment } from '../../src/understand/cloud/redact'
import {
  fallbackThemeName,
  nameTheme,
  validateThemeName
} from '../../src/understand/theme-naming'

function moment(overrides: Partial<RedactableMoment> = {}): RedactableMoment {
  return {
    app: 'chrome.exe',
    title: 'Rust 生命周期',
    startTs: 1_700_000_000_000,
    endTs: 1_700_000_060_000,
    ocr: 'rust 学习笔记',
    eventIds: [1, 2],
    ...overrides
  }
}

describe('validateThemeName · 命名输出校验', () => {
  it('合法输出原样收下；超长标题 / 摘要确定性截断并补省略号', () => {
    const ok = validateThemeName({ title: 'Rust 学习', summary: '生命周期与借用检查', type: 'knowledge' })
    expect(ok).toEqual({
      ok: true,
      name: { title: 'Rust 学习', summary: '生命周期与借用检查', type: 'knowledge' }
    })

    const long = validateThemeName({
      title: '标'.repeat(LLM_DEFAULTS.nodeTitleHardMaxChars + 10),
      summary: '文'.repeat(LLM_DEFAULTS.nodeSummaryHardMaxChars + 10),
      type: 'activity'
    })
    expect(long.ok).toBe(true)
    if (!long.ok) return
    expect(long.name.title).toHaveLength(LLM_DEFAULTS.nodeTitleHardMaxChars)
    expect(long.name.title.endsWith('…')).toBe(true)
    expect(long.name.summary).toHaveLength(LLM_DEFAULTS.nodeSummaryHardMaxChars)
  })

  it('未知字段忽略（多写一个无害字段不值得丢掉一次成功的命名）', () => {
    const result = validateThemeName({
      title: '标题',
      summary: '摘要',
      type: 'knowledge',
      event_ids: [1, 2]
    })
    expect(result.ok).toBe(true)
  })

  it('缺字段 / type 非法判失败，文案只含字段名（不含正文）', () => {
    const noTitle = validateThemeName({ summary: '机密正文', type: 'knowledge' })
    expect(noTitle.ok).toBe(false)
    if (!noTitle.ok) {
      expect(noTitle.errors.join('；')).toContain('title')
      expect(noTitle.errors.join('；')).not.toContain('机密正文')
    }

    const badType = validateThemeName({ title: '标题', summary: '摘要', type: 'other' })
    expect(badType.ok).toBe(false)
    if (!badType.ok) expect(badType.errors.join('；')).toContain('type')
  })
})

describe('fallbackThemeName · 本地兜底命名', () => {
  it('用代表时刻的窗口标题；空标题退到 app；再空退到固定文案', () => {
    expect(fallbackThemeName([moment({ title: '  搜索结果  ' })]).title).toBe('搜索结果')
    expect(fallbackThemeName([moment({ title: '   ' })]).title).toBe('chrome.exe')
    expect(fallbackThemeName([moment({ title: '', app: '' })]).title).toBe('未命名主题')
  })

  it('摘要明说本地兜底，不冒充模型命名', () => {
    const name = fallbackThemeName([moment()])
    expect(name.summary).toContain('本地兜底命名')
    expect(name.type).toBe('activity')
  })
})

describe('nameTheme · 失败不阻塞（S4）', () => {
  it('模型给出合法命名：直接用，并报告 usage', async () => {
    const client = new FakeLlmClient([
      { json: { title: 'Rust 学习', summary: '生命周期笔记', type: 'knowledge' }, usage: { promptTokens: 30, completionTokens: 8 } }
    ])
    const outcome = await nameTheme(client, [moment()])

    expect(outcome.source).toBe('llm')
    expect(outcome.name).toEqual({ title: 'Rust 学习', summary: '生命周期笔记', type: 'knowledge' })
    expect(outcome.usage).toEqual({ promptTokens: 30, completionTokens: 8 })
    expect(client.namingRequests).toHaveLength(1)
    // 载荷走脱敏出口：只含时刻字段，没有多余内容
    expect(Object.keys(client.namingRequests[0].moments[0]).sort()).toEqual(
      ['app', 'eventIds', 'ocr', 'title', 'ts', 'tsEnd'].sort()
    )
  })

  it('载荷里的敏感串已剥离（命名请求不例外）', async () => {
    const client = new FakeLlmClient([
      { json: { title: '邮件', summary: '账号', type: 'knowledge' } }
    ])
    await nameTheme(client, [moment({ title: 'alice@example.com 的邮件' })])
    const serialized = JSON.stringify(client.namingRequests[0])
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).toContain('[已脱敏]')
  })

  it('输出不合法：用本地兜底标题，主题照建（reason=invalid-output）', async () => {
    const client = new FakeLlmClient([{ json: { summary: '缺标题', type: 'knowledge' } }])
    const outcome = await nameTheme(client, [moment()])

    expect(outcome.source).toBe('fallback')
    expect(outcome.reason).toBe('invalid-output')
    expect(outcome.name.title).toBe('Rust 生命周期')
  })

  it('请求失败（HTTP 错误）：不抛错，兜底（reason=llm-error）', async () => {
    const client = new FakeLlmClient([new LlmHttpError(500)])
    const outcome = await nameTheme(client, [moment()])

    expect(outcome.source).toBe('fallback')
    expect(outcome.reason).toBe('llm-error')
    expect(outcome.name.title).toBe('Rust 生命周期')
  })

  it('未配置客户端（D24 门 / 缺 key）：零请求直接兜底', async () => {
    const outcome = await nameTheme(null, [moment()])
    expect(outcome.source).toBe('fallback')
    expect(outcome.reason).toBe('no-client')
  })

  it('候选时刻全被敏感规则剔掉：不发空载荷，直接兜底（no-context）', async () => {
    const client = new FakeLlmClient([])
    const outcome = await nameTheme(client, [moment({ title: '密码库', app: 'vault.exe' })])

    expect(outcome.source).toBe('fallback')
    expect(outcome.reason).toBe('no-context')
    expect(outcome.blockedEventIds).toEqual([1, 2])
    expect(client.namingRequests).toHaveLength(0)
  })

  it('暂停取消必须外抛 LlmAbortError（不能被兜底吞掉）', async () => {
    const aborter = new AbortController()
    aborter.abort()
    const client = new FakeLlmClient([{ json: { title: 't', summary: 's', type: 'knowledge' } }])
    await expect(nameTheme(client, [moment()], { signal: aborter.signal })).rejects.toBeInstanceOf(
      LlmAbortError
    )
  })
})
