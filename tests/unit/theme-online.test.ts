import { describe, expect, it } from 'vitest'
import { insertEvent, openDatabase, type Db } from '../../src/db'
import { localDayKey } from '../../src/understand/moments'
import { writeEventVectors } from '../../src/understand/event-embeddings'
import { decodeVector, encodeVector } from '../../src/understand/graph-edges'
import { readThemeCentroids } from '../../src/understand/theme-centroids'
import type { ThemeNamingOutcome } from '../../src/understand/theme-naming'
import {
  applyAssignmentDecision,
  applyNamingToNode,
  createOnlineTheme,
  embedMomentEvents,
  isNamePending,
  onlineMetaJson,
  persistAssignment,
  readConfirmThemes,
  readMomentVectors,
  readRepresentativeMoments,
  refreshOnlineThemeCentroid,
  resolveThemeRoot,
  selectOnlineMoments,
  selectPendingNameThemes,
  toRedactableMoment,
  type OnlineMoment
} from '../../src/understand/theme-online'

const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime()

function seedEvent(db: Db, ts: number, title: string, ocr = ''): number {
  return insertEvent(db, { ts, app: 'Code', windowTitle: title, ocrText: ocr })
}

function seedMoment(
  db: Db,
  input: { startTs: number; title: string; ocr?: string; eventIds: number[] }
): number {
  const endTs = input.startTs + 60_000
  const result = db
    .prepare(
      `INSERT INTO moments (start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
       VALUES (?, ?, ?, 'Code', ?, ?, ?, ?)`
    )
    .run(
      input.startTs,
      endTs,
      localDayKey(input.startTs),
      input.title,
      input.ocr ?? '',
      JSON.stringify(input.eventIds),
      NOW
    )
  return Number(result.lastInsertRowid)
}

function seedTheme(
  db: Db,
  input: {
    id?: number
    title: string
    summary?: string
    type?: string
    tsStart?: number
    tsEnd?: number
    eventIds?: number[]
    metaJson?: string | null
    mergedInto?: number | null
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO nodes (level, type, title, summary, ts_start, ts_end, source_events, meta_json, merged_into)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.type ?? 'activity',
      input.title,
      input.summary ?? '',
      input.tsStart ?? NOW - 60_000,
      input.tsEnd ?? NOW,
      JSON.stringify(input.eventIds ?? []),
      input.metaJson ?? null,
      input.mergedInto ?? null
    )
  return Number(result.lastInsertRowid)
}

function readNode(db: Db, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown>
}

function memberships(db: Db): Array<{ theme_id: number; moment_id: number; source: string }> {
  return db
    .prepare('SELECT theme_id, moment_id, source FROM theme_moments ORDER BY theme_id, moment_id')
    .all() as Array<{ theme_id: number; moment_id: number; source: string }>
}

function llmName(title = '模型标题'): ThemeNamingOutcome {
  return {
    name: { title, summary: '模型摘要', type: 'knowledge' },
    source: 'llm',
    blockedEventIds: []
  }
}

