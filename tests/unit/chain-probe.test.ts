import { describe, expect, it } from 'vitest'
import {
  activityProfile,
  advise,
  buildIdles,
  buildReport,
  buildSegments,
  buildStates,
  densityImpact,
  emptySegments,
  DEFAULT_TRIGGER_OPTIONS,
  estimateTriggers,
  formatReport,
  inputTimestamps,
  inputTouches,
  longestSegmentsWithActivity,
  median,
  parseJsonl,
  percentile,
  readSession,
  segmentDensity,
  SEGMENT_RULES,
  summarizeUia,
  toUiaRecords,
  trailingIdleStart,
  type ProbeRecord,
  type UiaRecord
} from '../../scripts/chain-probe/analyze.mts'

const T0 = 1_760_000_000_000

function at(seconds: number): number {
  return T0 + seconds * 1000
}

function fg(seconds: number, pid: number, title: string, exe = 'app'): ProbeRecord {
  return { type: 'fg', ts: at(seconds), pid, exe, title, hwnd: pid * 100 }
}

function title(seconds: number, pid: number, next: string): ProbeRecord {
  return { type: 'title', ts: at(seconds), pid, exe: 'app', title: next, hwnd: pid * 100 }
}

function move(seconds: number, x: number, y: number): ProbeRecord {
  return { type: 'move', ts: at(seconds), x, y }
}

function click(seconds: number, button = 'left'): ProbeRecord {
  return { type: 'click', ts: at(seconds), button, x: 10, y: 10 }
}

function wheel(seconds: number): ProbeRecord {
  return { type: 'wheel', ts: at(seconds), delta: 120, x: 10, y: 10 }
}

const windowRule = SEGMENT_RULES.find((rule) => rule.id === 'window')!
const appRule = SEGMENT_RULES.find((rule) => rule.id === 'app')!

describe('parseJsonl', () => {
  it('逐行解析，坏行计数但不抛错', () => {
    const text = [
      '{"type":"fg","ts":1,"pid":1,"exe":"a","title":"t"}',
      '',
      'not json',
      '{"no_type":true}',
      '{"type":"move","ts":2,"x":3,"y":4}'
    ].join('\n')
    const parsed = parseJsonl(text)
    expect(parsed.records).toHaveLength(2)
    expect(parsed.badLines).toBe(2)
  })

  it('容忍 CRLF 与空文件', () => {
    expect(parseJsonl('').records).toHaveLength(0)
    expect(parseJsonl('{"type":"session","ts":1}\r\n').records).toHaveLength(1)
  })
})

describe('readSession', () => {
  it('取 session 头的时间与屏幕尺寸，结束时间取最大 ts', () => {
    const records: ProbeRecord[] = [
      { type: 'session', ts: at(0) },
      fg(1, 1, 'a'),
      { type: 'move', ts: at(5), x: 1, y: 1 }
    ]
    Object.assign(records[0], { screen: [1920, 1080] as unknown as number })
    const session = readSession(records)
    expect(session.start).toBe(at(0))
    expect(session.end).toBe(at(5))
    expect(session.screen).toEqual([1920, 1080])
  })

  it('没有 session 头时用第一条记录兜底', () => {
    const session = readSession([fg(3, 1, 'a')])
    expect(session.start).toBe(at(3))
    expect(session.titles).toBe(true)
  })
})

describe('buildStates', () => {
  it('保留 fg 与 title 事件，按时间排序', () => {
    const states = buildStates([fg(1, 1, 'a'), title(3, 1, 'b'), fg(5, 2, 'c')])
    expect(states.map((s) => s.title)).toEqual(['a', 'b', 'c'])
  })

  it('同一时刻的重复上报只保留后一条，不产生零长度段', () => {
    const states = buildStates([fg(1, 1, 'a'), fg(1, 1, 'a2')])
    expect(states).toHaveLength(1)
    expect(states[0].title).toBe('a2')
  })

  it('同窗口同标题的重复 title 记录被忽略', () => {
    const states = buildStates([fg(1, 1, 'a'), title(2, 1, 'a')])
    expect(states).toHaveLength(1)
  })

  it('忽略 move / click', () => {
    const states = buildStates([fg(1, 1, 'a'), move(2, 1, 1), click(3)])
    expect(states).toHaveLength(1)
  })
})

