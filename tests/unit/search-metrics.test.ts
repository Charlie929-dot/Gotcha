import { describe, expect, it } from 'vitest'
import {
  SEARCH_MS_BUCKET_COUNT,
  SEARCH_MS_BUCKETS,
  addSearchSample,
  createSearchMetricsStore,
  emptySearchMetrics,
  parseSearchMetrics,
  searchBucketIndex,
  searchMetricsKey,
  searchPercentileMs
} from '../../src/main/search-metrics'

describe('searchMetricsKey', () => {
  it('按本地日期落在 stats.search.day.<yyyy-mm-dd>', () => {
    const ts = new Date(2026, 9, 28, 23, 59, 0).getTime()
    expect(searchMetricsKey(ts)).toBe('stats.search.day.2026-10-28')
  })
})

describe('searchBucketIndex', () => {
  it('边界是「≤ 上界」：正好踩线的进本桶，多 1 ms 进下一桶', () => {
    expect(searchBucketIndex(0)).toBe(0)
    expect(searchBucketIndex(50)).toBe(0)
    expect(searchBucketIndex(51)).toBe(1)
    expect(searchBucketIndex(100)).toBe(1)
    expect(searchBucketIndex(1000)).toBe(SEARCH_MS_BUCKETS.indexOf(1000))
    expect(searchBucketIndex(5000)).toBe(SEARCH_MS_BUCKETS.length - 1)
  })

  it('超过最后一档进溢出桶；负数 / 非数字不炸', () => {
    expect(searchBucketIndex(5001)).toBe(SEARCH_MS_BUCKETS.length)
    expect(searchBucketIndex(-10)).toBe(0)
    expect(searchBucketIndex(Number.NaN)).toBe(SEARCH_MS_BUCKETS.length)
  })
})

describe('addSearchSample', () => {
  it('累计次数 / 命中 / 最大耗时，并把耗时记进对应桶（不改入参）', () => {
    const base = emptySearchMetrics()
    const once = addSearchSample(base, { ms: 120, hits: 7, ok: true })
    const twice = addSearchSample(once, { ms: 2400, hits: 0, ok: false, fallback: true })

    expect(base.runs).toBe(0)
    expect(once.runs).toBe(1)
    expect(twice.runs).toBe(2)
    expect(twice.ok).toBe(1)
    expect(twice.errors).toBe(1)
    expect(twice.fallbacks).toBe(1)
    expect(twice.hits).toBe(7)
    expect(twice.msTotal).toBe(2520)
    expect(twice.msMax).toBe(2400)
    expect(twice.buckets).toHaveLength(SEARCH_MS_BUCKET_COUNT)
    expect(twice.buckets[SEARCH_MS_BUCKETS.indexOf(200)]).toBe(1)
    expect(twice.buckets[SEARCH_MS_BUCKETS.indexOf(5000)]).toBe(1)
  })

  it('耗时缺失 / 负数按 0 计，不会把 msMax 拉坏', () => {
    const result = addSearchSample(emptySearchMetrics(), {
      ms: Number.NaN,
      hits: Number.NaN,
      ok: true
    })
    expect(result.msMax).toBe(0)
    expect(result.hits).toBe(0)
    expect(result.buckets[0]).toBe(1)
  })
})

describe('searchPercentileMs', () => {
  it('没有样本返回 null（不要当成 0）', () => {
    expect(searchPercentileMs(emptySearchMetrics(), 0.95)).toBeNull()
  })

  it('p95 落在样本真正所处的桶上', () => {
    let snapshot = emptySearchMetrics()
    // 95 次 120 ms + 5 次 1.2 s：p95 应落在 ≤200 那档（第 95 个样本仍是 120 ms）
    for (let index = 0; index < 95; index += 1) {
      snapshot = addSearchSample(snapshot, { ms: 120, hits: 1, ok: true })
    }
    for (let index = 0; index < 5; index += 1) {
      snapshot = addSearchSample(snapshot, { ms: 1200, hits: 1, ok: true })
    }
    expect(searchPercentileMs(snapshot, 0.95)).toBe(200)
    expect(searchPercentileMs(snapshot, 0.99)).toBe(2000)
    expect(searchPercentileMs(snapshot, 1)).toBe(2000)
  })

  it('溢出桶返回 null：明确表示「比 5000 ms 还慢」', () => {
    const snapshot = addSearchSample(emptySearchMetrics(), { ms: 9000, hits: 1, ok: true })
    expect(searchPercentileMs(snapshot, 0.95)).toBeNull()
  })
})