describe('selectOnlineMoments（S6：只选还没归属的时刻）', () => {
  it('按时间升序、跳过已归属 / 已被节点覆盖 / 在途的时刻', () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 90_000, 'a.ts')
    const e2 = seedEvent(db, NOW - 80_000, 'b.ts')
    const e3 = seedEvent(db, NOW - 70_000, 'c.ts')
    const m1 = seedMoment(db, { startTs: NOW - 90_000, title: 'a.ts', eventIds: [e1] })
    const m2 = seedMoment(db, { startTs: NOW - 80_000, title: 'b.ts', eventIds: [e2] })
    const m3 = seedMoment(db, { startTs: NOW - 70_000, title: 'c.ts', eventIds: [e3] })
    const theme = seedTheme(db, { title: '已归属' })
    db.prepare(
      `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
       VALUES (?, ?, 1, 'owner', ?)`
    ).run(theme, m3, NOW)

    const all = selectOnlineMoments(db, { since: NOW - 86_400_000 })
    expect(all.moments.map((moment) => moment.id)).toEqual([m1, m2])

    const covered = selectOnlineMoments(db, {
      since: NOW - 86_400_000,
      coveredEventIds: new Set([e2])
    })
    expect(covered.moments.map((moment) => moment.id)).toEqual([m1])
    expect(covered.skippedCovered).toBe(1)

    const excluded = selectOnlineMoments(db, {
      since: NOW - 86_400_000,
      excludeMomentIds: new Set([m1])
    })
    expect(excluded.moments.map((moment) => moment.id)).toEqual([m2])
    expect(excluded.skippedPending).toBe(1)

    // 时间窗之前的旧时刻不处理（更早的走「补历史」）
    const recent = selectOnlineMoments(db, { since: NOW - 60_000 })
    expect(recent.moments).toEqual([])
    db.close()
  })

  it('已被节点覆盖的时刻排在前面也不会堵死后面的新时刻（翻页扫描）', () => {
    const db = openDatabase(':memory:')
    const eventIds: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const id = seedEvent(db, NOW - 500_000 + index * 1_000, `旧 ${index}`)
      eventIds.push(id)
      seedMoment(db, {
        startTs: NOW - 500_000 + index * 1_000,
        title: `旧 ${index}`,
        eventIds: [id]
      })
    }
    const freshEvent = seedEvent(db, NOW - 60_000, '新的')
    const fresh = seedMoment(db, { startTs: NOW - 60_000, title: '新的', eventIds: [freshEvent] })
    // 覆盖集合里只有旧事件 → 旧时刻必须被跳过、新时刻必须被选到
    const result = selectOnlineMoments(db, {
      since: NOW - 86_400_000,
      limit: 1,
      coveredEventIds: new Set(eventIds)
    })
    expect(result.moments.map((moment) => moment.id)).toEqual([fresh])
    expect(result.skippedCovered).toBeGreaterThan(0)
    db.close()
  })
})

describe('命名待办与回写（S6：重启后还能补名）', () => {
  it('只认带 namePending 标记的存活节点', () => {
    const db = openDatabase(':memory:')
    const pending = seedTheme(db, { title: '待命名', metaJson: onlineMetaJson(true) })
    seedTheme(db, { title: '已命名', metaJson: onlineMetaJson(false) })
    const merged = seedTheme(db, { title: '已合并', metaJson: onlineMetaJson(true) })
    const into = seedTheme(db, { title: '存活' })
    db.prepare('UPDATE nodes SET merged_into = ? WHERE id = ?').run(into, merged)

    expect(selectPendingNameThemes(db)).toEqual([pending])
    expect(isNamePending(onlineMetaJson(true))).toBe(true)
    expect(isNamePending(onlineMetaJson(false))).toBe(false)
    expect(isNamePending(null)).toBe(false)
    db.close()
  })

  it('新主题先落兜底标题并打标记，模型命名回来后覆盖并清标记', () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 90_000, '调试按钮')
    const momentId = seedMoment(db, { startTs: NOW - 90_000, title: '调试按钮', eventIds: [eventId] })
    const moment: OnlineMoment = {
      id: momentId,
      startTs: NOW - 90_000,
      endTs: NOW - 30_000,
      dayKey: localDayKey(NOW),
      app: 'Code',
      title: '调试按钮',
      ocr: '改 hover 样式',
      eventIds: [eventId]
    }

    const created = createOnlineTheme(db, { moment, now: NOW })
    const row = readNode(db, created.themeId)
    expect(row.level).toBe(1)
    expect(row.title).toBe('调试按钮')
    expect(String(row.summary)).toContain('本地兜底命名')
    expect(row.type).toBe('activity')
    expect(row.source_events).toBe(JSON.stringify([eventId]))
    expect(row.ts_start).toBe(moment.startTs)
    expect(row.ts_end).toBe(moment.endTs)
    expect(isNamePending(row.meta_json as string)).toBe(true)
    expect(memberships(db)).toEqual([
      { theme_id: created.themeId, moment_id: momentId, source: 'owner' }
    ])

    expect(applyNamingToNode(db, created.themeId, llmName('模型给的标题'))).toBe('updated')
    const named = readNode(db, created.themeId)
    expect(named.title).toBe('模型给的标题')
    expect(named.summary).toBe('模型摘要')
    expect(named.type).toBe('knowledge')
    expect(isNamePending(named.meta_json as string)).toBe(false)
    // 再回写一次同名结果：没有变化，不算「更新」
    expect(applyNamingToNode(db, created.themeId, llmName('模型给的标题'))).toBe('unchanged')

    // 已被合并：不覆盖存活主题，只清标记
    const survivor = seedTheme(db, { title: '存活主题' })
    db.prepare('UPDATE nodes SET merged_into = ? WHERE id = ?').run(survivor, created.themeId)
    expect(applyNamingToNode(db, created.themeId, llmName('不该写'))).toBe('merged')
    expect(readNode(db, created.themeId).title).toBe('模型给的标题')
    expect(isNamePending(readNode(db, created.themeId).meta_json as string)).toBe(false)
    db.close()
  })

  it('代表时刻取该主题最早的主归属时刻', () => {
    const db = openDatabase(':memory:')
    const theme = seedTheme(db, { title: '主题' })
    const moments = [0, 1, 2].map((index) => {
      const eventId = seedEvent(db, NOW - 300_000 + index * 60_000, `时刻 ${index}`)
      const momentId = seedMoment(db, {
        startTs: NOW - 300_000 + index * 60_000,
        title: `时刻 ${index}`,
        eventIds: [eventId]
      })
      db.prepare(
        `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
         VALUES (?, ?, 1, 'owner', ?)`
      ).run(theme, momentId, NOW)
      return momentId
    })
    const representative = readRepresentativeMoments(db, theme, 2)
    expect(representative.map((moment) => moment.id)).toEqual([moments[0], moments[1]])
    // 不存在的主题没有代表时刻
    expect(readRepresentativeMoments(db, 999)).toEqual([])
    db.close()
  })
})

