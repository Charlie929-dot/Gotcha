import { describe, expect, it } from 'vitest'
import { FakeLlmClient, LlmAbortError, LlmHttpError } from '../../src/understand/cloud/llm-client'
import {
  CONFIRM_BATCH_MAX,
  confirmThemeAssignments,
  validateAssignments,
  type ConfirmMoment,
  type ConfirmTheme
} from '../../src/understand/theme-confirm'

function moment(overrides: Partial<ConfirmMoment> = {}): ConfirmMoment {
  return {
    momentId: 7,
    app: 'chrome.exe',
    title: 'Rust 生命周期',
    ocr: 'rust 学习笔记',
    candidateThemeIds: [1, 2],
    ...overrides
  }
}

function theme(overrides: Partial<ConfirmTheme> = {}): ConfirmTheme {
  return { themeId: 1, title: 'Rust 学习', summary: '语言学习', ...overrides }
}

function candidates(entries: Array<[number, number[]]>): Map<number, Set<number>> {
  return new Map(entries.map(([momentId, ids]) => [momentId, new Set(ids)]))
}

describe('validateAssignments · 越界裁剪 / 不编造 id', () => {
  it('合法输出按 moment_id 升序落到 decisions', () => {
    const result = validateAssignments(
      {
        assignments: [
          { moment_id: 8, theme_ids: [2] },
          { moment_id: 7, theme_ids: [3, 1] }
        ]
      },
      { candidates: candidates([[7, [1, 3]], [8, [2]]]) }
    )

    expect(result.ok).toBe(true)
    expect(result.decisions).toEqual([
      { momentId: 7, themeIds: [3, 1] },
      { momentId: 8, themeIds: [2] }
    ])
    expect(result.dropped).toBe(0)
    expect(result.trimmed).toBe(0)
  })

  it('每个时刻最多 3 个主题：去重后裁掉多出来的（trimmed 计数）', () => {
    const result = validateAssignments(
      { assignments: [{ moment_id: 5, theme_ids: [4, 4, 3, 2, 1] }] },
      { candidates: candidates([[5, [1, 2, 3, 4]]]) }
    )

    expect(result.decisions).toEqual([{ momentId: 5, themeIds: [4, 3, 2] }])
    expect(result.trimmed).toBe(1)
    expect(result.dropped).toBe(1) // 重复的 4 被丢掉
  })

  it('未知 moment_id / 非候选 theme_id 丢弃，不编造', () => {
    const result = validateAssignments(
      {
        assignments: [
          { moment_id: 99, theme_ids: [1] },
          { moment_id: 7, theme_ids: [9] }
        ]
      },
      { candidates: candidates([[7, [1, 3]]]) }
    )

    expect(result.ok).toBe(true)
    expect(result.decisions).toEqual([])
    expect(result.dropped).toBeGreaterThanOrEqual(2)
    const messages = result.errors.join('；')
    expect(messages).toContain('moment_id')
    expect(messages).toContain('非候选 id')
  })

  it('既没有 theme_ids 也没有 new_title：这一条等于「不归属」，留到下一轮', () => {
    const result = validateAssignments(
      { assignments: [{ moment_id: 7, theme_ids: [] }] },
      { candidates: candidates([[7, [1, 3]]]) }
    )
    expect(result.decisions).toEqual([])
    expect(result.dropped).toBe(1)
  })

  it('new_title 收下并裁到 24 字；候选都不合适时用它表示「建议新建」', () => {
    const result = validateAssignments(
      { assignments: [{ moment_id: 7, theme_ids: [], new_title: '标'.repeat(40) }] },
      { candidates: candidates([[7, [1, 3]]]) }
    )
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0].momentId).toBe(7)
    expect(result.decisions[0].themeIds).toEqual([])
    expect(result.decisions[0].newTitle).toHaveLength(24)
  })

  it('根结构非法 → ok:false（整次作废）', () => {
    expect(validateAssignments(null, { candidates: candidates([]) }).ok).toBe(false)
    expect(validateAssignments({ assignments: {} }, { candidates: candidates([]) }).ok).toBe(false)
    expect(validateAssignments({ assignments: [] }, { candidates: candidates([]) })).toMatchObject({
      ok: true,
      decisions: []
    })
  })
})

