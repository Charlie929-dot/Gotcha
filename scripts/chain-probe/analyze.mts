/**
 * 信息链探针 · 分析器（Node 24 原生跑 TS，无需编译）
 *
 * 输入是 `scripts/chain-probe/collect.ps1` 与 `uia-probe.ps1` 产出的 JSONL，
 * 输出是「窗口占用段能不能切准」「截图触发有多密」「UIA 覆盖多少文本」的量化回答。
 * 口径见 `docs/chain-probe.md`。
 *
 * 用法：
 *   npm run chain-probe -- .tmp/chain-probe/collect-xxx.jsonl
 *   npm run chain-probe -- .tmp/chain-probe/collect-xxx.jsonl --uia .tmp/chain-probe/uia-xxx.jsonl
 *   npm run chain-probe -- .tmp/chain-probe/collect-xxx.jsonl --json
 *
 * 这个脚本不碰应用、不碰数据库、不出网：输入输出都是本地 JSONL / markdown。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface ProbeRecord {
  type: string
  ts: number
  pid?: number
  exe?: string
  title?: string
  hwnd?: number
  x?: number
  y?: number
  button?: string
  delta?: number
  idleMs?: number
}

/** 一条「这个窗口此刻是前台」的状态记录（fg 切换或标题变化） */
export interface WindowState {
  ts: number
  pid: number
  exe: string
  title: string
  hwnd: number
}

export interface IdleRange {
  start: number
  end: number
}

export interface SegmentRule {
  id: string
  label: string
  /** true：连同标题一起当身份（标题变化即切段）；false：只按进程合并 */
  byTitle: boolean
  /** 空闲超过这个时长就断开；0 表示不因空闲断开 */
  idleSplitMs: number
  /**
   * 走开之后又回到同一个窗口：接续成同一段，中间的空闲**不计入**占用时长。
   * 这就是拍板人的口径——走开不等于换了一件事，回来就还是那段经历。
   */
  mergeIdle?: boolean
  /** 接续的上限：离开超过这么久就另起一段（0 / 不填 = 无限接续） */
  mergeIdleGapMs?: number
}

/** 切分规则对比：段越碎，图谱上的「窗口球」越多，一段能承载的内容越少 */
export const SEGMENT_RULES: readonly SegmentRule[] = [
  { id: 'raw', label: '不合并：每次前台切换都切段', byTitle: true, idleSplitMs: 0 },
  { id: 'window', label: '同窗口（进程 + 标题）连续占用；空闲 > 60s 断开', byTitle: true, idleSplitMs: 60_000 },
  {
    id: 'window-idle-merge',
    label: '同窗口；空闲 > 60s 断开但走开回来接续（空闲不计入时长，最多接续 30 分钟）',
    byTitle: true,
    idleSplitMs: 60_000,
    mergeIdle: true,
    mergeIdleGapMs: 30 * 60_000
  },
  { id: 'app', label: '同应用（忽略标题）；空闲 > 60s 断开', byTitle: false, idleSplitMs: 60_000 }
]

export interface Segment {
  start: number
  end: number
  /** 有效占用时长（不含被排除的空闲） */
  ms: number
  /** 段内被排除的空闲时长（走开又回来的那部分） */
  idleMs: number
  pid: number
  exe: string
  title: string
}

export interface AppShare {
  exe: string
  ms: number
  count: number
}

export interface SegmentStats {
  id: string
  label: string
  segments: number
  coveredMs: number
  medianMs: number
  p90Ms: number
  longestMs: number
  under5s: number
  under5sShare: number
  over30min: number
  /** 段内被排除的空闲合计（接续规则才有） */
  excludedIdleMs: number
  perHour: number
  topApps: AppShare[]
}

export interface TriggerOptions {
  /** 指针停下多久算「移动后暂停」 */
  pauseMs: number
  /** 停下前至少要移动多少像素，避免微小抖动算一次 */
  moveDistancePx: number
  /** 两次截图之间的最小间隔（去重） */
  cooldownMs: number
}

export const DEFAULT_TRIGGER_OPTIONS: TriggerOptions = {
  pauseMs: 400,
  moveDistancePx: 40,
  cooldownMs: 2000
}

export type TriggerKind = 'click' | 'wheel' | 'move-pause'

export interface Trigger {
  ts: number
  kind: TriggerKind
}

export interface TriggerReport {
  triggers: Trigger[]
  rawByKind: Record<TriggerKind, number>
  perHour: number
  /** 每段触发次数（与段一一对应，按下标） */
  perSegment: number[]
  segmentsWithoutTrigger: number
  medianPerSegment: number
}

export interface UiaRecord {
  exe: string
  title: string
  ok: boolean
  timedOut: boolean
  elements: number
  withName: number
  chars: number
  password: number
  ms: number
  error: string | null
}

/** UIA 名字字符数低于这个值就算「基本没抓到内容」，需要 OCR 兜底 */
export const UIA_THIN_CHARS = 200

export interface UiaAppSummary {
  exe: string
  windows: number
  ok: number
  empty: number
  medianChars: number
}

export interface UiaSummary {
  windows: number
  ok: number
  failed: number
  timedOut: number
  empty: number
  thin: number
  rich: number
  passwordWindows: number
  medianChars: number
  medianMs: number
  perApp: UiaAppSummary[]
}

export interface SessionInfo {
  start: number
  end: number
  screen: [number, number] | null
  titles: boolean
}