describe('persistAssignment（S6：主 / 次归属与追溯字段）', () => {
  it('写 owner + secondary，扩展时间范围、并集 source_events，且幂等', () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 120_000, '旧事件')
    const e2 = seedEvent(db, NOW - 60_000, '新事件')
    const momentId = seedMoment(db, {
      startTs: NOW - 60_000,
      title: '新事件',
      eventIds: [e2]
    })
    const owner = seedTheme(db, {
      title: '主主题',
      tsStart: NOW - 120_000,
      tsEnd: NOW - 90_000,
      eventIds: [e1]
    })
    const secondary = seedTheme(db, { title: '次主题', tsStart: NOW - 200_000, tsEnd: NOW - 190_000 })

    const result = persistAssignment(
      db,
      momentId,
      { owner: { id: owner, sim: 0.9 }, secondaries: [{ id: secondary, sim: 0.85 }] },
      { now: NOW }
    )
    expect(result).toEqual({ status: 'assigned', themeIds: [owner, secondary] })
    expect(memberships(db)).toEqual([
      { theme_id: owner, moment_id: momentId, source: 'owner' },
      { theme_id: secondary, moment_id: momentId, source: 'secondary' }
    ])

    const ownerRow = readNode(db, owner)
    expect(ownerRow.ts_start).toBe(NOW - 120_000)
    expect(ownerRow.ts_end).toBe(NOW)
    expect(JSON.parse(ownerRow.source_events as string)).toEqual([e1, e2])
    // 次归属不并 source_events（只记关系）
    expect(readNode(db, secondary).source_events).toBe('[]')

    // 幂等：重复写不重复计数
    persistAssignment(
      db,
      momentId,
      { owner: { id: owner, sim: 0.9 }, secondaries: [{ id: secondary, sim: 0.85 }] },
      { now: NOW + 1 }
    )
    expect(memberships(db)).toHaveLength(2)
    db.close()
  })

  it('候选已合并 → 跟随到存活根；根不存在 → 不写半条', () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 60_000, '事件')
    const momentId = seedMoment(db, { startTs: NOW - 60_000, title: '事件', eventIds: [eventId] })
    const survivor = seedTheme(db, { title: '存活' })
    const merged = seedTheme(db, { title: '被合并', mergedInto: survivor })

    expect(resolveThemeRoot(db, merged)).toBe(survivor)
    const result = persistAssignment(
      db,
      momentId,
      { owner: { id: merged, sim: 0.9 }, secondaries: [] },
      { now: NOW }
    )
    expect(result.themeIds).toEqual([survivor])

    const ghastly = persistAssignment(
      db,
      999,
      { owner: { id: survivor, sim: 0.9 }, secondaries: [] },
      { now: NOW }
    )
    expect(ghastly.status).toBe('no-moment')
    db.close()
  })
})

