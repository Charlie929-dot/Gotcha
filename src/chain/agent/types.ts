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

/**
 * 「检索到了、但没作为引用」的段（2026-10-29）：
 * 命中很多却答不上时，UI 至少要让人看见查到了哪些段（可点开证据）。
 * 只带段身份与标题，不带正文；**不等于引用**，界面按「相关」展示，不能当结论。
 */
export interface ChainAskRelatedSegment {
  segmentId: number
  at: number
  app: string
  title: string
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

/**
 * 检索到、但最终没进引用的段（诊断用）。
 * `turns` / `toolCalls` 是工具循环（toolloop）的诊断字段：老单发路径没有、
 * `ask-history` 的 `isStats` 只校验前四个 number 键，多出来的键不破坏旧记录读取。
 */
export interface ChainAskStats {
  /** 检索命中段数（循环口径：search_info 各次返回的命中总数） */
  hits: number
  /** 真正给模型看过的段数（循环口径：去重后的引用白名单大小） */
  evidence: number
  /** 模型返回的引用条数（剥白名单前） */
  cited: number
  /** 送进载荷的问题字符数 */
  questionChars: number
  /** 工具循环：assistant 轮数（含最终答复那一轮） */
  turns?: number
  /** 工具循环：工具调用总数 */
  toolCalls?: number
}

/** 「过程可见」里的一步工具调用（只存摘要，不存正文） */
export interface ChainAskTraceTool {
  name: string
  /** 模型给的参数（keywords / from / to / app / order / segmentId …；就是问题里的词，不含正文） */
  arguments: Record<string, unknown>
  /** 结果的一句话摘要（命中几段 / 打开哪段 / 失败原因） */
  summary: string
}

export interface ChainAskTraceStep {
  /** 第几轮（从 1 开始） */
  turn: number
  /** 模型这一轮的思考（DeepSeek reasoning_content；没开 thinking / 网关没给就缺省） */
  thinking?: string
  /** 这一轮发起的工具调用（收尾轮为空） */
  tools: ChainAskTraceTool[]
}

/**
 * 一次问答的过程（D55 ③）：每轮思考 + 工具调用摘要。
 * 只用于展示 / 落盘，不写回下一次请求；不含段正文。
 */
export interface ChainAskTrace {
  steps: ChainAskTraceStep[]
}

export type ChainAskResult =
  | {
      kind: 'answer'
      answer: string
      citations: ChainAskCitation[]
      stats: ChainAskStats
      trace?: ChainAskTrace
    }
  /**
   * 模型选择先向用户确认（缺关键信息 / 检索结果撑不起答案）：
   * 不硬凑回答，而是抛回一个问题 + 可点的候选，由用户补一句再问。
   */
  | {
      kind: 'clarify'
      question: string
      options: string[]
      stats: ChainAskStats
      trace?: ChainAskTrace
    }
  /**
   * 检索轮数快用完、模型还想继续查：先停下来问用户一句「还要继续吗」。
   * `resumeId` 是主进程内存里的检查点句柄（不落盘）：选「继续」就带着它恢复循环
   * 再给一轮工具预算；选「收尾」就按已经查到的内容作答。窗口重开 / 超时后失效。
   */
  | {
      kind: 'continue-ask'
      question: string
      options: string[]
      stats: ChainAskStats
      resumeId?: string
      trace?: ChainAskTrace
    }
  /**
   * 查到了相关段、但撑不起结论（2026-10-29）：模型给「查到了什么、为什么不够」，
   * 以及（可选，0–3 条）最相关的段作为「看过的证据」，**不当结论**。
   * 以前这种答复会被解析层整段丢掉、界面只剩固定文案「信息链里没找到」；
   * 拍板人要求「不能一句话都不说」，所以单独给一个出口。
   */
  | {
      kind: 'insufficient'
      answer: string
      citations: ChainAskCitation[]
      /** 检索到、但没进引用的段（最多 5 条，按检索顺序），给人一个入口 */
      related: ChainAskRelatedSegment[]
      stats: ChainAskStats
      trace?: ChainAskTrace
    }
  /**
   * 没命中 / 引用全被剥空：**不调 LLM 编话**，UI 直接展示 `NO_EVIDENCE_TEXT`。
   *
   * 2026-10-27 补：模型嘴上说「没找到」、却给了能点开的引用时，不再把整段说明丢掉——
   * 把说明留在 `note`、引用留在 `citations`（`note` 说明「查到了什么、为什么还是答不了」）。
   * 只说明「没找到」而没有额外信息时不带这两个字段，UI 仍显示固定文案。
   */
  | {
      kind: 'no-evidence'
      stats: ChainAskStats
      note?: string
      citations?: ChainAskCitation[]
      /** 检索到、但没进引用的段（同 `insufficient`） */
      related?: ChainAskRelatedSegment[]
      trace?: ChainAskTrace
    }
  | {
      kind: 'error'
      reason: ChainAskErrorReason
      message: string
      stats: ChainAskStats
      trace?: ChainAskTrace
    }

/** 续问时带上的上一轮对话（问题 + 最终答复 / 澄清问题），让「那上午呢」这类指代有处可落 */
export interface ChainAskTurnContext {
  question: string
  answer: string
}

/** 「还要继续查吗」的两个选择：继续检索（再给一轮预算）/ 按已经查到的结果收尾 */
export type ChainAskResumeDecision = 'continue' | 'stop'

/** 澄清问题里最多几个候选（模型可能一口气给一堆，UI 只画得下几个） */
export const MAX_CLARIFY_OPTIONS = 4
/** 单个候选的长度上限 */
export const CLARIFY_OPTION_MAX_CHARS = 60
/** 澄清问题本身的长度上限 */
export const CLARIFY_QUESTION_MAX_CHARS = 200

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
  /** 用户点了停止（在途请求被取消，不是失败） */
  | 'aborted'

/** 没证据时的固定文案（契约 §4：不调 LLM 编话） */
export const NO_EVIDENCE_TEXT = '信息链里没找到'

/** 引用上限（初值，超了按相关度截断） */
export const MAX_CITATIONS = 6

/** 每段送进载荷的命中原文上限（字符） */
export const EVIDENCE_TEXT_CHARS = 500

/** 回答正文上限（字符），超了截断而不是失败 */
export const ANSWER_MAX_CHARS = 1_200
