/**
 * 检索耗时常驻指标（性能方案 §5.9 第 6 条，也是 §5.11 的复评门槛）。
 *
 * 之前只有 `chain ask loop: 检索较慢`（>100 ms 才记一条）这一种观测，事后答不了
 * 「这周 p95 是多少 / 有没有变慢 / 该不该上 trigram」。这里把 `search_info` 的**关键词路**
 * 按日累计进 settings：`stats.search.day.<yyyy-mm-dd>`（JSON）。
 *
 * 口径与红线：
 * - 只记次数、命中数、耗时分布（桶计数）——不存正文、不存关键词、不存段 id；
 * - 桶计数而不是原始样本：settings 是一个字符串，存分布就够回答 p50/p95/max；
 * - 写失败绝不能影响检索本身（调用方负责 try/catch，这里只管算与存）。
 */

import type { Db } from '../db'
import { getSetting, setSetting } from '../db/settings'

/**
 * 耗时桶的上界（毫秒，含）：≤50 / ≤100 / ≤200 / ≤500 / ≤1s / ≤2s / ≤5s / 更慢。
 *
 * 1 s 这条线是 §5.11 留的复评条件（`search_info` p95 > 1 s 才考虑倒排），
 * 所以桶边界与它对齐，别随手改成等距分箱。
 */
export const SEARCH_MS_BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000] as const
export const SEARCH_MS_BUCKET_COUNT = SEARCH_MS_BUCKETS.length + 1

export interface SearchMetricsSnapshot {
  /** 关键词路一共跑了几次（纯过滤 / 纯语义不在这里） */
  runs: number
  /** 正常回包次数 */
  ok: number
  /** 出错次数（含降级后仍失败） */
  errors: number
  /** 走了「worker 坏了退回主线程」的次数 */
  fallbacks: number
  /** 每路命中的段数之和（一次检索 3 个词各 5 条 = 15） */
  hits: number
  /** 累计耗时（毫秒；算均值用） */
  msTotal: number
  /** 单次最大耗时（毫秒） */
  msMax: number
  /** 桶计数，长度 = SEARCH_MS_BUCKET_COUNT；最后一桶是「> 5000 ms」 */
  buckets: number[]
}

export interface SearchSample {
  ms: number
  /** 这次检索命中的段数之和 */
  hits: number
  ok: boolean
  /** 是否走了主线程降级（worker 起不来 / 超时 / 崩了） */
  fallback?: boolean
}

