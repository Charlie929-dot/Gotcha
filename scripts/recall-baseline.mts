/**
 * 门一 20 题回忆基线：题集模板 / 记录校验 / 计分。
 *
 * 协议与口径见 `docs/gate-one-recall-baseline.md`（验收线来源：
 * `docs/memory-orb-design-proposal.md` §3.5，D31）。
 *
 * 用法（Node 24 原生跑 TS，无需编译）：
 *   生成模板：npm run recall-baseline -- --template --out .tmp/recall-baseline.json
 *   出报告：  npm run recall-baseline -- .tmp/recall-baseline.json
 *
 * 这个脚本不碰应用、不碰数据库：输入是一份人工填写的 JSON。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 题量（协议固定 20，改题量等于改验收口径，需重新拍板）。 */
export const QUESTION_COUNT = 20
/** 每题计时上限：到点未找到记未命中，耗时按 120 秒计（统一口径）。 */
export const GIVE_UP_CAP_SECONDS = 120
/** 验收线：首次来源命中率 ≥ 70%。 */
export const HIT_RATE_TARGET = 0.7
/** 验收线：中位耗时 < 30 秒。 */
export const MEDIAN_SECONDS_TARGET = 30

export const ROUNDS = ['A', 'B'] as const
export type Round = (typeof ROUNDS)[number]

export const ROUND_LABELS: Record<Round, string> = {
  A: 'A 轮（日历 + 图谱，不用检索）',
  B: 'B 轮（门一检索）'
}

export const RECALL_TYPES = ['content', 'time', 'source'] as const
export type RecallType = (typeof RECALL_TYPES)[number]

export const TYPE_LABELS: Record<RecallType, string> = {
  content: '内容型',
  time: '时间型',
  source: '来源型'
}

/** 题型配比：内容型 8 / 时间型 6 / 来源型 6（见协议文档 §1）。 */
const TYPE_MIX: readonly RecallType[] = [
  'content',
  'content',
  'content',
  'content',
  'content',
  'content',
  'content',
  'content',
  'time',
  'time',
  'time',
  'time',
  'time',
  'time',
  'source',
  'source',
  'source',
  'source',
  'source',
  'source'
]

export interface ExpectedAnswer {
  app?: string
  title?: string
  day?: string
  snippet?: string
}

export interface AttemptRecord {
  hit: boolean
  seconds: number
  first_hit?: string
  note?: string
}

export interface QuestionRecord {
  id: number
  type: RecallType
  question: string
  clue?: string
  expected: ExpectedAnswer
  attempts: Record<Round, AttemptRecord>
}

export interface BaselineRecord {
  protocol_version: number
  created_at?: string
  data_range?: { from: string; to: string }
  notes?: string
  questions: QuestionRecord[]
}

export interface TypeStats {
  total: number
  hits: number
  hitRate: number
  medianSeconds: number | null
}

export interface RoundStats {
  round: Round
  total: number
  hits: number
  hitRate: number
  medianSeconds: number | null
  maxSeconds: number
  overTarget: number
  misses: number[]
  byType: Record<RecallType, TypeStats>
}

export interface Verdict {
  pass: boolean
  reasons: string[]
}

export interface ScoreReport {
  questionCount: number
  typeMix: Record<RecallType, number>
  dataRange?: { from: string; to: string }
  createdAt?: string
  stats: Record<Round, RoundStats>
  verdicts: Record<Round, Verdict>
}

function emptyAttempt(): AttemptRecord {
  return { hit: false, seconds: 0 }
}