describe('buildSegments', () => {
  it('前台切换即切段，最后一段延伸到会话结束', () => {
    const states = buildStates([fg(0, 1, 'a'), fg(60, 2, 'b')])
    const segments = buildSegments(states, [], windowRule, at(120))
    expect(segments).toHaveLength(2)
    expect(segments[0].ms).toBe(60_000)
    expect(segments[1].ms).toBe(60_000)
    expect(segments[1].exe).toBe('app')
  })

  it('标题变化：按窗口规则切，按应用规则合并', () => {
    const states = buildStates([fg(0, 1, 'a'), title(30, 1, 'b'), fg(90, 2, 'c')])
    expect(buildSegments(states, [], windowRule, at(120)).map((s) => s.title)).toEqual(['a', 'b', 'c'])
    const merged = buildSegments(states, [], appRule, at(120))
    expect(merged.map((s) => s.title)).toEqual(['a', 'c'])
    expect(merged[0].ms).toBe(90_000)
  })

  it('空闲区间把同一段切成两段，中间不算占用', () => {
    const states = buildStates([fg(0, 1, 'a'), fg(300, 2, 'b')])
    const idles = buildIdles([{ type: 'idle', ts: at(60) }, { type: 'active', ts: at(240) }])
    const segments = buildSegments(states, idles, windowRule, at(360))
    expect(segments).toHaveLength(3)
    expect(segments[0].ms).toBe(60_000)
    expect(segments[1].start).toBe(at(240))
    expect(segments[1].ms).toBe(60_000)
  })

  it('idleSplitMs=0 的规则不因空闲断开', () => {
    const states = buildStates([fg(0, 1, 'a'), fg(300, 2, 'b')])
    const idles = buildIdles([{ type: 'idle', ts: at(60) }, { type: 'active', ts: at(240) }])
    const segments = buildSegments(states, idles, SEGMENT_RULES[0], at(360))
    expect(segments).toHaveLength(2)
    expect(segments[0].ms).toBe(300_000)
  })

  it('走开又回到同一窗口：接续成一段，空闲不计入占用时长', () => {
    const rule = SEGMENT_RULES.find((r) => r.id === 'window-idle-merge')!
    const states = buildStates([fg(0, 1, 'a'), fg(300, 2, 'b')])
    const idles = buildIdles([{ type: 'idle', ts: at(60) }, { type: 'active', ts: at(240) }])
    const segments = buildSegments(states, idles, rule, at(360))
    // 窗口 a 走开 3 分钟又回来，仍是同一段；b 另起
    expect(segments).toHaveLength(2)
    expect(segments[0].ms).toBe(120_000)
    expect(segments[0].idleMs).toBe(180_000)
    expect(segments[0].end - segments[0].start).toBe(300_000)
  })

  it('离开超过接续上限就另起一段', () => {
    const rule = { ...SEGMENT_RULES.find((r) => r.id === 'window-idle-merge')!, mergeIdleGapMs: 120_000 }
    const states = buildStates([fg(0, 1, 'a'), fg(1000, 2, 'b')])
    const idles = buildIdles([{ type: 'idle', ts: at(60) }, { type: 'active', ts: at(900) }])
    const segments = buildSegments(states, idles, rule, at(1200))
    // a 被切成两段（中间离开 14 分钟，超过 2 分钟上限），b 第三段
    expect(segments).toHaveLength(3)
    expect(segments[0].idleMs).toBe(0)
    expect(segments[1].start).toBe(at(900))
  })

  it('回到的是另一个窗口就不接续', () => {
    const rule = SEGMENT_RULES.find((r) => r.id === 'window-idle-merge')!
    const states = buildStates([fg(0, 1, 'a'), fg(300, 2, 'b')])
    const idles = buildIdles([{ type: 'idle', ts: at(60) }, { type: 'active', ts: at(240) }])
    const segments = buildSegments(states, idles, rule, at(360))
    expect(segments[1].pid).toBe(2)
    expect(segments[1].idleMs).toBe(0)
  })

  it('空序列返回空段', () => {
    expect(buildSegments([], [], windowRule, at(10))).toEqual([])
  })

  it('未结束的空闲区间算到最后一条记录', () => {
    const idles = buildIdles([fg(0, 1, 'a'), { type: 'idle', ts: at(10) }, { type: 'move', ts: at(40), x: 0, y: 0 }])
    expect(idles).toEqual([{ start: at(10), end: at(40) }])
  })
})

