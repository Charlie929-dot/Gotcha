import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTemplate,
  formatReport,
  median,
  QUESTION_COUNT,
  runCli,
  scoreRecord,
  validateRecord,
  verdictFor,
  type BaselineRecord,
  type QuestionRecord,
  type RecallType
} from '../../scripts/recall-baseline.mts'

function makeQuestion(id: number, type: RecallType = 'content'): QuestionRecord {
  return {
    id,
    type,
    question: `第 ${id} 题：上周看到的那个东西在哪？`,
    clue: '',
    expected: { day: '2026-10-22' },
    attempts: { A: { hit: false, seconds: 0 }, B: { hit: false, seconds: 0 } }
  }
}

function makeRecord(questions: QuestionRecord[]): BaselineRecord {
  return {
    protocol_version: 1,
    created_at: '2026-10-25T10:00:00.000Z',
    data_range: { from: '2026-10-21', to: '2026-10-25' },
    notes: '',
    questions
  }
}

function filledQuestions(
  plan: (question: QuestionRecord, index: number) => QuestionRecord = (question) => question
): QuestionRecord[] {
  return Array.from({ length: QUESTION_COUNT }, (_, index) => {
    const type: RecallType = index < 8 ? 'content' : index < 14 ? 'time' : 'source'
    return plan(makeQuestion(index + 1, type), index)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('模板', () => {
  it('生成 20 题、题型 8/6/6、A/B 两轮齐备且都从「未命中 0 秒」开始', () => {
    const template = createTemplate(new Date('2026-10-25T02:00:00.000Z'))
    expect(template.questions).toHaveLength(QUESTION_COUNT)
    expect(template.questions.map((question) => question.id)).toEqual(
      Array.from({ length: QUESTION_COUNT }, (_, index) => index + 1)
    )
    const mix = template.questions.reduce<Record<string, number>>((acc, question) => {
      acc[question.type] = (acc[question.type] ?? 0) + 1
      return acc
    }, {})
    expect(mix).toEqual({ content: 8, time: 6, source: 6 })
    for (const question of template.questions) {
      expect(question.attempts.A).toEqual({ hit: false, seconds: 0 })
      expect(question.attempts.B).toEqual({ hit: false, seconds: 0 })
    }
    expect(template.created_at).toBe('2026-10-25T02:00:00.000Z')
  })

  it('模板可以按「只校验结构」通过，但不加选项就过不了（空题 / 空答案）', () => {
    const template = createTemplate()
    expect(validateRecord(template, { allowEmptyQuestions: true })).toEqual([])
    const errors = validateRecord(template)
    expect(errors.some((message) => message.includes('还没写题目'))).toBe(true)
    expect(errors.some((message) => message.includes('expected 至少要填'))).toBe(true)
  })
})

describe('记录校验', () => {
  it('填好的 20 题通过', () => {
    expect(validateRecord(makeRecord(filledQuestions()))).toEqual([])
  })

  it('题数不是 20 直接报', () => {
    const errors = validateRecord(makeRecord(filledQuestions().slice(0, 19)))
    expect(errors.some((message) => message.includes('题数必须是 20'))).toBe(true)
  })

  it('id 重复 / 类型非法会被指出来', () => {
    const questions = filledQuestions()
    questions[1].id = 1
    questions[2].type = 'other' as RecallType
    const errors = validateRecord(makeRecord(questions))
    expect(errors.some((message) => message.includes('重复'))).toBe(true)
    expect(errors.some((message) => message.includes('type 必须是'))).toBe(true)
  })

  it('秒数必须落在 0–120：负数和超上限都报（超时按 120 记）', () => {
    const questions = filledQuestions((question, index) => {
      if (index === 0) question.attempts.A.seconds = -1
      if (index === 1) question.attempts.A.seconds = 121
      return question
    })
    const errors = validateRecord(makeRecord(questions))
    expect(errors.filter((message) => message.includes('seconds 必须在 0–120')).length).toBe(2)
  })

  it('hit 必须是布尔值、A/B 两轮都不能少', () => {
    const questions = filledQuestions((question, index) => {
      if (index === 0) (question.attempts.A as unknown as Record<string, unknown>).hit = 'yes'
      if (index === 1) delete (question.attempts as Partial<QuestionRecord['attempts']>).B
      return question
    })
    const errors = validateRecord(makeRecord(questions))
    expect(errors.some((message) => message.includes('hit 必须是 true / false'))).toBe(true)
    expect(errors.some((message) => message.includes('B 轮缺少记录'))).toBe(true)
  })

  it('预期答案不能空，日期必须是 YYYY-MM-DD', () => {
    const questions = filledQuestions((question, index) => {
      if (index === 0) question.expected = {}
      if (index === 1) question.expected = { day: '2026/10/22' }
      return question
    })
    const errors = validateRecord(makeRecord(questions))
    expect(errors.some((message) => message.includes('expected 至少要填'))).toBe(true)
    expect(errors.some((message) => message.includes('YYYY-MM-DD'))).toBe(true)
  })
})

describe('中位数', () => {
  it('空数组为 null；奇数取中间；偶数取中间两个平均', () => {
    expect(median([])).toBeNull()
    expect(median([7])).toBe(7)
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 3])).toBe(2)
    expect(median([120, 0.5, 20])).toBe(20)
  })
})