export interface ProbeReport {
  session: SessionInfo
  records: number
  badLines: number
  fgChanges: number
  titleChanges: number
  fgPerHour: number
  idleMs: number
  idleShare: number
  ruleStats: SegmentStats[]
  trigger: TriggerReport
  /** 按密度下限筛选的影响（回答「能不能用密度筛段」） */
  density: DensityBucket[]
  /** 完全没有输入事件的段 */
  emptySegments: { count: number; ms: number; medianMs: number }
  /** 按「60 秒内无输入 = 空闲」重算的段内有效时长 */
  activity: {
    activeMs: number
    coveredMs: number
    activeShare: number
    longest: ReturnType<typeof longestSegmentsWithActivity>
  }
  uia: UiaSummary | null
  /** 采样结束时仍在空闲：起点 ts，时长未知 */
  trailingIdleStart: number | null
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/** 逐行解析 JSONL：坏行不抛错，计数后跳过（探针数据宁缺毋错） */
export function parseJsonl(text: string): { records: ProbeRecord[]; badLines: number } {
  const records: ProbeRecord[] = []
  let badLines = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as ProbeRecord).type === 'string') {
        records.push(parsed as ProbeRecord)
      } else {
        badLines++
      }
    } catch {
      badLines++
    }
  }
  return { records, badLines }
}

export function readSession(records: ProbeRecord[]): SessionInfo {
  const header = records.find((r) => r.type === 'session')
  const timed = records.filter((r) => typeof r.ts === 'number' && r.type !== 'session')
  const start = typeof header?.ts === 'number' ? header.ts : (timed[0]?.ts ?? 0)
  const end = timed.length > 0 ? Math.max(...timed.map((r) => r.ts)) : start
  const screen = Array.isArray((header as unknown as { screen?: unknown })?.screen)
    ? ((header as unknown as { screen: [number, number] }).screen)
    : null
  return {
    start,
    end,
    screen,
    titles: (header as unknown as { titles?: boolean })?.titles !== false
  }
}

/** fg / title 记录 → 窗口状态序列（同 ts 重复状态去掉，保证严格递增） */
export function buildStates(records: ProbeRecord[]): WindowState[] {
  const states: WindowState[] = []
  for (const record of records) {
    if (record.type !== 'fg' && record.type !== 'title') continue
    if (typeof record.ts !== 'number') continue
    const state: WindowState = {
      ts: record.ts,
      pid: typeof record.pid === 'number' ? record.pid : 0,
      exe: typeof record.exe === 'string' ? record.exe : '',
      title: typeof record.title === 'string' ? record.title : '',
      hwnd: typeof record.hwnd === 'number' ? record.hwnd : 0
    }
    const previous = states[states.length - 1]
    if (previous) {
      // 同一时刻重复上报：后到的覆盖前一条，不新增状态
      if (state.ts <= previous.ts) {
        states[states.length - 1] = state
        continue
      }
      // 同窗口同标题（hook 与轮询撞车）：合并
      if (state.pid === previous.pid && state.title === previous.title && record.type === 'title') continue
    }
    states.push(state)
  }
  return states
}

export function buildIdles(records: ProbeRecord[]): IdleRange[] {
  const ranges: IdleRange[] = []
  let open: number | null = null
  for (const record of records) {
    if (record.type === 'idle') {
      open = record.ts
    } else if (record.type === 'active' && open !== null) {
      ranges.push({ start: open, end: record.ts })
      open = null
    }
  }
  if (open !== null) {
    const last = records.reduce((max, r) => (typeof r.ts === 'number' && r.ts > max ? r.ts : max), open)
    ranges.push({ start: open, end: last })
  }
  return ranges
}

/**
 * 采样结束时是否仍处于空闲（最后一条记录就是 idle）。
 * 这种情况空闲时长**未知**——记录停了，不能用「最后一条记录」当结束时间。
 * 若采集器写了 `stop` 记录，说明结束时刻已知，不算未知。
 */
export function trailingIdleStart(records: ProbeRecord[]): number | null {
  let latest: ProbeRecord | null = null
  for (const record of records) {
    if (typeof record.ts !== 'number') continue
    if (!latest || record.ts > latest.ts) latest = record
  }
  if (!latest || latest.type !== 'idle') return null
  return latest.ts
}

/* ------------------------------------------------------------------ *
 * 切段
 * ------------------------------------------------------------------ */

export function keyOf(state: { pid: number; title: string }, rule: SegmentRule): string {
  return rule.byTitle ? `${state.pid}|${state.title}` : String(state.pid)
}

/**
 * 状态序列 → 窗口占用段。
 *
 * 段的边界只有两种来源：窗口状态变化（切换 / 标题变化）、空闲区间。
 * 相邻且身份相同的段合并；被空闲切开的段不合并（那正是「离开过」的证据）。
 */