describe('median / percentile', () => {
  it('偶数取平均并四舍五入，奇数取中位', () => {
    expect(median([1, 2, 3, 4])).toBe(3)
    expect(median([1, 2, 3])).toBe(2)
    expect(median([])).toBe(0)
  })

  it('P90 取向上取整下标，越界夹到末尾', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9)
    expect(percentile([7], 0.9)).toBe(7)
    expect(percentile([], 0.9)).toBe(0)
  })
})

describe('estimateTriggers', () => {
  it('点击与滚轮都算触发', () => {
    const { triggers, rawByKind } = estimateTriggers([click(0), wheel(10)])
    expect(triggers.map((t) => t.kind)).toEqual(['click', 'wheel'])
    expect(rawByKind).toEqual({ click: 1, wheel: 1, 'move-pause': 0 })
  })

  it('移动一段距离后停下算一次，但只移动几像素不算', () => {
    const far = estimateTriggers([move(0, 0, 0), move(0.1, 100, 0), click(5)])
    expect(far.rawByKind['move-pause']).toBe(1)

    const near = estimateTriggers([move(0, 0, 0), move(0.1, 5, 0), click(5)])
    expect(near.rawByKind['move-pause']).toBe(0)
  })

  it('冷却期内不重复触发', () => {
    const { triggers } = estimateTriggers([
      move(0, 0, 0),
      move(0.1, 100, 0),
      move(0.2, 200, 0),
      { type: 'click', ts: at(0.3), button: 'left', x: 10, y: 10 }
    ])
    // 暂停（0.2s）与点击（0.3s）相距 100ms，只留第一个
    expect(triggers).toHaveLength(1)
  })

  it('略微超过冷却期就都保留', () => {
    const gap = DEFAULT_TRIGGER_OPTIONS.cooldownMs / 1000
    const { triggers } = estimateTriggers([click(0), click(gap + 1)])
    expect(triggers).toHaveLength(2)
  })

  it('末尾没有后续事件时也能确认暂停', () => {
    const { triggers } = estimateTriggers([move(0, 0, 0), move(0.1, 120, 0)], DEFAULT_TRIGGER_OPTIONS, at(3))
    expect(triggers).toHaveLength(1)
    expect(triggers[0].kind).toBe('move-pause')
  })
})

