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
  /** 指数退避基数：第 n 次重试等待 retryBaseMs * 4^(n-1)（1s / 4s） */
  retryBaseMs: 1_000,
  /** 归纳输出上限（JSON 截断会导致解析失败，宁大勿小） */
  maxTokens: 2_000,
  temperature: 0,
  /** 出云字段截断（D19 / 成本控制） */
  appMaxChars: 80,
  titleMaxChars: 120,
  ocrMaxChars: 200,
  /** 取批：只处理 now - 5min 之前的事件（留出相邻事件合并窗口） */
  batchLagMs: 5 * 60_000,
  /** 同一 app + 标题、相邻 ≤ 90s 的事件合并为一个「时刻」 */
  mergeGapMs: 90_000,
  /** 单批最多时刻数 */
  maxMoments: 20,
  /** 单次查询事件上限（防止长期停机后一次拉爆内存；游标仍逐批推进） */
  batchEventLimit: 5_000,
  /** 归纳节点标题 / 摘要上限（prompt 与校验器共用） */
  nodeTitleMaxChars: 24,
  nodeSummaryMaxChars: 80,
  /** 边 evidence 上限 */
  edgeEvidenceMaxChars: 120
} as const