describe('applyAssignmentDecision（S6：模糊确认结果落库）', () => {
  it('候选主题 → 归属；只给 newTitle → 建主题且不再等命名；已有归属 → 跳过', () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 90_000, '甲')
    const e2 = seedEvent(db, NOW - 80_000, '乙')
    const e3 = seedEvent(db, NOW - 70_000, '丙')
    const m1 = seedMoment(db, { startTs: NOW - 90_000, title: '甲', eventIds: [e1] })
    const m2 = seedMoment(db, { startTs: NOW - 80_000, title: '乙', eventIds: [e2] })
    const m3 = seedMoment(db, { startTs: NOW - 70_000, title: '丙', eventIds: [e3] })
    const theme = seedTheme(db, { title: '候选主题', eventIds: [] })

    const assigned = applyAssignmentDecision(
      db,
      { momentId: m1, themeIds: [theme] },
      { now: NOW }
    )
    expect(assigned).toEqual({ status: 'assigned', themeIds: [theme] })
    expect(memberships(db)).toEqual([
      { theme_id: theme, moment_id: m1, source: 'owner' }
    ])

    // 重复应用：时刻已经有归属，不覆盖
    expect(
      applyAssignmentDecision(db, { momentId: m1, themeIds: [theme] }, { now: NOW }).status
    ).toBe('skipped')

    const created = applyAssignmentDecision(
      db,
      { momentId: m2, themeIds: [], newTitle: '模型建议的主题' },
      { now: NOW }
    )
    expect(created.status).toBe('created')
    const node = readNode(db, created.createdThemeId as number)
    expect(node.title).toBe('模型建议的主题')
    expect(String(node.summary)).toContain('模糊确认新建')
    expect(isNamePending(node.meta_json as string)).toBe(false)

    // 主题 id 不存在 + newTitle → 仍按 newTitle 建
    const fallback = applyAssignmentDecision(
      db,
      { momentId: m3, themeIds: [9999], newTitle: '另一主题' },
      { now: NOW }
    )
    expect(fallback.status).toBe('created')
    expect(readNode(db, fallback.createdThemeId as number).title).toBe('另一主题')
    db.close()
  })

  it('两边都没有 → skipped，不写任何归属', () => {
    const db = openDatabase(':memory:')
    const eventId = seedEvent(db, NOW - 60_000, '事件')
    const momentId = seedMoment(db, { startTs: NOW - 60_000, title: '事件', eventIds: [eventId] })
    expect(applyAssignmentDecision(db, { momentId, themeIds: [] }, { now: NOW }).status).toBe(
      'skipped'
    )
    expect(memberships(db)).toEqual([])
    db.close()
  })
})