describe('事件密度', () => {
  it('密度 = 事件数 / 分钟，零长度段算 0', () => {
    expect(segmentDensity(60, 60_000)).toBe(60)
    expect(segmentDensity(30, 60_000)).toBe(30)
    expect(segmentDensity(5, 0)).toBe(0)
    expect(segmentDensity(0, 600_000)).toBe(0)
  })

  it('按密度下限筛段：只留真有输入的段', () => {
    const records: ProbeRecord[] = [fg(0, 1, 'a'), click(10), fg(60, 2, 'b'), fg(300, 1, 'a')]
    const segments = buildSegments(buildStates(records), [], appRule, at(300))
    expect(segments).toHaveLength(2)
    const impact = densityImpact(segments, records, [0, 1])
    expect(impact[0]).toMatchObject({ minPerMinute: 0, segments: 2, keptSegmentShare: 1 })
    // 第一段 60s 内 1 个事件 = 1/分钟 → 保留；第二段 240s 无事件 → 筛掉
    expect(impact[1].segments).toBe(1)
    expect(impact[1].keptTimeShare).toBeCloseTo(60 / 300, 5)
  })

  it('空段统计给出中位时长', () => {
    const records: ProbeRecord[] = [click(1), fg(60, 2, 'b'), fg(240, 3, 'c')]
    const segments = buildSegments(buildStates(records), [], appRule, at(300))
    const empty = emptySegments(segments, records)
    expect(empty.count).toBe(2)
    expect(empty.medianMs).toBe(120_000)
  })
})
describe('操作次数与段内活跃度', () => {
  it('间隔 ≥1 秒才算新的一次操作，连着动算一次', () => {
    const burst: ProbeRecord[] = [move(0, 0, 0), move(0.1, 40, 0), move(0.2, 80, 0)]
    expect(inputTouches(burst)).toHaveLength(1)
    expect(inputTouches([...burst, move(2, 0, 0)])).toHaveLength(2)
  })

  it('段内有效时长 = 每个事件之后 60 秒，重叠合并', () => {
    const records: ProbeRecord[] = [fg(0, 1, 'a'), click(10), { type: 'stop', ts: at(190) }]
    const segments = buildSegments(buildStates(records), [], appRule, at(190))
    const profile = activityProfile(segments[0], inputTimestamps(records), 60_000)
    expect(profile.totalMs).toBe(190_000)
    expect(profile.activeMs).toBe(60_000)
    expect(profile.activeShare).toBeCloseTo(60 / 190, 5)
  })

  it('一段里 39 个事件挤在一次操作里：活跃度高但操作数只有 1（视频页就是这样）', () => {
    const records: ProbeRecord[] = [fg(0, 1, 'video'), ...Array.from({ length: 39 }, (_, i) => move(i * 0.01, i * 5, 0)), { type: 'stop', ts: at(61) }]
    const segments = buildSegments(buildStates(records), [], appRule, at(61))
    const row = longestSegmentsWithActivity(segments, records, 1)[0]
    expect(row.touches).toBe(1)
    expect(row.events).toBe(39)
    expect(row.activity.activeShare).toBeGreaterThan(0.9)
  })
})
describe('summarizeUia', () => {
  function uiaRecord(overrides: Partial<UiaRecord>): UiaRecord {
    return {
      exe: 'app',
      title: 't',
      ok: true,
      timedOut: false,
      elements: 10,
      withName: 5,
      chars: 500,
      password: 0,
      ms: 100,
      error: null,
      ...overrides
    }
  }

  it('空输入返回 null', () => {
    expect(summarizeUia([])).toBeNull()
  })

  it('按文本量分档，空输入不算失败', () => {
    const summary = summarizeUia([
      uiaRecord({ chars: 0 }),
      uiaRecord({ chars: 120 }),
      uiaRecord({ chars: 800 }),
      uiaRecord({ ok: false, chars: 0, error: 'denied' }),
      uiaRecord({ ok: false, chars: 0, timedOut: true, ms: 10_000 })
    ])
    expect(summary).not.toBeNull()
    expect(summary?.windows).toBe(5)
    expect(summary?.ok).toBe(3)
    expect(summary?.empty).toBe(1)
    expect(summary?.thin).toBe(1)
    expect(summary?.rich).toBe(1)
    expect(summary?.timedOut).toBe(1)
    expect(summary?.failed).toBe(1)
  })

  it('按应用汇总，按窗口数排序', () => {
    const summary = summarizeUia([
      uiaRecord({ exe: 'a', chars: 100 }),
      uiaRecord({ exe: 'a', chars: 300 }),
      uiaRecord({ exe: 'b', chars: 0 })
    ])
    expect(summary?.perApp[0].exe).toBe('a')
    expect(summary?.perApp[0].windows).toBe(2)
    expect(summary?.perApp[0].medianChars).toBe(200)
  })

  it('toUiaRecords 只认 type=uia 并补齐缺省字段', () => {
    const records = toUiaRecords([
      { type: 'uia', ts: 1, exe: 'x' } as unknown as ProbeRecord,
      { type: 'fg', ts: 2 }
    ])
    expect(records).toHaveLength(1)
    expect(records[0].ok).toBe(false)
    expect(records[0].chars).toBe(0)
  })
})