export function buildSegments(
  states: WindowState[],
  idles: IdleRange[],
  rule: SegmentRule,
  sessionEnd: number
): Segment[] {
  if (states.length === 0) return []
  const segments: Segment[] = []

  for (let i = 0; i < states.length; i++) {
    const state = states[i]
    const next = states[i + 1]
    const end = next ? next.ts : sessionEnd
    if (end <= state.ts) continue

    // 按空闲区间切开（空闲中的那部分不算占用）
    const pieces: Array<[number, number]> = []
    let cursor = state.ts
    if (rule.idleSplitMs > 0) {
      for (const idle of idles) {
        if (idle.end <= cursor || idle.start >= end) continue
        const idleStart = Math.max(cursor, idle.start)
        if (idleStart > cursor) pieces.push([cursor, idleStart])
        cursor = Math.max(cursor, idle.end)
        if (cursor >= end) break
      }
    }
    if (cursor < end) pieces.push([cursor, end])

    for (const [start, pieceEnd] of pieces) {
      if (pieceEnd <= start) continue
      const key = keyOf(state, rule)
      const last = segments[segments.length - 1]
      const contiguous = last && last.end === start && keyOf(last, rule) === key
      if (last && contiguous) {
        // 同一身份、中间没有空隙：直接延长
        last.end = pieceEnd
        last.ms += pieceEnd - start
        continue
      }
      // 走开又回来：同一个窗口，中间那段是空闲 → 接续，空闲不计入占用时长
      const gap = last ? start - last.end : 0
      const gapIsIdle = last !== undefined && gap > 0 && isIdleCovered(idles, last.end, start)
      const withinCap = rule.mergeIdleGapMs === undefined || rule.mergeIdleGapMs <= 0 || gap <= rule.mergeIdleGapMs
      if (last && rule.mergeIdle && gapIsIdle && withinCap && keyOf(last, rule) === key) {
        last.end = pieceEnd
        last.ms += pieceEnd - start
        last.idleMs += gap
        continue
      }
      segments.push({
        start,
        end: pieceEnd,
        ms: pieceEnd - start,
        idleMs: 0,
        pid: state.pid,
        exe: state.exe,
        title: state.title
      })
    }
  }
  return segments
}