/** 生成 20 题空模板；`created_at` 可注入固定时间便于测试。 */
export function createTemplate(now: Date = new Date()): BaselineRecord {
  return {
    protocol_version: 1,
    created_at: now.toISOString(),
    data_range: { from: '', to: '' },
    notes: '',
    questions: TYPE_MIX.map((type, index) => ({
      id: index + 1,
      type,
      question: '',
      clue: '',
      expected: {},
      attempts: { A: emptyAttempt(), B: emptyAttempt() }
    }))
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export interface ValidateOptions {
  /** 模板自检：允许题目 / 预期答案留空（只校验结构）。 */
  allowEmptyQuestions?: boolean
}

/** 校验记录；返回错误文案列表，空数组表示通过。 */
export function validateRecord(input: unknown, options: ValidateOptions = {}): string[] {
  const errors: string[] = []
  if (!isPlainObject(input)) return ['记录必须是 JSON 对象（不是数组或标量）']

  if (input.protocol_version !== 1) errors.push('protocol_version 必须是 1')
  if (input.created_at !== undefined && !isNonEmptyString(input.created_at)) {
    errors.push('created_at 必须是非空字符串')
  }
  if (input.data_range !== undefined) {
    if (!isPlainObject(input.data_range)) errors.push('data_range 必须是 { from, to } 对象')
    else {
      for (const key of ['from', 'to'] as const) {
        const value = input.data_range[key]
        if (value !== undefined && typeof value !== 'string') errors.push(`data_range.${key} 必须是字符串`)
      }
    }
  }
  if (input.notes !== undefined && typeof input.notes !== 'string') errors.push('notes 必须是字符串')

  if (!Array.isArray(input.questions)) return errors.concat('缺少 questions 数组')
  const questions = input.questions as unknown[]
  if (questions.length !== QUESTION_COUNT) {
    errors.push(`题数必须是 ${QUESTION_COUNT}，当前 ${questions.length}`)
  }

  const seenIds = new Set<number>()
  questions.forEach((raw, index) => {
    const label = `第 ${index + 1} 题`
    if (!isPlainObject(raw)) {
      errors.push(`${label}必须是对象`)
      return
    }
    const id = raw.id
    if (!Number.isInteger(id) || (id as number) < 1) {
      errors.push(`${label}的 id 必须是正整数`)
    } else if (seenIds.has(id as number)) {
      errors.push(`${label}的 id ${String(id)} 重复`)
    } else {
      seenIds.add(id as number)
    }

    if (!RECALL_TYPES.includes(raw.type as RecallType)) {
      errors.push(`${label}的 type 必须是 content / time / source`)
    }

    if (!options.allowEmptyQuestions) {
      if (!isNonEmptyString(raw.question)) errors.push(`${label}还没写题目（question）`)
      const expected = raw.expected
      if (!isPlainObject(expected)) {
        errors.push(`${label}缺少 expected 对象`)
      } else {
        const keys = ['app', 'title', 'day', 'snippet'] as const
        const filled = keys.filter((key) => isNonEmptyString(expected[key]))
        if (filled.length === 0) {
          errors.push(`${label}的 expected 至少要填 app / title / day / snippet 之一（可核查的预期答案）`)
        }
        if (expected.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(expected.day))) {
          errors.push(`${label}的 expected.day 必须是 YYYY-MM-DD`)
        }
      }
    }

    const attempts = raw.attempts
    if (!isPlainObject(attempts)) {
      errors.push(`${label}缺少 attempts（A / B 两轮）`)
      return
    }
    for (const round of ROUNDS) {
      const attempt = attempts[round]
      const attemptLabel = `${label}的 ${round} 轮`
      if (!isPlainObject(attempt)) {
        errors.push(`${attemptLabel}缺少记录`)
        continue
      }
      if (typeof attempt.hit !== 'boolean') errors.push(`${attemptLabel}的 hit 必须是 true / false`)
      const seconds = attempt.seconds
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        errors.push(`${attemptLabel}的 seconds 必须是数字`)
      } else if (seconds < 0 || seconds > GIVE_UP_CAP_SECONDS) {
        errors.push(`${attemptLabel}的 seconds 必须在 0–${GIVE_UP_CAP_SECONDS} 之间（超时按 ${GIVE_UP_CAP_SECONDS} 记）`)
      }
    }
  })

  return errors
}