describe('buildReport', () => {
  it('把切段、触发、UIA 组合成一份报告', () => {
    const records: ProbeRecord[] = [
      { type: 'session', ts: at(0) },
      fg(0, 1, 'a'),
      move(1, 0, 0),
      move(1.2, 100, 0),
      click(5),
      fg(600, 2, 'b'),
      move(601, 0, 0),
      move(601.2, 90, 0),
      click(605)
    ]
    const report = buildReport(records, [])
    expect(report.ruleStats).toHaveLength(SEGMENT_RULES.length)
    expect(report.fgChanges).toBe(2)
    expect(report.session.end).toBe(at(605))
    expect(report.trigger.triggers.length).toBeGreaterThan(0)
    expect(report.uia).toBeNull()
  })

  it('触发点落在对应段内', () => {
    const records: ProbeRecord[] = [
      fg(0, 1, 'a'),
      click(10),
      fg(100, 2, 'b'),
      click(110)
    ]
    const report = buildReport(records, [])
    expect(report.trigger.perSegment).toEqual([1, 1])
    expect(report.trigger.segmentsWithoutTrigger).toBe(0)
  })

  it('坏行计入报告', () => {
    const report = buildReport([fg(0, 1, 'a'), fg(10, 1, 'a')], [], 3)
    expect(report.badLines).toBe(3)
  })
})