/** [from, to) 是否整段被空闲区间覆盖 */
function isIdleCovered(idles: IdleRange[], from: number, to: number): boolean {
  let cursor = from
  for (const idle of idles) {
    if (idle.end <= cursor) continue
    if (idle.start > cursor) return false
    cursor = Math.max(cursor, idle.end)
    if (cursor >= to) return true
  }
  return cursor >= to
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

export function summarizeSegments(
  segments: Segment[],
  rule: SegmentRule,
  sessionMs: number
): SegmentStats {
  const durations = segments.map((s) => s.ms)
  const coveredMs = durations.reduce((sum, ms) => sum + ms, 0)
  const under5s = durations.filter((ms) => ms < 5_000).length
  const over30min = durations.filter((ms) => ms >= 30 * 60_000).length

  const byApp = new Map<string, AppShare>()
  for (const segment of segments) {
    const key = segment.exe || '(unknown)'
    const entry = byApp.get(key) ?? { exe: key, ms: 0, count: 0 }
    entry.ms += segment.ms
    entry.count++
    byApp.set(key, entry)
  }
  const topApps = [...byApp.values()].sort((a, b) => b.ms - a.ms).slice(0, 5)

  return {
    id: rule.id,
    label: rule.label,
    segments: segments.length,
    coveredMs,
    medianMs: median(durations),
    p90Ms: percentile(durations, 0.9),
    longestMs: durations.length > 0 ? Math.max(...durations) : 0,
    under5s,
    under5sShare: segments.length > 0 ? under5s / segments.length : 0,
    over30min,
    excludedIdleMs: segments.reduce((sum, segment) => sum + segment.idleMs, 0),
    perHour: sessionMs > 0 ? (segments.length / sessionMs) * 3_600_000 : 0,
    topApps
  }
}

/* ------------------------------------------------------------------ *
 * 截图触发估算
 * ------------------------------------------------------------------ */

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * 事件流 → 截图触发点。
 *
 * 触发规则（与「事件点」口径一致）：左 / 右 / 中键按下、滚轮、以及「移动一段距离后停下」。
 * 最后一种只能在下一条事件到来时确认，所以末尾单独补一次；同类触发有冷却，避免连点刷屏。
 */
export function estimateTriggers(
  records: ProbeRecord[],
  options: TriggerOptions = DEFAULT_TRIGGER_OPTIONS,
  sessionEnd?: number
): { triggers: Trigger[]; rawByKind: Record<TriggerKind, number> } {
  const events = records
    .filter(
      (r) =>
        (r.type === 'move' || r.type === 'click' || r.type === 'wheel') &&
        typeof r.ts === 'number' &&
        typeof r.x === 'number' &&
        typeof r.y === 'number'
    )
    .sort((a, b) => a.ts - b.ts)

  const rawByKind: Record<TriggerKind, number> = { click: 0, wheel: 0, 'move-pause': 0 }
  const candidates: Trigger[] = []
  let pending: { ts: number; x: number; y: number; moved: number } | null = null

  const flushPause = (until: number): void => {
    if (!pending) return
    if (until - pending.ts >= options.pauseMs && pending.moved >= options.moveDistancePx) {
      rawByKind['move-pause']++
      candidates.push({ ts: pending.ts, kind: 'move-pause' })
    }
    pending = null
  }

  for (const event of events) {
    const point = { x: event.x as number, y: event.y as number }
    if (event.type === 'move') {
      if (!pending) {
        pending = { ts: event.ts, x: point.x, y: point.y, moved: 0 }
      } else {
        pending.moved += distance(point, pending)
        pending.x = point.x
        pending.y = point.y
        pending.ts = event.ts
      }
      continue
    }
    flushPause(event.ts)
    if (event.type === 'click') {
      rawByKind.click++
      candidates.push({ ts: event.ts, kind: 'click' })
    } else if (event.type === 'wheel') {
      rawByKind.wheel++
      candidates.push({ ts: event.ts, kind: 'wheel' })
    }
  }
  flushPause(sessionEnd ?? (candidates.length > 0 ? candidates[candidates.length - 1].ts : 0))

  const triggers: Trigger[] = []
  let lastTs = Number.NEGATIVE_INFINITY
  for (const candidate of candidates.sort((a, b) => a.ts - b.ts)) {
    if (candidate.ts - lastTs < options.cooldownMs) continue
    triggers.push(candidate)
    lastTs = candidate.ts
  }
  return { triggers, rawByKind }
}

export function summarizeTriggers(
  triggers: Trigger[],
  segments: Segment[],
  sessionMs: number
): TriggerReport {
  // 最后一段的结束时间就是最后一条记录的时刻，落在那一刻的触发也要算进这一段
  const perSegment = segments.map((segment, index) => {
    const isLast = index === segments.length - 1
    return triggers.filter(
      (trigger) => trigger.ts >= segment.start && (isLast ? trigger.ts <= segment.end : trigger.ts < segment.end)
    ).length
  })
  return {
    triggers,
    rawByKind: { click: 0, wheel: 0, 'move-pause': 0 },
    perHour: sessionMs > 0 ? (triggers.length / sessionMs) * 3_600_000 : 0,
    perSegment,
    segmentsWithoutTrigger: perSegment.filter((count) => count === 0).length,
    medianPerSegment: median(perSegment)
  }
}

/* ------------------------------------------------------------------ *
 * 事件密度（能不能用密度筛段）
 * ------------------------------------------------------------------ */

/** 参与密度计算的输入事件类型 */
const INPUT_TYPES = new Set(['move', 'click', 'wheel'])

export function inputTimestamps(records: ProbeRecord[]): number[] {
  return records
    .filter((r) => INPUT_TYPES.has(r.type) && typeof r.ts === 'number')
    .map((r) => r.ts)
    .sort((a, b) => a - b)
}

/** 段内事件数 / 分钟（段长按分钟折算；零长度算 0） */
export function segmentDensity(events: number, ms: number): number {
  if (ms <= 0) return 0
  return events / (ms / 60_000)
}

export interface DensityBucket {
  /** 密度下限（次/分钟） */
  minPerMinute: number
  segments: number
  coveredMs: number
  /** 保留的段数占全部段数的比例 */
  keptSegmentShare: number
  /** 保留的时长占全部段时长的比例 */
  keptTimeShare: number
}

/**
 * 密度筛选的影响：给定若干个密度下限，算各自留下多少段、多少时长。
 * 用来回答「用密度筛段会不会把有内容的段一起筛掉」。
 */
export function densityImpact(
  segments: Segment[],
  records: ProbeRecord[],
  thresholds: readonly number[] = [0, 0.5, 1, 2, 5]
): DensityBucket[] {
  const times = inputTimestamps(records)
  const totalMs = segments.reduce((sum, segment) => sum + segment.ms, 0)
  const rows: Array<{ segment: Segment; events: number; density: number }> = segments.map((segment) => {
    const events = countInRange(times, segment.start, segment.end)
    return { segment, events, density: segmentDensity(events, segment.ms) }
  })

  return thresholds.map((minPerMinute) => {
    const kept = rows.filter((row) => row.density >= minPerMinute)
    const coveredMs = kept.reduce((sum, row) => sum + row.segment.ms, 0)
    return {
      minPerMinute,
      segments: kept.length,
      coveredMs,
      keptSegmentShare: segments.length > 0 ? kept.length / segments.length : 0,
      keptTimeShare: totalMs > 0 ? coveredMs / totalMs : 0
    }
  })
}

/** 落在 [start, end) 的事件数；end 是最后一段时用 <= */
function countInRange(times: number[], start: number, end: number): number {
  let count = 0
  for (const ts of times) {
    if (ts < start) continue
    if (ts >= end) break
    count++
  }
  return count
}

/**
 * 「操作次数」：把连续输入合并成一次操作。
 *
 * 原始事件数**不能**当密度用——它取决于钩子的抽稀步长（`-MoveStepPx 4` 时一段能刷出
 * 1000+ 事件/分钟，改成 8px 就少一半）。所以任何要写进设置、要放进滑块的阈值，
 * 都必须落在这个稳定单位上：两次输入间隔 ≥ `gapMs` 才算新的一次操作。
 */
export function inputTouches(records: ProbeRecord[], gapMs = 1000): number[] {
  const times = inputTimestamps(records)
  const touches: number[] = []
  let last = Number.NEGATIVE_INFINITY
  for (const ts of times) {
    if (ts - last >= gapMs) touches.push(ts)
    last = ts
  }
  return touches
}

/** 段内的操作次数（按 inputTouches 口径） */
export function countTouchesInRange(touches: number[], start: number, end: number, isLast: boolean): number {
  let count = 0
  for (const ts of touches) {
    if (ts < start) continue
    if (ts > end || (ts === end && !isLast)) break
    count++
  }
  return count
}

/** 零事件段（密度为 0）统计 */
export function emptySegments(segments: Segment[], records: ProbeRecord[]): { count: number; ms: number; medianMs: number } {
  const times = inputTimestamps(records)
  const empty = segments.filter((segment) => countInRange(times, segment.start, segment.end) === 0)
  return {
    count: empty.length,
    ms: empty.reduce((sum, segment) => sum + segment.ms, 0),
    medianMs: median(empty.map((segment) => segment.ms))
  }
}

/* ------------------------------------------------------------------ *
 * 局部活跃度：「60 秒内没有输入 = 空闲」
 * ------------------------------------------------------------------ */

export interface ActivityProfile {
  totalMs: number
  /** 「最近 idleGapMs 内有输入」的时长 */
  activeMs: number
  activeShare: number
  /** 段内按分钟切，零事件的分桶数 */
  emptyMinutes: number
  minutes: number
}

/**
 * 段内有效时长：每个输入事件把它之后的 `idleGapMs` 算作「有人在操作」，合并重叠。
 *
 * 这正是「60 秒内无任何输入 = 空闲」的口径，比段内平均密度靠谱——
 * 长段可以把几秒密集操作和几分钟静止平均成中等密度，看不出中间的空白。
 */
export function activityProfile(
  segment: Segment,
  times: number[],
  idleGapMs = 60_000
): ActivityProfile {
  const totalMs = segment.ms
  const ranges: Array<[number, number]> = []
  for (const ts of times) {
    if (ts < segment.start) continue
    if (ts >= segment.end) break
    const from = Math.max(segment.start, ts)
    const to = Math.min(segment.end, ts + idleGapMs)
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1]) {
      last[1] = Math.max(last[1], to)
    } else {
      ranges.push([from, to])
    }
  }
  const activeMs = ranges.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0)

  // 按分钟分桶统计「这一分钟里有没有事件」
  const minutes = Math.max(1, Math.ceil(totalMs / 60_000))
  const perMinute = new Array<number>(minutes).fill(0)
  for (const ts of times) {
    if (ts < segment.start) continue
    if (ts >= segment.end) break
    const index = Math.min(minutes - 1, Math.floor((ts - segment.start) / 60_000))
    perMinute[index]++
  }

  return {
    totalMs,
    activeMs,
    activeShare: totalMs > 0 ? activeMs / totalMs : 0,
    emptyMinutes: perMinute.filter((count) => count === 0).length,
    minutes
  }
}