describe('向量增量（S6：只算相关行）', () => {
  function writeVectors(db: Db, rows: Array<[number, number[]]>, model = 'fake-bge'): void {
    writeEventVectors(
      db,
      rows.map(([eventId, vec]) => ({ eventId, vec: Float32Array.from(vec) })),
      { model, dim: 2, now: NOW }
    )
  }

  it('时刻质心 = 成员事件向量均值 + L2', () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 90_000, '甲')
    const e2 = seedEvent(db, NOW - 80_000, '乙')
    const momentId = seedMoment(db, {
      startTs: NOW - 90_000,
      title: '甲',
      eventIds: [e1, e2]
    })
    writeVectors(db, [
      [e1, [1, 0]],
      [e2, [0, 1]]
    ])
    const vectors = readMomentVectors(db, [momentId], 'fake-bge')
    const vec = vectors.get(momentId) as Float32Array
    expect(vec[0]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(vec[1]).toBeCloseTo(Math.SQRT1_2, 6)
    db.close()
  })

  it('只重算一个主题的质心（不碰别的主题）', () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 90_000, '甲')
    const e2 = seedEvent(db, NOW - 80_000, '乙')
    const m1 = seedMoment(db, { startTs: NOW - 90_000, title: '甲', eventIds: [e1] })
    const m2 = seedMoment(db, { startTs: NOW - 80_000, title: '乙', eventIds: [e2] })
    const themeA = seedTheme(db, { title: 'A', tsStart: NOW - 90_000, eventIds: [e1] })
    const themeB = seedTheme(db, { title: 'B', tsStart: NOW - 80_000, eventIds: [e2] })
    for (const [theme, moment] of [
      [themeA, m1],
      [themeB, m2]
    ] as const) {
      db.prepare(
        `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
         VALUES (?, ?, 1, 'owner', ?)`
      ).run(theme, moment, NOW)
    }
    writeVectors(db, [
      [e1, [1, 0]],
      [e2, [0, 1]]
    ])

    const centroid = refreshOnlineThemeCentroid(db, themeA, {
      model: 'fake-bge',
      dim: 2,
      now: NOW
    })
    expect(centroid?.nodeId).toBe(themeA)
    expect(centroid?.memberEvents).toBe(1)
    expect(Array.from(centroid?.vec ?? [])).toEqual([1, 0])

    const stored = readThemeCentroids(db, { model: 'fake-bge' }).centroids
    expect(stored.has(themeA)).toBe(true)
    expect(stored.has(themeB)).toBe(false)
    db.close()
  })

  it('成员事件还没向量 → 返回 null（等下一轮），不写假质心', () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 90_000, '甲')
    const m1 = seedMoment(db, { startTs: NOW - 90_000, title: '甲', eventIds: [e1] })
    const theme = seedTheme(db, { title: 'A', eventIds: [e1] })
    db.prepare(
      `INSERT INTO theme_moments (theme_id, moment_id, weight, source, created_at)
       VALUES (?, ?, 1, 'owner', ?)`
    ).run(theme, m1, NOW)
    expect(
      refreshOnlineThemeCentroid(db, theme, { model: 'fake-bge', dim: 2, now: NOW })
    ).toBeNull()
    db.close()
  })

  it('给新时刻的成员事件算向量，已有向量的不重算', async () => {
    const db = openDatabase(':memory:')
    const e1 = seedEvent(db, NOW - 90_000, '甲')
    const e2 = seedEvent(db, NOW - 80_000, '乙')
    const m1 = seedMoment(db, { startTs: NOW - 90_000, title: '甲', eventIds: [e1] })
    const m2 = seedMoment(db, { startTs: NOW - 80_000, title: '乙', eventIds: [e2] })
    writeVectors(db, [[e1, [1, 0]]])
    let calls = 0
    const embedder = {
      model: 'fake-bge',
      dim: 2,
      async embed(texts: string[]) {
        calls += 1
        return texts.map(() => Float32Array.from([0.5, 0.5]))
      }
    }
    const onlineMoment = (id: number, eventIds: number[]): OnlineMoment => ({
      id,
      startTs: NOW - 60_000,
      endTs: NOW,
      dayKey: localDayKey(NOW),
      app: 'Code',
      title: 'x',
      ocr: '',
      eventIds
    })
    const result = await embedMomentEvents(
      db,
      embedder,
      [onlineMoment(m1, [e1]), onlineMoment(m2, [e2])],
      { now: NOW }
    )
    expect(result.embedded).toBe(1)
    expect(calls).toBe(1)
    const stored = db.prepare('SELECT COUNT(*) AS c FROM event_embeddings').get() as { c: number }
    expect(stored.c).toBe(2)
    db.close()
  })

  it('encode/decode 保持维度（回归：质心 BLOB 写读）', () => {
    const vec = Float32Array.from([0.6, 0.8])
    const decoded = Array.from(decodeVector(encodeVector(vec)))
    expect(decoded).toHaveLength(2)
    expect(decoded[0]).toBeCloseTo(0.6, 6)
    expect(decoded[1]).toBeCloseTo(0.8, 6)
  })
})

describe('readConfirmThemes / toRedactableMoment', () => {
  it('候选主题排除已合并与 protected；时刻形状与出云载荷对齐', () => {
    const db = openDatabase(':memory:')
    const alive = seedTheme(db, { title: '存活', summary: '摘要' })
    const protectedTheme = seedTheme(db, { title: '受保护', type: 'protected' })
    const survivor = seedTheme(db, { title: '根' })
    const merged = seedTheme(db, { title: '已合并', mergedInto: survivor })

    const themes = readConfirmThemes(db, [alive, protectedTheme, merged, 9999])
    expect(themes.map((theme) => theme.themeId)).toEqual([alive, survivor])
    expect(themes[0]).toMatchObject({ title: '存活', summary: '摘要' })

    const redactable = toRedactableMoment({
      id: 1,
      startTs: 10,
      endTs: 20,
      dayKey: '2026-10-25',
      app: 'Code',
      title: 'a.ts',
      ocr: '正文',
      eventIds: [3, 4]
    })
    expect(redactable).toEqual({
      app: 'Code',
      title: 'a.ts',
      startTs: 10,
      endTs: 20,
      ocr: '正文',
      eventIds: [3, 4]
    })
    db.close()
  })
})
