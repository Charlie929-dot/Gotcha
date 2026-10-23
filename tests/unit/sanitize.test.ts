import { describe, expect, it } from 'vitest'
import { sanitize } from '../../src/understand/sanitize'

describe('sanitize · 脱敏标记（D10：本地保留原文）', () => {
  it('普通文本不误报', () => {
    expect(sanitize('项目计划 / 会议纪要 / 待办事项')).toEqual({
      text: '项目计划 / 会议纪要 / 待办事项',
      sensitive: false,
      drop: false
    })
    expect(sanitize('Gotcha OCR spike 2026-10-21').sensitive).toBe(false)
  })

  it('手机号 → sensitive，原文保留', () => {
    const result = sanitize('联系电话 13800138000')
    expect(result).toEqual({ text: '联系电话 13800138000', sensitive: true, drop: false })
  })

  it('身份证号 / 银行卡号 / 邮箱 / IP / URL query / JWT / API key 都能命中', () => {
    const cases = [
      '证件 110101199003071234',
      '卡号 6222 0212 3456 7890',
      '邮箱 foo.bar@example.com',
      '服务器 192.168.1.10',
      'https://example.com/cb?access_token=abc123&x=1',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'sk-abcdefghijklmnop1234',
      'api_key: abcdef123456'
    ]
    for (const text of cases) {
      expect(sanitize(text).sensitive, text).toBe(true)
    }
  })

  it('Bearer / Basic 认证头命中（security.md 正则层「JWT/Bearer」）', () => {
    const cases = [
      'Authorization: Bearer abcDEF123._-xyz',
      'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="',
      'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      // percent-encoded / 冒号分隔等非 RFC 6750 b64token 形态也要兜住（PR #23 复审发现漏检）
      'Bearer abc%2Fdef%3Dxyz',
      'Bearer abc:def:ghijkl'
    ]
    for (const text of cases) {
      expect(sanitize(text).sensitive, text).toBe(true)
    }
    // 短 token / 普通英文不误报
    expect(sanitize('Bearer token 很短').sensitive).toBe(false)
  })

  it('密码类特征词 → 整帧丢弃（drop 优先，不标 sensitive）', () => {
    for (const text of ['请输入密码', 'Reset password', 'passwd:', 'PIN 码', 'passphrase']) {
      expect(sanitize(text)).toEqual({ text, sensitive: false, drop: true })
    }
  })

  it('drop 规则不误伤普通英文单词', () => {
    expect(sanitize('spinning wheel 转圈').drop).toBe(false)
  })
})