/** 全部段的「有效时长」合计（60 秒无输入 = 空闲） */
export function summarizeActivity(
  segments: Segment[],
  records: ProbeRecord[],
  idleGapMs = 60_000
): {
  activeMs: number
  coveredMs: number
  activeShare: number
  longest: ReturnType<typeof longestSegmentsWithActivity>
} {
  const times = inputTimestamps(records)
  let activeMs = 0
  let coveredMs = 0
  for (const segment of segments) {
    coveredMs += segment.ms
    activeMs += activityProfile(segment, times, idleGapMs).activeMs
  }
  return {
    activeMs,
    coveredMs,
    activeShare: coveredMs > 0 ? activeMs / coveredMs : 0,
    longest: longestSegmentsWithActivity(segments, records, 5, idleGapMs)
  }
}

/** 最长的几个段 + 各自的活跃度（报告里只看前几个，多了没必要） */
export function longestSegmentsWithActivity(
  segments: Segment[],
  records: ProbeRecord[],
  top = 5,
  idleGapMs = 60_000
): Array<{
  segment: Segment
  events: number
  touches: number
  density: number
  touchRate: number
  activity: ActivityProfile
}> {
  const times = inputTimestamps(records)
  const touches = inputTouches(records)
  return [...segments]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, top)
    .map((segment) => {
      const events = countInRange(times, segment.start, segment.end)
      const touchCount = countTouchesInRange(touches, segment.start, segment.end, false)
      return {
        segment,
        events,
        touches: touchCount,
        density: segmentDensity(events, segment.ms),
        touchRate: segmentDensity(touchCount, segment.ms),
        activity: activityProfile(segment, times, idleGapMs)
      }
    })
}


/* ------------------------------------------------------------------ *
 * UIA 覆盖
 * ------------------------------------------------------------------ */

export function toUiaRecords(records: ProbeRecord[]): UiaRecord[] {
  const output: UiaRecord[] = []
  for (const record of records) {
    if (record.type !== 'uia') continue
    const raw = record as unknown as Record<string, unknown>
    output.push({
      exe: typeof raw.exe === 'string' ? raw.exe : '(unknown)',
      title: typeof raw.title === 'string' ? raw.title : '',
      ok: raw.ok === true,
      timedOut: raw.timedOut === true,
      elements: typeof raw.elements === 'number' ? raw.elements : 0,
      withName: typeof raw.withName === 'number' ? raw.withName : 0,
      chars: typeof raw.chars === 'number' ? raw.chars : 0,
      password: typeof raw.password === 'number' ? raw.password : 0,
      ms: typeof raw.ms === 'number' ? raw.ms : 0,
      error: typeof raw.error === 'string' ? raw.error : null
    })
  }
  return output
}