/** 中位数：空数组返回 null；偶数个取中间两个的平均。 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function secondsText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function typeStats(questions: readonly QuestionRecord[], round: Round, type: RecallType): TypeStats {
  const subset = questions.filter((question) => question.type === type)
  const attempts = subset.map((question) => question.attempts[round]).filter((attempt) => attempt !== undefined)
  const hits = attempts.filter((attempt) => attempt.hit).length
  return {
    total: subset.length,
    hits,
    hitRate: subset.length === 0 ? 0 : hits / subset.length,
    medianSeconds: median(attempts.map((attempt) => attempt.seconds))
  }
}

function roundStats(questions: readonly QuestionRecord[], round: Round): RoundStats {
  const seconds = questions.map((question) => question.attempts[round]?.seconds ?? 0)
  const hits = questions.filter((question) => question.attempts[round]?.hit === true).length
  const byType = Object.fromEntries(
    RECALL_TYPES.map((type) => [type, typeStats(questions, round, type)])
  ) as Record<RecallType, TypeStats>
  return {
    round,
    total: questions.length,
    hits,
    hitRate: questions.length === 0 ? 0 : hits / questions.length,
    medianSeconds: median(seconds),
    maxSeconds: seconds.length === 0 ? 0 : Math.max(...seconds),
    overTarget: seconds.filter((value) => value >= MEDIAN_SECONDS_TARGET).length,
    misses: questions.filter((question) => question.attempts[round]?.hit !== true).map((question) => question.id),
    byType
  }
}

export function verdictFor(stats: RoundStats): Verdict {
  const reasons: string[] = []
  if (stats.hitRate < HIT_RATE_TARGET) {
    reasons.push(`首次来源命中率 ${percent(stats.hitRate)} < ${percent(HIT_RATE_TARGET)}`)
  }
  if (stats.medianSeconds === null) {
    reasons.push('没有可用的耗时记录')
  } else if (stats.medianSeconds >= MEDIAN_SECONDS_TARGET) {
    reasons.push(`中位耗时 ${secondsText(stats.medianSeconds)} 秒 ≥ ${MEDIAN_SECONDS_TARGET} 秒`)
  }
  return { pass: reasons.length === 0, reasons }
}

/** 计分；调用前应先 `validateRecord`。 */
export function scoreRecord(record: BaselineRecord): ScoreReport {
  const questions = record.questions
  const typeMix = Object.fromEntries(
    RECALL_TYPES.map((type) => [type, questions.filter((question) => question.type === type).length])
  ) as Record<RecallType, number>
  const stats = Object.fromEntries(ROUNDS.map((round) => [round, roundStats(questions, round)])) as Record<
    Round,
    RoundStats
  >
  const verdicts = Object.fromEntries(ROUNDS.map((round) => [round, verdictFor(stats[round])])) as Record<
    Round,
    Verdict
  >
  return {
    questionCount: questions.length,
    typeMix,
    dataRange: record.data_range,
    createdAt: record.created_at,
    stats,
    verdicts
  }
}

function roundSection(report: ScoreReport, round: Round): string[] {
  const stats = report.stats[round]
  const verdict = report.verdicts[round]
  const lines: string[] = []
  lines.push(`## ${ROUND_LABELS[round]}`)
  lines.push('')
  lines.push(`- 首次来源命中：${stats.hits}/${stats.total} = ${percent(stats.hitRate)}（目标 ≥ ${percent(HIT_RATE_TARGET)}）`)
  lines.push(
    `- 中位耗时：${stats.medianSeconds === null ? '—' : `${secondsText(stats.medianSeconds)} 秒`}（目标 < ${MEDIAN_SECONDS_TARGET} 秒）`
  )
  lines.push(`- 最长耗时：${secondsText(stats.maxSeconds)} 秒 · ≥ ${MEDIAN_SECONDS_TARGET} 秒的题：${stats.overTarget}`)
  lines.push(
    verdict.pass ? '- 判定：**达标**' : `- 判定：**未达标**（${verdict.reasons.join('；')}）`
  )
  lines.push(
    `- 未命中：${stats.misses.length === 0 ? '无' : stats.misses.map((id) => `#${id}`).join('、')}`
  )
  lines.push('')
  lines.push('| 题型 | 命中 | 命中率 | 中位耗时 |')
  lines.push('| - | - | - | - |')
  for (const type of RECALL_TYPES) {
    const t = stats.byType[type]
    lines.push(
      `| ${TYPE_LABELS[type]} | ${t.hits}/${t.total} | ${percent(t.hitRate)} | ${t.medianSeconds === null ? '—' : `${secondsText(t.medianSeconds)} 秒`} |`
    )
  }
  lines.push('')
  return lines
}

