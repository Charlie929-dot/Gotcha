/**
 * M2 LLM 默认参数（D22：默认值集中在这里，settings 可覆盖；测试引用同一常量，
 * 避免「默认值写死在业务代码」）。
 */
export const LLM_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  /** 单次请求超时 */
  timeoutMs: 60_000,
  /** 可重试错误（429 / 5xx / 网络 / 超时）的最大重试次数 */
  maxRetries: 2,
  /** 指数退避基数：第 n 次重试等待 retryBaseMs * 2^(n-1) */
  retryBaseMs: 1_000,
  /** 归纳输出上限（JSON 截断会导致解析失败，宁大勿小） */
  maxTokens: 2_000,
  temperature: 0,
  /** 出云字段截断（D19 / 成本控制） */
  appMaxChars: 80,
  titleMaxChars: 120,
  ocrMaxChars: 200
} as const
