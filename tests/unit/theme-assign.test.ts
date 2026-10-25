import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { encodeVector, normalizeVector } from '../../src/understand/graph-edges'
import { GRAPH_THRESHOLD_DEFAULTS, type GraphThresholds } from '../../src/understand/graph-thresholds'
import {
  assignMoment,
  assignStoredMoment,
  momentVector,
  readAssignThemes,
  type AssignThemeCandidate
} from '../../src/understand/theme-assign'

function vec(...values: number[]): Float32Array {
  return normalizeVector(new Float32Array(values))
}

/** 与 +x 轴夹角 `deg` 的单位向量（二维，方便手算相似度） */
function at(deg: number): Float32Array {
  const rad = (deg * Math.PI) / 180
  return vec(Math.cos(rad), Math.sin(rad))
}

function theme(id: number, v: Float32Array, type?: string): AssignThemeCandidate {
  return { id, vec: v, type }
}

describe('assignMoment（S2 归属判定，纯函数）', () => {
  it('gap 够大：直接归 top1，不ambiguous', () => {
    const result = assignMoment({
      momentVec: at(0),
      themes: [theme(1, at(0)), theme(2, at(60))]
    })
    expect(result.reason).toBe('assigned')
    expect(result.owner).toEqual({ id: 1, sim: expect.closeTo(1, 5) })
    expect(result.nearDuplicateTop).toBe(false)
    expect(result.gap).toBeGreaterThan(0.4)
  })

  it('两个不同主题都像、分不出高下：ambiguous（交给 LLM）', () => {
    // 时刻在 25°，两个主题分别在 0° / 50°：对时刻的相似度都是 0.906，
    // 但两个主题之间只有 cos50° ≈ 0.64（不是近重复）
    const result = assignMoment({
      momentVec: at(25),
      themes: [theme(1, at(0)), theme(2, at(50))]
    })
    expect(result.reason).toBe('ambiguous')
    expect(result.owner).toBeNull()
    expect(result.nearDuplicateTop).toBe(false)
    expect(result.gap).toBeLessThan(0.02)
    expect(result.top1).not.toBeNull()
    expect(result.top2).not.toBeNull()
  })

  it('top1/top2 互为近重复：选谁都一样，直接归 top1、不出网', () => {
    // 两个主题只差 10°（主题间 0.985 ≥ 0.92），时刻贴着 0°
    const result = assignMoment({
      momentVec: at(0),
      themes: [theme(1, at(0)), theme(2, at(10))]
    })
    expect(result.reason).toBe('assigned')
    expect(result.owner?.id).toBe(1)
    expect(result.nearDuplicateTop).toBe(true)
    expect(result.gap).toBeLessThan(GRAPH_THRESHOLD_DEFAULTS.themeGapConfirm)
  })

  it('top1 低于 themeNewMinSim：判新主题', () => {
    const result = assignMoment({
      momentVec: at(0),
      themes: [theme(1, at(90))]
    })
    expect(result.reason).toBe('new-theme')
    expect(result.owner).toBeNull()
  })

  it('没有候选 / 维度不一致 / protected 主题都不参与', () => {
    expect(assignMoment({ momentVec: at(0), themes: [] }).reason).toBe('new-theme')
    expect(
      assignMoment({
        momentVec: vec(1, 0, 0),
        themes: [theme(1, vec(1, 0))]
      }).reason
    ).toBe('new-theme')
    expect(
      assignMoment({
        momentVec: at(0),
        themes: [theme(1, at(0), 'protected')]
      }).reason
    ).toBe('new-theme')
  })

  it('次归属：达到阈值、排除与 owner 近重复、受上限约束', () => {
    const thresholds: GraphThresholds = {
      ...GRAPH_THRESHOLD_DEFAULTS,
      themeMemberMinSim: 0.8,
      themeDuplicateSim: 0.99,
      themeSecondaryMax: 2
    }
    const result = assignMoment({
      momentVec: at(0),
      themes: [theme(1, at(0)), theme(2, at(20)), theme(3, at(30)), theme(4, at(45))],
      thresholds
    })
    expect(result.reason).toBe('assigned')
    expect(result.owner?.id).toBe(1)
    // 20° = 0.94、30° = 0.87 都过 0.8；45° = 0.71 不够
    expect(result.secondaries.map((item) => item.id)).toEqual([2, 3])

    const capped = assignMoment({
      momentVec: at(0),
      themes: [theme(1, at(0)), theme(2, at(20)), theme(3, at(30))],
      thresholds: { ...thresholds, themeSecondaryMax: 1 }
    })
    expect(capped.secondaries.map((item) => item.id)).toEqual([2])
  })

  it('相似度并列时 id 小的优先（确定性）', () => {
    const result = assignMoment({
      momentVec: at(0),
      themes: [theme(7, at(0)), theme(3, at(0))]
    })
    expect(result.owner?.id).toBe(3)
  })
})

