import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db'
import { getSetting, setSetting } from '../../src/db/settings'
import {
  DEFAULT_SCALE_HINT_MOMENTS,
  GRAPH_SETTING_KEYS,
  readGraphSettings,
  saveGraphSettings
} from '../../src/main/graph-settings'
import { DEFAULT_PROVIDER } from '../../src/understand/cloud/providers'
import { GRAPH_THRESHOLD_DEFAULTS } from '../../src/understand/graph-thresholds'

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
    expect(defaults.thresholds).toEqual(GRAPH_THRESHOLD_DEFAULTS)
    // 日格热力满量默认 4000（一天全在使用约 3–4k 事件）
    expect(defaults.dayHeatMax).toBe(4_000)

    const db = openDatabase(':memory:')
    expect(readGraphSettings(db)).toEqual(defaults)
    db.close()
  })

  it('日格满量：库里的脏值（0 / 负数 / 越界 / 小数 / 非数字）一律回退默认', () => {
    const db = openDatabase(':memory:')
    for (const raw of ['0', '-100', '999999999', '3000.5', 'abc']) {
      setSetting(db, GRAPH_SETTING_KEYS.dayHeatMax, raw)
      expect(readGraphSettings(db).dayHeatMax).toBe(4_000)
    }
    setSetting(db, GRAPH_SETTING_KEYS.dayHeatMax, '1200')
    expect(readGraphSettings(db).dayHeatMax).toBe(1_200)
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
    expect(saveGraphSettings(db, { dayHeatMax: 50 })).toMatchObject({ ok: false })
    expect(saveGraphSettings(db, { dayHeatMax: '4000' })).toMatchObject({ ok: false })
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

  it('日格满量可保存并读回；整数与区间校验', () => {
    const db = openDatabase(':memory:')
    try {
      const saved = saveGraphSettings(db, { dayHeatMax: 6_500 })
      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      expect(saved.settings.dayHeatMax).toBe(6_500)
      expect(getSetting(db, GRAPH_SETTING_KEYS.dayHeatMax)).toBe('6500')
      expect(saveGraphSettings(db, { dayHeatMax: 4_000.5 })).toMatchObject({ ok: false })
      expect(saveGraphSettings(db, { dayHeatMax: 200_001 })).toMatchObject({ ok: false })
    } finally {
      db.close()
    }
  })

  it('时刻收窄提示阈值可保存并读回；缺省 2k，越界整单拒绝', () => {
    const db = openDatabase(':memory:')
    try {
      // 缺省值 = §12 的 2k（拿不到库时也是 2000，不因为缺设置就不提示）
      expect(readGraphSettings(db).scaleHintMoments).toBe(DEFAULT_SCALE_HINT_MOMENTS)
      const saved = saveGraphSettings(db, { scaleHintMoments: 3_000 })
      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      expect(saved.settings.scaleHintMoments).toBe(3_000)
      expect(getSetting(db, GRAPH_SETTING_KEYS.scaleHintMoments)).toBe('3000')
      expect(readGraphSettings(db).scaleHintMoments).toBe(3_000)
      expect(saveGraphSettings(db, { scaleHintMoments: 0 })).toMatchObject({ ok: false })
      expect(saveGraphSettings(db, { scaleHintMoments: 20_001 })).toMatchObject({ ok: false })
      expect(saveGraphSettings(db, { scaleHintMoments: '2000' })).toMatchObject({ ok: false })
      // 坏值不静默夹取：库里写成 0 时读回默认 2k
      setSetting(db, GRAPH_SETTING_KEYS.scaleHintMoments, '0')
      expect(readGraphSettings(db).scaleHintMoments).toBe(DEFAULT_SCALE_HINT_MOMENTS)
    } finally {
      db.close()
    }
  })

  it('阈值可作为设置项读写（含 edgeMutual 布尔）；非法阈值整单拒绝', () => {
    const db = openDatabase(':memory:')
    try {
      const saved = saveGraphSettings(db, {
        thresholds: { themeMergeSim: 0.97, themeSecondaryMax: 3, edgeTopK: 6, edgeMutual: false }
      })
      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      expect(saved.settings.thresholds).toMatchObject({
        themeMergeSim: 0.97,
        themeSecondaryMax: 3,
        edgeTopK: 6,
        edgeMutual: false
      })
      expect(getSetting(db, 'graph.edge_mutual')).toBe('0')

      expect(saveGraphSettings(db, { thresholds: { themeMergeSim: 2 } })).toMatchObject({
        ok: false
      })
      expect(saveGraphSettings(db, { thresholds: { nope: 1 } })).toMatchObject({ ok: false })
      // 失败不落库
      expect(getSetting(db, 'graph.theme_merge_sim')).toBe('0.97')
    } finally {
      db.close()
    }
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