describe('计分', () => {
  it('全对 10 秒：两轮都达标，没有未命中', () => {
    const record = makeRecord(
      filledQuestions((question) => {
        question.attempts = { A: { hit: true, seconds: 10 }, B: { hit: true, seconds: 10 } }
        return question
      })
    )
    const report = scoreRecord(record)
    expect(report.stats.A.hitRate).toBe(1)
    expect(report.stats.A.medianSeconds).toBe(10)
    expect(report.stats.A.misses).toEqual([])
    expect(report.verdicts.A.pass).toBe(true)
    expect(report.verdicts.B.pass).toBe(true)
  })

  it('恰好 14/20（70%）且中位 10 秒：达标（验收线是 ≥70%）', () => {
    const record = makeRecord(
      filledQuestions((question, index) => {
        question.attempts.A = index < 14 ? { hit: true, seconds: 10 } : { hit: false, seconds: 120 }
        return question
      })
    )
    const stats = scoreRecord(record).stats.A
    expect(stats.hitRate).toBe(0.7)
    expect(stats.hits).toBe(14)
    expect(stats.medianSeconds).toBe(10)
    expect(stats.misses).toEqual([15, 16, 17, 18, 19, 20])
    expect(verdictFor(stats).pass).toBe(true)
  })

  it('13/20：命中率 65% 未达标，原因写清楚', () => {
    const record = makeRecord(
      filledQuestions((question, index) => {
        question.attempts.B = index < 13 ? { hit: true, seconds: 12 } : { hit: false, seconds: 120 }
        return question
      })
    )
    const verdict = scoreRecord(record).verdicts.B
    expect(verdict.pass).toBe(false)
    expect(verdict.reasons.join('；')).toContain('65.0% < 70.0%')
  })

  it('中位恰好 30 秒不算过（验收线是 < 30）', () => {
    const record = makeRecord(
      filledQuestions((question) => {
        question.attempts.A = { hit: true, seconds: 30 }
        return question
      })
    )
    const verdict = scoreRecord(record).verdicts.A
    expect(verdict.pass).toBe(false)
    expect(verdict.reasons.join('；')).toContain('≥ 30 秒')
  })

  it('按题型分开统计：命中率与中位数各算各的', () => {
    const record = makeRecord(
      filledQuestions((question, index) => {
        if (index < 8) question.attempts.A = index < 6 ? { hit: true, seconds: 20 } : { hit: false, seconds: 120 }
        else if (index < 14) question.attempts.A = { hit: true, seconds: 5 }
        else question.attempts.A = index < 16 ? { hit: true, seconds: 60 } : { hit: false, seconds: 120 }
        return question
      })
    )
    const stats = scoreRecord(record).stats.A
    expect(stats.byType.content).toMatchObject({ total: 8, hits: 6, medianSeconds: 20 })
    expect(stats.byType.content.hitRate).toBe(0.75)
    expect(stats.byType.time).toMatchObject({ total: 6, hits: 6, medianSeconds: 5 })
    expect(stats.byType.source.hitRate).toBeCloseTo(2 / 6)
    expect(stats.byType.source.medianSeconds).toBe(120)
    expect(stats.overTarget).toBe(8)
  })
})

describe('报告', () => {
  it('markdown 带两轮、题型表、判定与对照，并提示回写位置', () => {
    const record = makeRecord(
      filledQuestions((question, index) => {
        question.attempts.A = index < 10 ? { hit: true, seconds: 40 } : { hit: false, seconds: 120 }
        question.attempts.B = index < 18 ? { hit: true, seconds: 8 } : { hit: false, seconds: 120 }
        return question
      })
    )
    const text = formatReport(record, scoreRecord(record))
    expect(text).toContain('A 轮（日历 + 图谱，不用检索）')
    expect(text).toContain('B 轮（门一检索）')
    expect(text).toContain('50.0%')
    expect(text).toContain('90.0%')
    expect(text).toContain('判定：**未达标**')
    expect(text).toContain('判定：**达标**')
    expect(text).toContain('B 轮（门一检索）达标 → 门一验收通过')
    expect(text).toContain('+40.0 个百分点')
    expect(text).toContain('docs/agent/workflow.md')
    expect(text).toContain('数据范围：2026-10-21 ~ 2026-10-25')
  })
})

describe('CLI', () => {
  it('--help 返回 0；缺文件返回 1；模板文件默认校验不通过', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runCli(['node', 'recall-baseline.mts', '--help'])).toBe(0)

    const dir = mkdtempSync(join(tmpdir(), 'recall-baseline-'))
    try {
      const target = join(dir, 'record.json')
      expect(runCli(['node', 'recall-baseline.mts', '--template', '--out', target])).toBe(0)
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as BaselineRecord
      expect(parsed.questions).toHaveLength(QUESTION_COUNT)

      expect(runCli(['node', 'recall-baseline.mts', target])).toBe(1)
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('记录不合法')

      expect(runCli(['node', 'recall-baseline.mts', join(dir, 'missing.json')])).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('合法的填好记录：退出码 0，--json 输出可解析的汇总', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk)
      return true
    })
    const dir = mkdtempSync(join(tmpdir(), 'recall-baseline-'))
    try {
      const record = makeRecord(
        filledQuestions((question) => {
          question.attempts = { A: { hit: true, seconds: 20 }, B: { hit: true, seconds: 10 } }
          return question
        })
      )
      const target = join(dir, 'filled.json')
      writeFileSync(target, JSON.stringify(record), 'utf8')
      expect(runCli(['node', 'recall-baseline.mts', target])).toBe(0)
      expect(stdout).toContain('# 门一回忆基线 · 汇总')

      stdout = ''
      expect(runCli(['node', 'recall-baseline.mts', target, '--json'])).toBe(0)
      const report = JSON.parse(stdout) as { stats: { A: { hitRate: number; medianSeconds: number } } }
      expect(report.stats.A.hitRate).toBe(1)
      expect(report.stats.A.medianSeconds).toBe(20)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
