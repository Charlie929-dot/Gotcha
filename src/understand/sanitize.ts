/**
 * 第 1/2 层脱敏墙（security.md；m1a-plan §4.2/§4.3，D10）
 *
 * - 命中密钥/证件/联系方式等特征 → sensitive=1，**本地保留原文**（M2 出云前才剥离）；
 * - 命中密码类特征词 → 整帧丢弃（drop=true，不入库、不落日志）；
 * - 本函数只做「识别 + 标记」，不改变文本内容。
 */

export interface SanitizeResult {
  /** 原文（M1a 不改写；D10） */
  text: string
  /** true = 命中敏感特征，入库时 sensitive=1 */
  sensitive: boolean
  /** true = 整帧丢弃（密码类特征词） */
  drop: boolean
}

interface Rule {
  name: string
  re: RegExp
  drop?: boolean
}

/** 顺序有意义：drop 规则先判定 */
const RULES: Rule[] = [
  // 密码输入特征词 → 整帧丢弃（视觉级检测超出 M1a 范围）
  { name: 'password-context', re: /密码|passw(?:or)?d|passphrase|\bpin\b/i, drop: true },
  // 认证头 / 通用 Bearer、Basic 凭据（security.md 正则层「JWT/Bearer」）
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { name: 'basic-auth', re: /\bBasic\s+[A-Za-z0-9+/=]{8,}/i },
  // 常见密钥形态
  { name: 'api-key', re: /\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/ },
  { name: 'secret-assignment', re: /(?:api[_-]?key|secret|token)\s*[:=]\s*[^\s]{6,}/i },
  { name: 'jwt', re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/ },
  // 证件 / 卡号 / 手机号
  { name: 'id-card', re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { name: 'bank-card', re: /(?<!\d)(?:\d{4}[ -]?){3}\d{4,7}(?!\d)/ },
  { name: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  // 账号 / 网络标识
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/ },
  { name: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: 'url-query', re: /[?&](?:token|access_token|api_key|key|secret|password|pwd|sig|signature)=[^\s&#]+/i }
]

export function sanitize(text: string): SanitizeResult {
  for (const rule of RULES) {
    if (rule.drop && rule.re.test(text)) {
      return { text, sensitive: false, drop: true }
    }
  }
  const sensitive = RULES.some((rule) => !rule.drop && rule.re.test(text))
  return { text, sensitive, drop: false }
}

/** M2 出云剥离占位符（D19） */
export const REDACTION_PLACEHOLDER = '[已脱敏]'

export interface RedactTextResult {
  /** 命中片段替换为占位符后的文本 */
  text: string
  /** 是否命中过非 drop 规则（替换过） */
  redacted: boolean
  /** true = 仍不安全（命中密码类规则，或剥离后仍有残留），该条不得出云 */
  blocked: boolean
}

function withGlobalFlag(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
}

/**
 * 出云前剥离（D19）：密码类命中整条 blocked；其余敏感规则命中片段替换为
 * `[已脱敏]`，剥离后仍能匹配任一规则则同样 blocked（宁可少发、不可漏发）。
 */
export function redactSensitive(text: string): RedactTextResult {
  for (const rule of RULES) {
    if (rule.drop && rule.re.test(text)) {
      return { text, redacted: false, blocked: true }
    }
  }
  let redactedText = text
  let redacted = false
  for (const rule of RULES) {
    if (rule.drop) continue
    if (rule.re.test(redactedText)) {
      redacted = true
      redactedText = redactedText.replace(withGlobalFlag(rule.re), REDACTION_PLACEHOLDER)
    }
  }
  const blocked = RULES.some((rule) => !rule.drop && rule.re.test(redactedText))
  return { text: redactedText, redacted, blocked }
}