describe('parseSearchMetrics', () => {
  it('缺键 / 坏 JSON / 字段类型不对都退回全 0', () => {
    expect(parseSearchMetrics(null).runs).toBe(0)
    expect(parseSearchMetrics('not json').runs).toBe(0)
    const weird = parseSearchMetrics('{"runs":"9","buckets":[1,"x",3]}')
    expect(weird.runs).toBe(0)
    expect(weird.buckets[0]).toBe(1)
    expect(weird.buckets[1]).toBe(0)
    expect(weird.buckets[2]).toBe(3)
    expect(weird.buckets).toHaveLength(SEARCH_MS_BUCKET_COUNT)
  })

  it('roundtrip：写出去再读回来一致', () => {
    const snapshot = addSearchSample(emptySearchMetrics(), { ms: 300, hits: 4, ok: true })
    expect(parseSearchMetrics(JSON.stringify(snapshot))).toEqual(snapshot)
  })
})

describe('createSearchMetricsStore', () => {
  it('同一天累加写同一个键，并在已有值上继续加', () => {
    const writes: Array<{ key: string; value: string }> = []
    const store = createSearchMetricsStore({
      read: () => '{"runs":2,"ok":2,"errors":0,"fallbacks":0,"hits":3,"msTotal":40,"msMax":30,"buckets":[2,0,0,0,0,0,0,0]}',
      write: (key, value) => writes.push({ key, value }),
      now: () => new Date(2026, 9, 28, 10, 0, 0).getTime()
    })
    store.record({ ms: 90, hits: 5, ok: true })
    store.record({ ms: 700, hits: 1, ok: true })

    expect(writes).toHaveLength(2)
    expect(writes.every((item) => item.key === 'stats.search.day.2026-10-28')).toBe(true)
    const final = JSON.parse(writes[1].value)
    expect(final.runs).toBe(4)
    expect(final.hits).toBe(9)
    expect(final.msMax).toBe(700)
    expect(final.buckets[0]).toBe(2)
    expect(final.buckets[SEARCH_MS_BUCKETS.indexOf(100)]).toBe(1)
    expect(final.buckets[SEARCH_MS_BUCKETS.indexOf(1000)]).toBe(1)
  })

  it('跨日换键并从当日旧值起算', () => {
    let now = new Date(2026, 9, 28, 23, 59, 30).getTime()
    const writes: Array<{ key: string; value: string }> = []
    const store = createSearchMetricsStore({
      read: (key) =>
        key === 'stats.search.day.2026-10-29'
          ? '{"runs":1,"ok":1,"errors":0,"fallbacks":0,"hits":2,"msTotal":10,"msMax":10,"buckets":[1,0,0,0,0,0,0,0]}'
          : null,
      write: (key, value) => writes.push({ key, value }),
      now: () => now
    })
    store.record({ ms: 20, hits: 1, ok: true })
    now = new Date(2026, 9, 29, 0, 0, 1).getTime()
    store.record({ ms: 30, hits: 1, ok: true })

    expect(writes[0].key).toBe('stats.search.day.2026-10-28')
    expect(JSON.parse(writes[0].value).runs).toBe(1)
    expect(writes[1].key).toBe('stats.search.day.2026-10-29')
    expect(JSON.parse(writes[1].value).runs).toBe(2)
  })

  it('snapshot() 返回副本：外面改桶不会污染仓内状态', () => {
    const store = createSearchMetricsStore({
      read: () => null,
      write: () => undefined,
      now: () => new Date(2026, 9, 28, 10, 0, 0).getTime()
    })
    store.record({ ms: 10, hits: 1, ok: true })
    const snapshot = store.snapshot()
    snapshot.buckets[0] = 99
    expect(store.snapshot().buckets[0]).toBe(1)
  })
})