export function summarizeUia(records: UiaRecord[]): UiaSummary | null {
  if (records.length === 0) return null
  const ok = records.filter((r) => r.ok)
  const empty = ok.filter((r) => r.chars === 0)
  const thin = ok.filter((r) => r.chars > 0 && r.chars < UIA_THIN_CHARS)
  const rich = ok.filter((r) => r.chars >= UIA_THIN_CHARS)

  const byApp = new Map<string, UiaRecord[]>()
  for (const record of records) {
    const key = record.exe || '(unknown)'
    const list = byApp.get(key) ?? []
    list.push(record)
    byApp.set(key, list)
  }
  const perApp: UiaAppSummary[] = [...byApp.entries()]
    .map(([exe, list]) => ({
      exe,
      windows: list.length,
      ok: list.filter((r) => r.ok).length,
      empty: list.filter((r) => r.ok && r.chars === 0).length,
      medianChars: median(list.filter((r) => r.ok).map((r) => r.chars))
    }))
    .sort((a, b) => b.windows - a.windows)

  return {
    windows: records.length,
    ok: ok.length,
    failed: records.length - ok.length - records.filter((r) => r.timedOut).length,
    timedOut: records.filter((r) => r.timedOut).length,
    empty: empty.length,
    thin: thin.length,
    rich: rich.length,
    passwordWindows: records.filter((r) => r.password > 0).length,
    medianChars: median(ok.map((r) => r.chars)),
    medianMs: median(records.map((r) => r.ms)),
    perApp
  }
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

export function buildReport(
  collectRecords: ProbeRecord[],
  uiaRecords: UiaRecord[],
  badLines = 0
): ProbeReport {
  const session = readSession(collectRecords)
  const sessionMs = Math.max(0, session.end - session.start)
  const states = buildStates(collectRecords)
  const idles = buildIdles(collectRecords)
  const idleMs = idles.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0)

  const ruleStats = SEGMENT_RULES.map((rule) =>
    summarizeSegments(buildSegments(states, idles, rule, session.end), rule, sessionMs)
  )

  const primaryRule = SEGMENT_RULES.find((rule) => rule.id === 'window') ?? SEGMENT_RULES[1]
  const primary = buildSegments(states, idles, primaryRule, session.end)
  const { triggers, rawByKind } = estimateTriggers(collectRecords, DEFAULT_TRIGGER_OPTIONS, session.end)
  const trigger = summarizeTriggers(triggers, primary, sessionMs)
  trigger.rawByKind = rawByKind

  return {
    session,
    records: collectRecords.length,
    badLines,
    fgChanges: collectRecords.filter((r) => r.type === 'fg').length,
    titleChanges: collectRecords.filter((r) => r.type === 'title').length,
    fgPerHour: sessionMs > 0 ? (collectRecords.filter((r) => r.type === 'fg').length / sessionMs) * 3_600_000 : 0,
    idleMs,
    idleShare: sessionMs > 0 ? idleMs / sessionMs : 0,
    ruleStats,
    trigger,
    density: densityImpact(primary, collectRecords),
    emptySegments: emptySegments(primary, collectRecords),
    activity: summarizeActivity(primary, collectRecords),
    uia: summarizeUia(uiaRecords),
    trailingIdleStart: trailingIdleStart(collectRecords)
  }
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, '0')}s`
  return `${secs}s`
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

/** 段标题在表里只留前 24 字，避免撑破表格 */
function truncateLabel(title: string): string {
  const clean = title.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
  if (!clean) return '(无标题)'
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
}

export function formatReport(report: ProbeReport): string {
  const lines: string[] = []
  const session = report.session
  const sessionMs = Math.max(0, session.end - session.start)

  lines.push('# 信息链探针报告')
  lines.push('')
  if (sessionMs < 10 * 60_000) {
    lines.push('> ⚠ 样本不足 10 分钟：比率类指标（段/小时、触发/小时）会被放大，只能看趋势，不能当结论。至少跑 20 分钟再判读。')
    lines.push('')
  }
  lines.push(`- 采样时长：${seconds(sessionMs)}；记录 ${report.records} 条（坏行 ${report.badLines}）`)
  lines.push(`- 前台切换 ${report.fgChanges} 次（${report.fgPerHour.toFixed(1)}/小时）；标题变化 ${report.titleChanges} 次`)
  lines.push(`- 空闲占比：${percent(report.idleShare)}（${seconds(report.idleMs)}）`)
  if (report.trailingIdleStart !== null) {
    const offset = seconds(Math.max(0, report.trailingIdleStart - session.start))
    lines.push(`- 采样结束时仍在空闲（开始于 +${offset}）：这段时长未知，未计入空闲占比`)
  }
  lines.push('')

  lines.push('## 1. 窗口占用段：四种切法的对比')
  lines.push('')
  lines.push('| 规则 | 段数 | 中位时长 | P90 | 最长 | <5s 占比 | ≥30min | 段/小时 |')
  lines.push('| - | -: | -: | -: | -: | -: | -: | -: |')
  for (const stat of report.ruleStats) {
    lines.push(
      `| ${stat.label} | ${stat.segments} | ${seconds(stat.medianMs)} | ${seconds(stat.p90Ms)} | ${seconds(stat.longestMs)} | ${percent(stat.under5sShare)} | ${stat.over30min} | ${stat.perHour.toFixed(1)} |`
    )
  }
  lines.push('')
  const mergedIdle = report.ruleStats.find((stat) => stat.excludedIdleMs > 0)
  if (mergedIdle) {
    lines.push(
      `接续规则（走开回来算同一段）下，从段内排除的空闲合计 **${seconds(mergedIdle.excludedIdleMs)}**——这些时间不属于任何窗口占用；探针只做减法，空闲段本身由采集侧记录。`
    )
    lines.push('')
  }
  lines.push('判读：中位时长在分钟级、<5s 占比低，才适合当「一段窗口记忆」；如果 <5s 占三成以上，说明按标题切会把一段经历切碎。')
  lines.push('')

  lines.push('## 2. 截图触发密度（按「同窗口」规则）')
  lines.push('')
  lines.push(`- 触发点 ${report.trigger.triggers.length} 个，${report.trigger.perHour.toFixed(1)}/小时`)
  lines.push(
    `- 原始计数：点击 ${report.trigger.rawByKind.click}、滚轮 ${report.trigger.rawByKind.wheel}、移动后暂停 ${report.trigger.rawByKind['move-pause']}（冷却 2s 前去重）`
  )
  lines.push(
    `- 每段触发数中位 ${report.trigger.medianPerSegment}；没有任何触发的段 ${report.trigger.segmentsWithoutTrigger} 个（占比 ${percent(
      report.trigger.perSegment.length > 0 ? report.trigger.segmentsWithoutTrigger / report.trigger.perSegment.length : 0
    )}）`
  )
  lines.push('')
  lines.push('判读：无触发的段意味着这一段没有证据截图，AI 只能靠内容判断、无法精确定位到某一帧。')
  lines.push('')

  lines.push('## 3. 事件密度：能不能用它筛段')
  lines.push('')
  lines.push(
    `- 按「60 秒内无任何输入 = 空闲」重算：段内有效时长 ${seconds(report.activity.activeMs)} / ${seconds(report.activity.coveredMs)}（**${percent(report.activity.activeShare)}**）`
  )
  lines.push(
    `- 完全没有输入事件的段：${report.emptySegments.count} 个（共 ${seconds(report.emptySegments.ms)}，中位 ${seconds(report.emptySegments.medianMs)}）`
  )
  lines.push('')
  if (report.activity.longest.length > 0) {
    lines.push('| 段（按长度取前 5） | 时长 | 原始事件 | 操作次数 | 操作/分钟 | 有输入的时长 | 有效占比 | 空转分钟 |')
    lines.push('| - | -: | -: | -: | -: | -: | -: | -: |')
    for (const row of report.activity.longest) {
      lines.push(
        `| ${row.segment.exe} · ${truncateLabel(row.segment.title)} | ${seconds(row.segment.ms)} | ${row.events} | ${row.touches} | ${row.touchRate.toFixed(1)} | ${seconds(row.activity.activeMs)} | ${percent(row.activity.activeShare)} | ${row.activity.emptyMinutes}/${row.activity.minutes} |`
      )
    }
    lines.push('')
  }
  lines.push('| 密度下限（段内平均，次/分钟） | 保留段数 | 段数占比 | 时长占比 |')
  lines.push('| -: | -: | -: | -: |')
  for (const bucket of report.density) {
    lines.push(
      `| ≥${bucket.minPerMinute} | ${bucket.segments} | ${percent(bucket.keptSegmentShare)} | ${percent(bucket.keptTimeShare)} |`
    )
  }
  lines.push('')
  lines.push(
    '判读：**看平均密度会得出假结论**——长时间段能把「几秒密集操作 + 几分钟不动」平均成中等密度，两轮实测里密度 ≥0.5 就几乎筛不掉任何时长。真正有区分度的是局部口径：段内「60 秒内有输入」的时长占比。'
  )
  lines.push('')
  lines.push(
    '**阈值要落在稳定单位上**：原始事件数取决于钩子的抽稀步长（`-MoveStepPx 4` 时一段能刷出上千个事件/分钟，改成 8px 就少一半），所以写进设置、放进滑块的应该是「操作次数」（两次输入间隔 ≥1 秒算新的一次）而不是原始事件数。'
  )
  lines.push('')
  lines.push(
    '所以密度适合做**显示优先级 / 段内切分**（哪几段值得先画、哪一段中间是空转），不适合当「这段记忆要不要留」的判据——读长文、看视频时鼠标可以静止很久，而键盘输入压根不产生鼠标事件。留存判据只能是「任何输入都没有」（`GetLastInputInfo`，含键鼠）。'
  )
  lines.push('')

  if (report.uia) {
    const uia = report.uia
    lines.push('## 4. UIA 覆盖率')
    lines.push('')
    lines.push(`- 探测窗口 ${uia.windows} 个：成功 ${uia.ok}、无输出/抛错 ${uia.failed}、超时 ${uia.timedOut}`)
    lines.push(
      `- 文本量：为 0 ${uia.empty} 个、<${UIA_THIN_CHARS} 字 ${uia.thin} 个、≥${UIA_THIN_CHARS} 字 ${uia.rich} 个；中位 ${uia.medianChars} 字`
    )
    lines.push(`- 含密码控件的窗口 ${uia.passwordWindows} 个；单窗口耗时中位 ${uia.medianMs}ms`)
    lines.push('')
    if (uia.perApp.length > 0) {
      lines.push('| 应用 | 窗口数 | 成功 | 无文本 | 文本中位 |')
      lines.push('| - | -: | -: | -: | -: |')
      for (const app of uia.perApp.slice(0, 15)) {
        lines.push(`| ${app.exe} | ${app.windows} | ${app.ok} | ${app.empty} | ${app.medianChars} |`)
      }
      lines.push('')
    }
    lines.push('判读：无文本窗口必须走 OCR 兜底；有文本但很薄的，说明 UIA 只拿到了标题栏一类外层信息。')
    lines.push('')
  }

  lines.push('## 5. 建议')
  lines.push('')
  for (const advice of advise(report)) lines.push(`- ${advice}`)
  lines.push('')
  return lines.join('\n')
}

/** 基于数字给出的下一步建议（不改验收标准，只做判读辅助） */
export function advise(report: ProbeReport): string[] {
  const advice: string[] = []
  const raw = report.ruleStats.find((stat) => stat.id === 'raw')
  const window = report.ruleStats.find((stat) => stat.id === 'window')
  const app = report.ruleStats.find((stat) => stat.id === 'app')

  if (raw && raw.under5sShare > 0.3) {
    advice.push(
      `前台切换里有 ${percent(raw.under5sShare)} 是 <5s 的一瞥（切窗口看一眼就又走了）：切段规则要能把这些并进相邻段，否则图谱上全是碎球。`
    )
  }
  if (report.idleShare > 0.3) {
    advice.push(
      `空闲占 ${percent(report.idleShare)}：不按空闲断段的话，一段「窗口占用」会把离开的十几分钟也算进去，内容和时长都会失真。`
    )
  }
  if (window && app && app.segments <= window.segments) {
    advice.push(
      `标题几乎不影响段数（同窗口 ${window.segments} 段 / 同应用 ${app.segments} 段）：标题更适合当段内属性，而不是段的身份。`
    )
  } else if (window && app && app.segments > 0 && window.segments > app.segments * 1.5) {
    advice.push(
      `忽略标题能把段数从 ${window.segments} 降到 ${app.segments}：标题变化多半是同一段内容里的页面跳转。`
    )
  }
  if (window && window.medianMs < 60_000) {
    advice.push(`同窗口规则的中位时长只有 ${seconds(window.medianMs)}：一段记忆太短，双链和内容摘要都没有足够材料。`)
  }
  if (report.trigger.perHour > 300) {
    advice.push(`触发点 ${report.trigger.perHour.toFixed(0)}/小时偏密：截图存储和 AI 核验都会被拖重，需要提高冷却或只在内容变化时截图。`)
  }
  if (report.trigger.perHour > 0 && report.trigger.perHour < 20) {
    advice.push(`触发点只有 ${report.trigger.perHour.toFixed(0)}/小时：证据可能不够密，回查时容易找不到对应的那一帧。`)
  }
  if (report.uia && report.uia.windows > 0) {
    const emptyShare = report.uia.empty / Math.max(1, report.uia.ok)
    if (emptyShare > 0.3) {
      advice.push(`${percent(emptyShare)} 的窗口 UIA 拿不到文本：OCR 兜底不是可选项，是主路径之一。`)
    }
  }
  if (advice.length === 0) advice.push('各项指标都在合理区间，下一步可以拿这份数据去定窗口段的正式切分规则。')
  const onePerMinute = report.density.find((bucket) => bucket.minPerMinute === 1)
  if (onePerMinute && onePerMinute.keptTimeShare < 0.7) {
    advice.push(
      `密度 ≥1 次/分钟只留下 ${percent(onePerMinute.keptTimeShare)} 的时长：被筛掉的多半是阅读 / 观看这类「有内容但不动鼠标」的段，密度只能用来决定画布上显示什么，不能当留存判据。`
    )
  }
  return advice
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function printUsage(): void {
  console.error('用法：npm run chain-probe -- <collect.jsonl> [--uia <uia.jsonl>] [--json] [--out <file.md>]')
}

/** Windows 下 argv 是反斜杠、URL 是正斜杠，比较前统一 */
function normalizePath(path: string): string {
  const resolved = path.replace(/\\/g, '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function runCli(argv: string[]): number {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage()
    return args.length === 0 ? 2 : 0
  }

  const uiaIndex = args.indexOf('--uia')
  const uiaPath = uiaIndex >= 0 ? args[uiaIndex + 1] : undefined
  const outIndex = args.indexOf('--out')
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined
  const asJson = args.includes('--json')
  // 只有真的出现了这个选项，它的值才需要跳过（否则 -1 + 1 = 0 会把采集文件也吃掉）
  const flagValues = new Set<number>()
  if (uiaIndex >= 0) flagValues.add(uiaIndex + 1)
  if (outIndex >= 0) flagValues.add(outIndex + 1)
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !flagValues.has(index))
  const collectPath = positional[0]
  if (!collectPath) {
    printUsage()
    return 2
  }

  let collectRecords: ProbeRecord[]
  let badLines = 0
  try {
    const parsed = parseJsonl(readFileSync(collectPath, 'utf8'))
    collectRecords = parsed.records
    badLines = parsed.badLines
  } catch (error) {
    console.error(`读不了采集文件：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  let uiaRecords: UiaRecord[] = []
  if (uiaPath) {
    try {
      uiaRecords = toUiaRecords(parseJsonl(readFileSync(uiaPath, 'utf8')).records)
    } catch (error) {
      console.error(`读不了 UIA 文件：${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  const report = buildReport(collectRecords, uiaRecords, badLines)
  const text = asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`
  if (outPath) {
    writeFileSync(outPath, text, 'utf8')
    console.error(`已写报告：${outPath}`)
  } else {
    process.stdout.write(text)
  }
  return 0
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  normalizePath(invokedPath) === normalizePath(fileURLToPath(import.meta.url))
) {
  process.exitCode = runCli(process.argv)
}