describe('assignStoredMoment（读库算归属，只读）', () => {
  function seed(db: Db, options: { withVectors?: boolean } = {}): void {
    const withVectors = options.withVectors ?? true
    const now = new Date(2026, 9, 25, 10, 0, 0).getTime()
    db.prepare(
      `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events, meta_json, merged_into)
       VALUES (?, 1, 'knowledge', ?, '', ?, ?, '[]', NULL, NULL)`
    ).run(1, '主题一', now, now)
    db.prepare(
      `INSERT INTO nodes (id, level, type, title, summary, ts_start, ts_end, source_events, meta_json, merged_into)
       VALUES (?, 1, 'knowledge', ?, '', ?, ?, '[]', NULL, NULL)`
    ).run(2, '主题二', now, now)
    const writeCentroid = db.prepare(
      `INSERT INTO theme_centroids (node_id, model, dim, vec, member_events, updated_at) VALUES (?, 'test', 2, ?, 1, ?)`
    )
    writeCentroid.run(1, encodeVector(at(0)), now)
    writeCentroid.run(2, encodeVector(at(90)), now)

    const eventId = insertEvent(db, {
      ts: now,
      app: 'Code',
      windowTitle: 'a.ts',
      ocrText: ''
    })
    db.prepare(
      `INSERT INTO moments (id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
       VALUES (?, ?, ?, '2026-10-25', 'Code', 'a.ts', '', ?, ?)`
    ).run(55, now, now, JSON.stringify([eventId]), now)
    if (withVectors) {
      db.prepare(
        `INSERT INTO event_embeddings (event_id, model, dim, vec, updated_at) VALUES (?, 'test', 2, ?, ?)`
      ).run(eventId, encodeVector(at(5)), now)
    }
  }

  it('有向量有主题：算出归属', () => {
    const db = openDatabase(':memory:')
    seed(db)
    const themes = readAssignThemes(db)
    expect(themes.map((item) => item.id)).toEqual([1, 2])

    const vector = momentVector(db, 55)
    expect(vector).not.toBeNull()

    const result = assignStoredMoment(db, 55)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.assignment.owner?.id).toBe(1)
      expect(result.assignment.reason).toBe('assigned')
    }
    db.close()
  })

  it('缺向量 / 缺时刻 / 空图都如实返回状态', () => {
    const empty = openDatabase(':memory:')
    expect(assignStoredMoment(empty, 1).status).toBe('no-moment')
    empty.close()

    const noVectors = openDatabase(':memory:')
    seed(noVectors, { withVectors: false })
    expect(assignStoredMoment(noVectors, 55).status).toBe('no-vectors')
    noVectors.close()

    const noThemes = openDatabase(':memory:')
    seed(noThemes)
    noThemes.prepare('DELETE FROM theme_centroids').run()
    expect(assignStoredMoment(noThemes, 55).status).toBe('no-themes')
    noThemes.close()
  })
})