describe('confirmThemeAssignments · 失败不阻塞（S4）', () => {
  it('模型确认成功：decisions 落库前的结果 + usage；已定的时刻不再 pending', async () => {
    const client = new FakeLlmClient([
      {
        json: {
          assignments: [
            { moment_id: 7, theme_ids: [1] },
            { moment_id: 8, theme_ids: [2] }
          ]
        },
        usage: { promptTokens: 120, completionTokens: 10 }
      }
    ])
    const outcome = await confirmThemeAssignments(
      client,
      [moment(), moment({ momentId: 8, candidateThemeIds: [2] })],
      [theme(), theme({ themeId: 2, title: '笔记', summary: '日常记录' })]
    )

    expect(outcome.failed).toBe(false)
    expect(outcome.decisions).toEqual([
      { momentId: 7, themeIds: [1] },
      { momentId: 8, themeIds: [2] }
    ])
    expect(outcome.pendingMomentIds).toEqual([])
    expect(outcome.usage).toEqual({ promptTokens: 120, completionTokens: 10 })
    expect(client.assignmentRequests).toHaveLength(1)
  })

  it('请求失败：不抛错，整批 pending（reason=llm-error）', async () => {
    const client = new FakeLlmClient([new LlmHttpError(500)])
    const outcome = await confirmThemeAssignments(client, [moment()], [theme()])

    expect(outcome.failed).toBe(true)
    expect(outcome.reason).toBe('llm-error')
    expect(outcome.decisions).toEqual([])
    expect(outcome.pendingMomentIds).toEqual([7])
  })

  it('输出结构非法：整批 pending（reason=invalid-output），不整批失败到上层', async () => {
    const client = new FakeLlmClient([{ json: { assignments: 'nope' } }])
    const outcome = await confirmThemeAssignments(client, [moment()], [theme()])

    expect(outcome.failed).toBe(true)
    expect(outcome.reason).toBe('invalid-output')
    expect(outcome.pendingMomentIds).toEqual([7])
    expect(outcome.errors.join('；')).toContain('assignments')
  })

  it('未配置客户端（D24 门）：零请求，整批 pending', async () => {
    const outcome = await confirmThemeAssignments(null, [moment()], [theme()])
    expect(outcome.failed).toBe(true)
    expect(outcome.reason).toBe('no-client')
    expect(outcome.pendingMomentIds).toEqual([7])
  })

  it('敏感时刻 / 敏感主题不出现在载荷里；时刻留到下一轮', async () => {
    const client = new FakeLlmClient([
      { json: { assignments: [{ moment_id: 8, theme_ids: [1] }] } }
    ])
    const outcome = await confirmThemeAssignments(
      client,
      [
        moment({ momentId: 7, title: '密码库' }),
        moment({ momentId: 8, candidateThemeIds: [1, 2] })
      ],
      [theme(), theme({ themeId: 2, title: '密码备忘', summary: '密码' })]
    )

    const sent = client.assignmentRequests[0]
    expect(sent.moments.map((item) => item.momentId)).toEqual([8])
    expect(sent.themes.map((item) => item.themeId)).toEqual([1])
    expect(outcome.decisions).toEqual([{ momentId: 8, themeIds: [1] }])
    expect(outcome.pendingMomentIds).toEqual([7])
  })

  it('单批上限 20：超出的时刻留给下一轮', async () => {
    const moments = Array.from({ length: CONFIRM_BATCH_MAX + 1 }, (_value, index) =>
      moment({
        momentId: index + 1,
        candidateThemeIds: [1]
      })
    )
    const reply = {
      assignments: moments
        .slice(0, CONFIRM_BATCH_MAX)
        .map((item) => ({ moment_id: item.momentId, theme_ids: [1] }))
    }
    const client = new FakeLlmClient([{ json: reply }])
    const outcome = await confirmThemeAssignments(client, moments, [theme()])

    expect(client.assignmentRequests[0].moments).toHaveLength(CONFIRM_BATCH_MAX)
    expect(outcome.decisions).toHaveLength(CONFIRM_BATCH_MAX)
    expect(outcome.pendingMomentIds).toEqual([CONFIRM_BATCH_MAX + 1])
  })

  it('暂停取消必须外抛 LlmAbortError', async () => {
    const aborter = new AbortController()
    aborter.abort()
    const client = new FakeLlmClient([{ json: { assignments: [] } }])
    await expect(
      confirmThemeAssignments(client, [moment()], [theme()], { signal: aborter.signal })
    ).rejects.toBeInstanceOf(LlmAbortError)
  })
})