describe('formatReport / advise', () => {
  it('报告包含四块内容且没有占位符', () => {
    const records: ProbeRecord[] = [
      { type: 'session', ts: at(0) },
      fg(0, 1, 'editor'),
      click(30),
      fg(3600, 2, 'browser'),
      click(3700)
    ]
    const text = formatReport(buildReport(records, []))
    expect(text).toContain('## 1. 窗口占用段')
    expect(text).toContain('## 2. 截图触发密度')
    expect(text).toContain('## 3. 事件密度')
    expect(text).toContain('## 5. 建议')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
  })

  it('有 UIA 数据时才输出第三节', () => {
    const base: ProbeRecord[] = [{ type: 'session', ts: at(0) }, fg(0, 1, 'a'), fg(60, 2, 'b')]
    expect(formatReport(buildReport(base, []))).not.toContain('## 4. UIA 覆盖率')
    const uia = toUiaRecords([
      {
        type: 'uia',
        ts: at(1),
        exe: 'a',
        title: 't',
        ok: true,
        timedOut: false,
        elements: 5,
        withName: 5,
        chars: 900,
        password: 0,
        ms: 80,
        error: null
      } as unknown as ProbeRecord
    ])
    const text = formatReport(buildReport(base, uia))
    expect(text).toContain('## 4. UIA 覆盖率')
    expect(text).toContain('| a | 1 | 1 | 0 | 900 |')
  })

  it('段碎、触发过密、UIA 拿不到文本时各给一条建议', () => {
    const advice = advise({
      session: { start: at(0), end: at(600), screen: null, titles: true },
      records: 0,
      badLines: 0,
      fgChanges: 0,
      titleChanges: 0,
      fgPerHour: 0,
      idleMs: 0,
      idleShare: 0,
      idleMarkers: { count: 0, medianMs: 0 },
      ruleStats: [
        {
          id: 'raw',
          label: 'raw',
          segments: 100,
          coveredMs: 600_000,
          medianMs: 3000,
          p90Ms: 5000,
          longestMs: 20_000,
          under5s: 60,
          under5sShare: 0.6,
          over30min: 0,
          excludedIdleMs: 0,
          perHour: 600,
          topApps: []
        },
        {
          id: 'window',
          label: 'window',
          segments: 80,
          coveredMs: 600_000,
          medianMs: 4000,
          p90Ms: 9000,
          longestMs: 20_000,
          under5s: 40,
          under5sShare: 0.5,
          over30min: 0,
          excludedIdleMs: 0,
          perHour: 480,
          topApps: []
        },
        {
          id: 'app',
          label: 'app',
          segments: 40,
          coveredMs: 600_000,
          medianMs: 9000,
          p90Ms: 20_000,
          longestMs: 40_000,
          under5s: 10,
          under5sShare: 0.25,
          over30min: 0,
          excludedIdleMs: 0,
          perHour: 240,
          topApps: []
        }
      ],
      trigger: {
        triggers: [],
        rawByKind: { click: 0, wheel: 0, 'move-pause': 0 },
        perHour: 400,
        perSegment: [],
        segmentsWithoutTrigger: 0,
        medianPerSegment: 0
      },
      uia: {
        windows: 10,
        ok: 10,
        failed: 0,
        timedOut: 0,
        empty: 5,
        thin: 0,
        rich: 5,
        passwordWindows: 0,
        medianChars: 300,
        medianMs: 100,
        perApp: []
      },
      density: [],
      emptySegments: { count: 0, ms: 0, medianMs: 0 },
      activity: { activeMs: 0, coveredMs: 0, activeShare: 0, longest: [] },
      trailingIdleStart: null
    })
    expect(advice.some((line) => line.includes('一瞥'))).toBe(true)
    expect(advice.some((line) => line.includes('偏密'))).toBe(true)
    expect(advice.some((line) => line.includes('OCR 兜底'))).toBe(true)
  })

  it('空闲占比高时提醒按空闲断段', () => {
    const advice = advise({
      session: { start: at(0), end: at(3_600_000), screen: null, titles: true },
      records: 0,
      badLines: 0,
      fgChanges: 0,
      titleChanges: 0,
      fgPerHour: 0,
      idleMs: 1_800_000,
      idleShare: 0.5,
      idleMarkers: { count: 1, medianMs: 1_800_000 },
      ruleStats: [],
      trigger: {
        triggers: [],
        rawByKind: { click: 0, wheel: 0, 'move-pause': 0 },
        perHour: 100,
        perSegment: [],
        segmentsWithoutTrigger: 0,
        medianPerSegment: 0
      },
      uia: null,
      density: [],
      emptySegments: { count: 0, ms: 0, medianMs: 0 },
      activity: { activeMs: 0, coveredMs: 0, activeShare: 0, longest: [] },
      trailingIdleStart: null
    })
    expect(advice.some((line) => line.includes('按空闲断段'))).toBe(true)
  })

  it('指标正常时给出「可以定规则」的结论', () => {
    const advice = advise({
      session: { start: at(0), end: at(3_600_000), screen: null, titles: true },
      records: 0,
      badLines: 0,
      fgChanges: 0,
      titleChanges: 0,
      fgPerHour: 0,
      idleMs: 0,
      idleShare: 0,
      idleMarkers: { count: 0, medianMs: 0 },
      ruleStats: [],
      trigger: {
        triggers: [],
        rawByKind: { click: 0, wheel: 0, 'move-pause': 0 },
        perHour: 100,
        perSegment: [],
        segmentsWithoutTrigger: 0,
        medianPerSegment: 0
      },
      uia: null,
      density: [],
      emptySegments: { count: 0, ms: 0, medianMs: 0 },
      activity: { activeMs: 0, coveredMs: 0, activeShare: 0, longest: [] },
      trailingIdleStart: null
    })
    expect(advice[0]).toContain('下一步可以拿这份数据去定')
  })

  it('有 stop 记录时空闲时长已知，不再标「未知」', () => {
    const records: ProbeRecord[] = [fg(0, 1, 'a'), { type: 'idle', ts: at(60) }, { type: 'stop', ts: at(180) }]
    const report = buildReport(records, [])
    expect(report.trailingIdleStart).toBeNull()
    expect(report.idleShare).toBeCloseTo(120 / 180, 5)
    expect(formatReport(report)).not.toContain('采样结束时仍在空闲')
  })

  it('没有 stop 记录且最后一条是 idle 时，报告说明时长未知', () => {
    const records: ProbeRecord[] = [fg(0, 1, 'a'), { type: 'idle', ts: at(60) }]
    const report = buildReport(records, [])
    expect(report.trailingIdleStart).toBe(at(60))
    expect(formatReport(report)).toContain('采样结束时仍在空闲')
  })

  it('空闲结束（有 active）后不再算 trailing', () => {
    const records: ProbeRecord[] = [
      fg(0, 1, 'a'),
      { type: 'idle', ts: at(10) },
      { type: 'active', ts: at(70) },
      fg(71, 1, 'a')
    ]
    expect(trailingIdleStart(records)).toBeNull()
  })

  it('短样本会打上「不能当结论」的提示', () => {
    const text = formatReport(buildReport([fg(0, 1, 'a'), fg(60, 2, 'b')], []))
    expect(text).toContain('样本不足 10 分钟')
  })
})
