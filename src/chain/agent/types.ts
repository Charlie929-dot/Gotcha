/**
 * 信息链 · 问记忆（S1 代理核心）的类型
 *
 * 事实源：`docs/chain-agent-plan.md` §4（P7：**一次回答 + 引用段**，不做逐步解说）。
 * 这一层只做「问题 → 检索证据 → 出云 → 一段回答 + 引用段」，不含 UI。
 */

/** 一条引用：段身份 + 服务端补的事实（前端不用再查库）+ 模型给的一句「那是什么」 */
export interface ChainAskCitation {
  segmentId: number
  /** 段开始时刻（服务端从命中段行填） */
  at: number
  app: string
  title: string
  /** 模型对这一段的一句说明（≤200 字） */
  why: string
}

/** 送云前的一段证据（已脱敏、已截断） */
export interface ChainAskEvidence {
  segmentId: number
  app: string
  title: string
  startTs: number
  endTs: number
  /** 命中原文片段（默认 500 字） */
  text: string
  /** 是否已是截断后的片段（告诉模型「这不是全文」） */
  truncated: boolean
  tags: string[]
  links: string[]
}

/** 检索到、但最终没进引用的段（诊断用） */
export interface ChainAskStats {
  /** 检索命中段数 */
  hits: number
  /** 真正送进载荷的段数（脱敏挡下的不算） */
  evidence: number
  /** 模型返回的引用条数（剥白名单前） */
  cited: number
  /** 送进载荷的问题字符数 */
  questionChars: number
}

export type ChainAskResult =
  | { kind: 'answer'; answer: string; citations: ChainAskCitation[]; stats: ChainAskStats }
  /** 没命中 / 引用全被剥空：**不调 LLM 编话**，UI 直接展示 `NO_EVIDENCE_TEXT` */
  | { kind: 'no-evidence'; stats: ChainAskStats }
  | { kind: 'error'; reason: ChainAskErrorReason; message: string; stats: ChainAskStats }

export type ChainAskErrorReason =
  | 'empty-question'
  /** 出云门没开（D24 一次性确认） */
  | 'consent'
  /** 当日预算用完（D22 日账） */
  | 'budget'
  /** 没有可用客户端（缺 key / 配置不合法 / 没接问答案能力） */
  | 'client'
  /** 问题本身命中敏感规则，不该出云 */
  | 'question-blocked'
  /** 模型输出结构不对（整次失败，不当空结果） */
  | 'unparseable'
  /** 客户端抛错（网络 / 截断 / 超时） */
  | 'failed'

/** 没证据时的固定文案（契约 §4：不调 LLM 编话） */
export const NO_EVIDENCE_TEXT = '信息链里没找到'

/** 引用上限（初值，超了按相关度截断） */
export const MAX_CITATIONS = 6

/** 每段送进载荷的命中原文上限（字符） */
export const EVIDENCE_TEXT_CHARS = 500

/** 回答正文上限（字符），超了截断而不是失败 */
export const ANSWER_MAX_CHARS = 1_200
