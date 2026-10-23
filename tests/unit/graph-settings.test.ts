import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db'
import { getSetting, setSetting } from '../../src/db/settings'
import {
  GRAPH_SETTING_KEYS,
  readGraphSettings,
  saveGraphSettings
} from '../../src/main/graph-settings'
import { DEFAULT_PROVIDER } from '../../src/understand/cloud/providers'

describe('readGraphSettings', () => {
  it('无库 / 空库返回默认值且不建库', () => {
    const defaults = readGraphSettings(null)
    expect(defaults).toMatchObject({
      auto: true,
      intervalMinutes: 10,
      budgetTokensPerDay: 1_000_000,
      retryBackoffMinutes: '1,5,15',
      batchMaxMoments: 20,
      maxTokens: 2_000,
      activeProvider: 'deepseek',
      providersInvalid: false,
      outboundConsent: false,
      usage: { calls: 0, promptTokens: 0, completionTokens: 0 }
    })
    expect(defaults.hotkeys).toEqual({ toggleCapture: 'Alt+P', openGraph: 'Alt+Space' })
    expect(defaults.providers).toEqual([DEFAULT_PROVIDER])

    const db = openDatabase(':memory:')
    expect(readGraphSettings(db)).toEqual(defaults)
    db.close()
  })

  it('读回已存设置；坏 providers JSON 标记 invalid 且不回退默认远端', () => {
    const db = openDatabase(':memory:')
    setSetting(db, GRAPH_SETTING_KEYS.auto, '0')
    setSetting(db, GRAPH_SETTING_KEYS.intervalMinutes, '15')
    setSetting(db, GRAPH_SETTING_KEYS.retryBackoffMinutes, '2,10')
    setSetting(db, GRAPH_SETTING_KEYS.providers, '{broken')
    setSetting(db, 'hotkey.toggle_capture', 'Ctrl+Shift+P')
    setSetting(db, GRAPH_SETTING_KEYS.outboundConsent, '1')

    const view = readGraphSettings(db)
    expect(view.auto).toBe(false)
    expect(view.intervalMinutes).toBe(15)
    expect(view.retryBackoffMinutes).toBe('2,10')
    expect(view.providersInvalid).toBe(true)
    expect(view.providers).toEqual([])
    expect(view.hotkeys).toEqual({ toggleCapture: 'Ctrl+Shift+P', openGraph: 'Alt+Space' })
    expect(view.outboundConsent).toBe(true)
    db.close()
  })
})

