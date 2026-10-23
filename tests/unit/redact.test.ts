import { describe, expect, it } from 'vitest'
import { buildCloudPayload, buildCloudMomentPayload, type CloudPayload, type RedactableEvent } from '../../src/understand/cloud/redact'
import { LLM_DEFAULTS } from '../../src/understand/cloud/constants'

function event(overrides: Partial<RedactableEvent> = {}): RedactableEvent {
  return {
    id: 1,
    ts: 1_700_000_000_000,
    app: 'notepad.exe',
    windowTitle: '未命名 - 记事本',
    ocrText: '普通内容',
    sensitive: 0,
    ...overrides
  }
}

const SECRET_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz'
const SECRET_EMAIL = 'alice@example.com'
const SECRET_PHONE = '13812345678'
const SECRET_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

describe('buildCloudPayload · 出云唯一出口', () => {
  it('只输出必要字段并做空白归一化', () => {
    const result = buildCloudPayload([event({ windowTitle: '  标题\n  第二行 ', ocrText: ' a   b\t c ' })])
    expect(result.payload.events).toEqual([
      {
        id: 1,
        ts: 1_700_000_000_000,
        tsEnd: 1_700_000_000_000,
        app: 'notepad.exe',
        title: '标题 第二行',
        ocr: 'a b c',
        eventIds: [1]
      }
    ])
    expect(result.redactedIds).toEqual([])
    expect(result.excludedIds).toEqual([])
  })

  it('app 字段也走同一脱敏函数（审查发现 app 未脱敏）', () => {
    const result = buildCloudPayload([event({ id: 9, app: `launcher-${SECRET_API_KEY}` })])
    expect(result.redactedIds).toContain(9)
    const serialized = JSON.stringify(result.payload)
    expect(serialized).not.toContain(SECRET_API_KEY)
    expect(result.payload.events[0].app).toContain('[已脱敏]')
  })

  it('app 命中密码类规则时整条不出云', () => {
    const result = buildCloudPayload([event({ id: 10, app: 'password-manager.exe' })])
    expect(result.excludedIds).toEqual([10])
    expect(result.payload.events).toEqual([])
  })

  it('CloudPayload 的 brand 只存在于类型层，不参与序列化', () => {
    const result = buildCloudPayload([event()])
    expect(Object.keys(result.payload)).toEqual(['events'])
    expect(JSON.stringify(result.payload)).toBe(
      JSON.stringify({
        events: [
          {
            id: 1,
            ts: 1_700_000_000_000,
            tsEnd: 1_700_000_000_000,
            app: 'notepad.exe',
            title: '未命名 - 记事本',
            ocr: '普通内容',
            eventIds: [1]
          }
        ]
      })
    )
  })

  it('时刻载荷：ts 区间、event_ids 合并；整条不可剥离时其所有事件 id 进 excludedIds', () => {
    const result = buildCloudMomentPayload([
      {
        app: 'chrome.exe',
        title: '搜索结果',
        startTs: 1_700_000_000_000,
        endTs: 1_700_000_030_000,
        ocr: 'rust 生命周期',
        eventIds: [11, 12]
      },
      {
        app: '1password.exe',
        title: '密码库',
        startTs: 1_700_000_100_000,
        endTs: 1_700_000_100_000,
        ocr: 'vault',
        eventIds: [13, 14]
      }
    ])
    expect(result.payload.events).toEqual([
      {
        id: 11,
        ts: 1_700_000_000_000,
        tsEnd: 1_700_000_030_000,
        app: 'chrome.exe',
        title: '搜索结果',
        ocr: 'rust 生命周期',
        eventIds: [11, 12]
      }
    ])
    expect(result.excludedIds).toEqual([13, 14])
    expect(result.redactedIds).toEqual([])
  })

  it('时刻载荷序列化后不含 golden 敏感串（app / title / ocr 同一脱敏墙）', () => {
    const result = buildCloudMomentPayload([
      {
        app: 'chrome.exe',
        title: SECRET_EMAIL,
        startTs: 1_700_000_000_000,
        endTs: 1_700_000_030_000,
        ocr: `token ${SECRET_JWT} 手机 ${SECRET_PHONE} 密钥 ${SECRET_API_KEY}`,
        eventIds: [21, 22]
      }
    ])
    const serialized = JSON.stringify(result.payload)
    expect(serialized).not.toContain(SECRET_API_KEY)
    expect(serialized).not.toContain(SECRET_EMAIL)
    expect(serialized).not.toContain(SECRET_PHONE)
    expect(serialized).not.toContain(SECRET_JWT)
    expect(serialized).toContain('[已脱敏]')
    expect(result.redactedIds).toEqual([21, 22])
  })

  it('非 sensitive 事件若含敏感形态也剥离（双保险），序列化后不含原文', () => {
    const result = buildCloudPayload([
      event({ id: 7, ocrText: `密钥 ${SECRET_API_KEY}，邮箱 ${SECRET_EMAIL}，手机 ${SECRET_PHONE}` })
    ])
    expect(result.redactedIds).toContain(7)
    const serialized = JSON.stringify(result.payload)
    expect(serialized).not.toContain(SECRET_API_KEY)
    expect(serialized).not.toContain(SECRET_EMAIL)
    expect(serialized).not.toContain(SECRET_PHONE)
    expect(serialized).toContain('[已脱敏]')
  })

  it('带引号 JSON 凭据在序列化载荷中不残留（F02 golden）', () => {
    const quotedKey = 'Qx7mB2vN9pR4cT8z'
    const quotedToken = 'Zt9Lp3Wq8Rk1'
    const result = buildCloudPayload([
      event({
        id: 31,
        windowTitle: `config {"api_key":"${quotedKey}"}`,
        ocrText: `{"token":"${quotedToken}"}`
      })
    ])

    const serialized = JSON.stringify(result.payload)
    expect(serialized).not.toContain(quotedKey)
    expect(serialized).not.toContain(quotedToken)
    expect(serialized).toContain('[已脱敏]')
    expect(result.redactedIds).toEqual([31])
    expect(result.payload.events[0].ocr).toBe('{"[已脱敏]"}')
    expect(result.payload.events[0].title).toBe('config {"[已脱敏]"}')
  })

  it('时刻载荷：带引号 JSON 凭据同样剥离（F02）', () => {
    const quotedKey = 'Qx7mB2vN9pR4cT8z'
    const result = buildCloudMomentPayload([
      {
        app: 'code.exe',
        title: 'settings.json',
        startTs: 1_700_000_000_000,
        endTs: 1_700_000_030_000,
        ocr: `{"api_key":"${quotedKey}"}`,
        eventIds: [41, 42]
      }
    ])

    expect(JSON.stringify(result.payload)).not.toContain(quotedKey)
    expect(result.payload.events[0].ocr).toContain('[已脱敏]')
    expect(result.redactedIds).toEqual([41, 42])
  })

  it('sensitive=1 事件剥离命中片段后仍可出云', () => {
    const result = buildCloudPayload([
      event({ id: 2, sensitive: 1, ocrText: `登录 token: ${SECRET_JWT}` })
    ])
    expect(result.redactedIds).toEqual([2])
    expect(result.excludedIds).toEqual([])
    expect(result.payload.events[0].ocr).toContain('[已脱敏]')
    expect(JSON.stringify(result.payload)).not.toContain(SECRET_JWT)
  })

  it('密码类命中整条不出云，进入 excludedIds', () => {
    const result = buildCloudPayload([
      event({ id: 3, ocrText: '请输入密码 passw0rd' }),
      event({ id: 4, ocrText: '普通内容' })
    ])
    expect(result.excludedIds).toEqual([3])
    expect(result.payload.events.map((e) => e.id)).toEqual([4])
    expect(JSON.stringify(result.payload)).not.toContain('passw0rd')
  })

  it('标题与 OCR 分别截断到默认上限', () => {
    const longTitle = '标'.repeat(LLM_DEFAULTS.titleMaxChars + 50)
    const longOcr = '文'.repeat(LLM_DEFAULTS.ocrMaxChars + 50)
    const result = buildCloudPayload([event({ windowTitle: longTitle, ocrText: longOcr })])
    expect(result.payload.events[0].title).toHaveLength(LLM_DEFAULTS.titleMaxChars)
    expect(result.payload.events[0].ocr).toHaveLength(LLM_DEFAULTS.ocrMaxChars)
  })

  it('截断可覆盖（自定义上限）', () => {
    const result = buildCloudPayload([event({ windowTitle: 'abcdef', ocrText: 'ghijkl' })], {
      titleMaxChars: 3,
      ocrMaxChars: 4
    })
    expect(result.payload.events[0].title).toBe('abc')
    expect(result.payload.events[0].ocr).toBe('ghij')
  })

  it('敏感片段先剥离再截断：截断不会把半截密钥带出去', () => {
    const text = `${SECRET_API_KEY} ${'x'.repeat(300)}`
    const result = buildCloudPayload([event({ ocrText: text })], { ocrMaxChars: 10 })
    expect(result.payload.events[0].ocr).toBe('[已脱敏] xxxx')
    expect(JSON.stringify(result.payload)).not.toContain(SECRET_API_KEY.slice(0, 10))
  })

  it('brand 只接受 buildCloudPayload 产出（typecheck 兜底：字面量 / 改写字段都编译不过）', () => {
    const real = buildCloudPayload([event()]).payload
    // @ts-expect-error 业务代码不能直接用字面量伪造 CloudPayload（缺 brand）
    const fake: CloudPayload = { events: [] }
    expect(fake.events).toEqual([])
    // @ts-expect-error 事件字段只读，不能把已脱敏载荷改回原文
    real.events[0].ocr = 'RAW'
    // 运行时仍以类型为准：以上两行由图外 typecheck（tsconfig include tests）兜住
    expect(typeof real.events[0].ocr).toBe('string')
  })
})