/** 本地日期的 settings 键：stats.search.day.2026-10-28 */
export function searchMetricsKey(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `stats.search.day.${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function emptySearchMetrics(): SearchMetricsSnapshot {
  return {
    runs: 0,
    ok: 0,
    errors: 0,
    fallbacks: 0,
    hits: 0,
    msTotal: 0,
    msMax: 0,
    buckets: new Array<number>(SEARCH_MS_BUCKET_COUNT).fill(0)
  }
}

/** 耗时落在哪一桶：边界是「≤ 上界」，超过最后一档进溢出桶；非有限值当溢出（脏数据别混进 ≤50） */
export function searchBucketIndex(ms: number): number {
  if (!Number.isFinite(ms)) return SEARCH_MS_BUCKETS.length
  const value = Math.max(0, Math.round(ms))
  const index = SEARCH_MS_BUCKETS.findIndex((edge) => value <= edge)
  return index < 0 ? SEARCH_MS_BUCKETS.length : index
}

/** 累计一次样本（纯函数：返回新对象，不改入参） */
export function addSearchSample(
  snapshot: SearchMetricsSnapshot,
  sample: SearchSample
): SearchMetricsSnapshot {
  const ms = Number.isFinite(sample.ms) ? Math.max(0, Math.round(sample.ms)) : 0
  const buckets = [...snapshot.buckets]
  while (buckets.length < SEARCH_MS_BUCKET_COUNT) buckets.push(0)
  buckets[searchBucketIndex(ms)] += 1
  return {
    runs: snapshot.runs + 1,
    ok: snapshot.ok + (sample.ok ? 1 : 0),
    errors: snapshot.errors + (sample.ok ? 0 : 1),
    fallbacks: snapshot.fallbacks + (sample.fallback ? 1 : 0),
    hits: snapshot.hits + (Number.isFinite(sample.hits) ? Math.max(0, sample.hits) : 0),
    msTotal: snapshot.msTotal + ms,
    msMax: Math.max(snapshot.msMax, ms),
    buckets
  }
}

/**
 * p 分位的耗时估计：返回「p 分位所在桶的上界」；落在溢出桶（> 5000 ms）返回 null
 * （null 明确表示「比最后一档还慢」，别当成 0 用）。没有样本也返回 null。
 */
export function searchPercentileMs(snapshot: SearchMetricsSnapshot, p: number): number | null {
  if (snapshot.runs <= 0) return null
  const ratio = Math.min(Math.max(p, 0), 1)
  const target = Math.max(1, Math.ceil(snapshot.runs * ratio))
  let seen = 0
  for (let index = 0; index < SEARCH_MS_BUCKETS.length; index += 1) {
    seen += snapshot.buckets[index] ?? 0
    if (seen >= target) return SEARCH_MS_BUCKETS[index]
  }
  return null
}

/** 读回快照（缺键 / 坏 JSON / 字段类型不对都退回全 0，老库不会因此报错） */
export function parseSearchMetrics(raw: string | null | undefined): SearchMetricsSnapshot {
  const snapshot = emptySearchMetrics()
  if (!raw) return snapshot
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return snapshot
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return snapshot
  const record = parsed as Record<string, unknown>
  for (const field of ['runs', 'ok', 'errors', 'fallbacks', 'hits', 'msTotal', 'msMax'] as const) {
    const value = record[field]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      snapshot[field] = Math.round(value)
    }
  }
  const buckets = record.buckets
  if (Array.isArray(buckets)) {
    for (let index = 0; index < SEARCH_MS_BUCKET_COUNT; index += 1) {
      const value = buckets[index]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        snapshot.buckets[index] = Math.round(value)
      }
    }
  }
  return snapshot
}

export interface SearchMetricsStoreDeps {
  /** 取当日已存的 JSON（缺省返回 null） */
  read(key: string): string | null
  /** 写当日 JSON（同步；实现方按需包 try/catch） */
  write(key: string, value: string): void
  now?(): number
}

export interface SearchMetricsStore {
  /** 记一次关键词检索；写盘失败由 deps 决定，这里不吞错 */
  record(sample: SearchSample): void
  /** 当前累计（含本进程还没落盘的部分） */
  snapshot(): SearchMetricsSnapshot
}

/**
 * 按日累计的指标仓。跨日自动换键：第一次写新的一天时从库里读当日旧值（通常为空）。
 * 只缓存「当日」这一份，内存占用可以忽略。
 */
export function createSearchMetricsStore(deps: SearchMetricsStoreDeps): SearchMetricsStore {
  const now = deps.now ?? (() => Date.now())
  let key: string | null = null
  let current: SearchMetricsSnapshot = emptySearchMetrics()

  const ensureDay = (): void => {
    const nextKey = searchMetricsKey(now())
    if (nextKey === key) return
    key = nextKey
    current = parseSearchMetrics(deps.read(nextKey))
  }

  return {
    record(sample: SearchSample): void {
      ensureDay()
      current = addSearchSample(current, sample)
      deps.write(key as string, JSON.stringify(current))
    },
    snapshot(): SearchMetricsSnapshot {
      ensureDay()
      return { ...current, buckets: [...current.buckets] }
    }
  }
}

/** settings 里的当日快照（主进程注入连接；读失败按 0 处理） */
export function readSearchMetrics(db: Db, ts: number): SearchMetricsSnapshot {
  return parseSearchMetrics(getSetting(db, searchMetricsKey(ts)))
}