describe('saveGraphSettings', () => {
  it('保存归纳参数 / 供应商 / 热键 / 确认门，并读回一致', () => {
    const db = openDatabase(':memory:')
    const result = saveGraphSettings(db, {
      auto: false,
      intervalMinutes: 30,
      budgetTokensPerDay: 500_000,
      retryBackoffMinutes: [2, 10, 20],
      batchMaxMoments: 12,
      maxTokens: 3_000,
      providers: [
        { ...DEFAULT_PROVIDER, model: 'deepseek-chat' },
        {
          id: 'local',
          label: '本地网关',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'local-model',
          apiKeyEnv: 'LOCAL_LLM_KEY'
        }
      ],
      activeProvider: 'local',
      hotkeys: { toggleCapture: 'Ctrl+Shift+P', openGraph: 'Ctrl+Shift+G' },
      outboundConsent: true
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settings).toMatchObject({
      auto: false,
      intervalMinutes: 30,
      budgetTokensPerDay: 500_000,
      retryBackoffMinutes: '2,10,20',
      batchMaxMoments: 12,
      maxTokens: 3_000,
      activeProvider: 'local',
      outboundConsent: true
    })
    expect(result.settings.providers.map((provider) => provider.id)).toEqual([
      'deepseek',
      'local'
    ])
    expect(result.settings.hotkeys).toEqual({
      toggleCapture: 'Ctrl+Shift+P',
      openGraph: 'Ctrl+Shift+G'
    })
    // 密钥值不入库：只有 apiKeyEnv 名
    expect(getSetting(db, GRAPH_SETTING_KEYS.providers)).not.toContain('sk-')
    db.close()
  })

  it('拒绝未知字段 / 密钥字段 / 越界数字 / 非法热键 / 重复热键', () => {
    const db = openDatabase(':memory:')
    expect(saveGraphSettings(db, { nope: 1 })).toMatchObject({ ok: false })
    expect(saveGraphSettings(db, { apiKey: 'sk-test' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('密钥')
    })
    expect(saveGraphSettings(db, { intervalMinutes: 0 })).toMatchObject({ ok: false })
    expect(saveGraphSettings(db, { budgetTokensPerDay: 10 })).toMatchObject({ ok: false })
    expect(saveGraphSettings(db, { retryBackoffMinutes: [] })).toMatchObject({ ok: false })
    expect(saveGraphSettings(db, { maxTokens: 100 })).toMatchObject({ ok: false })
    expect(
      saveGraphSettings(db, { hotkeys: { toggleCapture: 'Alt+', openGraph: 'Alt+Space' } })
    ).toMatchObject({ ok: false })
    expect(
      saveGraphSettings(db, { hotkeys: { toggleCapture: 'Alt+P', openGraph: 'alt+p' } })
    ).toMatchObject({ ok: false, error: expect.stringContaining('相同') })
    // 任一失败都不落任何键
    expect(getSetting(db, GRAPH_SETTING_KEYS.intervalMinutes)).toBe('10')
    db.close()
  })

  it('供应商校验：非法 baseUrl / 未知字段 / apiKey 值 / id 重复都整单拒绝', () => {
    const db = openDatabase(':memory:')
    const base = { ...DEFAULT_PROVIDER }
    expect(
      saveGraphSettings(db, { providers: [{ ...base, baseUrl: 'http://example.com' }] })
    ).toMatchObject({ ok: false })
    expect(
      saveGraphSettings(db, { providers: [{ ...base, extra: 1 }] })
    ).toMatchObject({ ok: false })
    expect(
      saveGraphSettings(db, { providers: [{ ...base, apiKey: 'sk-test' }] })
    ).toMatchObject({ ok: false, error: expect.stringContaining('密钥') })
    expect(
      saveGraphSettings(db, { providers: [{ ...base }, { ...base }] })
    ).toMatchObject({ ok: false, error: expect.stringContaining('重复') })
    db.close()
  })

  it('activeProvider 必须在保存后的供应商列表里；当前配置损坏时不允许只改 active', () => {
    const db = openDatabase(':memory:')
    expect(saveGraphSettings(db, { activeProvider: 'nope' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不在供应商列表')
    })

    setSetting(db, GRAPH_SETTING_KEYS.providers, '{broken')
    expect(saveGraphSettings(db, { activeProvider: 'deepseek' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('损坏')
    })
    db.close()
  })

  it('保存失败时事务回滚（先写的键也不留）', () => {
    const db = openDatabase(':memory:')
    // 先用触发器让 hotkey.open_graph 的 UPDATE 失败，验证整单回滚
    db.exec(`
      CREATE TRIGGER fail_hotkey_write BEFORE INSERT ON settings
      WHEN NEW.key = 'hotkey.open_graph'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `)
    const result = saveGraphSettings(db, {
      intervalMinutes: 42,
      hotkeys: { toggleCapture: 'Ctrl+P', openGraph: 'Ctrl+G' }
    })
    expect(result.ok).toBe(false)
    expect(getSetting(db, GRAPH_SETTING_KEYS.intervalMinutes)).toBe('10')
    // 热键默认值不在 SETTING_DEFAULTS 里，未持久化时读回空串；readGraphSettings 再补默认
    expect(getSetting(db, 'hotkey.toggle_capture')).toBe('')
    db.close()
  })
})