/** 生成 markdown 报告（给人看；机器读用 `--json`）。 */
export function formatReport(record: BaselineRecord, report: ScoreReport): string {
  const lines: string[] = []
  const mix = RECALL_TYPES.map((type) => `${TYPE_LABELS[type]} ${report.typeMix[type]}`).join(' / ')
  lines.push('# 门一回忆基线 · 汇总')
  lines.push('')
  lines.push(`- 题数：${report.questionCount}（${mix}）`)
  lines.push(`- 验收线：首次来源命中率 ≥ ${percent(HIT_RATE_TARGET)}，中位耗时 < ${MEDIAN_SECONDS_TARGET} 秒`)
  if (report.dataRange?.from || report.dataRange?.to) {
    lines.push(`- 数据范围：${report.dataRange.from || '?'} ~ ${report.dataRange.to || '?'}`)
  }
  if (report.createdAt) lines.push(`- 记录时间：${report.createdAt}`)
  if (record.notes) lines.push(`- 备注：${record.notes}`)
  lines.push('')
  lines.push(...roundSection(report, 'A'))
  lines.push(...roundSection(report, 'B'))
  lines.push('## 结论')
  lines.push('')
  const a = report.stats.A
  const b = report.stats.B
  const bVerdict = report.verdicts.B
  lines.push(
    bVerdict.pass
      ? '- B 轮（门一检索）达标 → 门一验收通过（验收线看 B 轮；A 轮只作基线对照）。'
      : `- B 轮（门一检索）未达标：${bVerdict.reasons.join('；')}。`
  )
  if (a.medianSeconds !== null && b.medianSeconds !== null) {
    const delta = (b.hitRate - a.hitRate) * 100
    const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} 个百分点`
    lines.push(
      `- 对照：命中率 A ${percent(a.hitRate)} → B ${percent(b.hitRate)}（${deltaText}）；中位耗时 A ${secondsText(a.medianSeconds)} 秒 → B ${secondsText(b.medianSeconds)} 秒。`
    )
  }
  lines.push('')
  lines.push('> 汇总数字回写到 `docs/m2-graph-redesign.md` §14 与 `docs/agent/workflow.md` §8；题目原文不入库。')
  return lines.join('\n')
}

function normalizePath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function printUsage(): void {
  console.error('用法：')
  console.error('  node scripts/recall-baseline.mts --template [--out .tmp/recall-baseline.json]')
  console.error('  node scripts/recall-baseline.mts .tmp/recall-baseline.json [--json]')
}

function readRecord(path: string): BaselineRecord {
  const text = readFileSync(path, 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, '')) as BaselineRecord
}

/** CLI 入口；返回进程退出码。 */
export function runCli(argv: readonly string[]): number {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    return 0
  }

  const outIndex = args.indexOf('--out')
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined
  if (outIndex >= 0 && (outPath === undefined || outPath.startsWith('--'))) {
    console.error('--out 需要一个文件路径')
    return 2
  }

  if (args.includes('--template')) {
    const template = createTemplate()
    const json = `${JSON.stringify(template, null, 2)}\n`
    if (outPath) {
      const absolute = resolve(outPath)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, json, 'utf8')
      console.error(`已写模板：${absolute}`)
      console.error(`填好后运行：node scripts/recall-baseline.mts ${outPath}`)
    } else {
      process.stdout.write(json)
    }
    return 0
  }

  const file = args.find((arg) => !arg.startsWith('--'))
  if (!file) {
    printUsage()
    return 2
  }

  let record: BaselineRecord
  try {
    record = readRecord(file)
  } catch (error) {
    console.error(`读不了记录文件：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const errors = validateRecord(record)
  if (errors.length > 0) {
    console.error(`记录不合法（${errors.length} 处）：`)
    for (const message of errors) console.error(`  ✗ ${message}`)
    return 1
  }

  const report = scoreRecord(record)
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatReport(record, report)}\n`)
  }
  return 0
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && normalizePath(invokedPath) === normalizePath(fileURLToPath(import.meta.url))) {
  process.exitCode = runCli(process.argv)
}
