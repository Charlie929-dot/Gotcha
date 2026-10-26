import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETENTION,
  containerName,
  jpegPathOf,
  planShotRetention,
  retentionScanBefore,
  tierForAge
} from '../../src/chain/retention'

/** 本地 2026-10-26 12:00 */
const NOW = new Date(2026, 9, 26, 12, 0, 0, 0).getTime()
const DAY = 86_400_000
const day = (days: number): number => Math.round(days * DAY)

describe('按年龄分层', () => {
  it('四个时间窗的边界：7 天 / 30 天 / 183 天', () => {
    expect(tierForAge(NOW, NOW)).toBe('hot')
    expect(tierForAge(NOW - day(6.99), NOW)).toBe('hot')
    expect(tierForAge(NOW - day(7), NOW)).toBe('warm')
    expect(tierForAge(NOW - day(29.99), NOW)).toBe('warm')
    expect(tierForAge(NOW - day(30), NOW)).toBe('cold')
    expect(tierForAge(NOW - day(182.99), NOW)).toBe('cold')
    expect(tierForAge(NOW - day(183), NOW)).toBe('archive')
  })

  it('未来时间（时钟回拨）算 hot，不抛错', () => {
    expect(tierForAge(NOW + day(2), NOW)).toBe('hot')
  })

  it('扫描上限 = 现在 - hot 天数（更年轻的只可能是待归一化的 PNG）', () => {
    expect(retentionScanBefore(NOW)).toBe(NOW - day(DEFAULT_RETENTION.hotDays))
  })
})

describe('一张证据该做什么', () => {
  it('hot 层已经是 JPEG：不动', () => {
    expect(planShotRetention({ ts: NOW - 1000, tier: 'hot', path: 'C:/shots/a.jpg' }, NOW)).toEqual({
      kind: 'keep'
    })
  })

  it('hot 层的 PNG（采集编码改 JPEG 之前的老行）：归一化成 hot JPEG', () => {
    expect(planShotRetention({ ts: NOW - 1000, tier: 'hot', path: 'C:/shots/a.png' }, NOW)).toEqual({
      kind: 'encode',
      tier: 'hot',
      encoding: DEFAULT_RETENTION.hot
    })
  })

  it('hot 的行过了 7 天：就地重编码到 warm（宽度封顶，不打包）', () => {
    expect(
      planShotRetention({ ts: NOW - day(8), tier: 'hot', path: 'C:/shots/a.jpg' }, NOW)
    ).toEqual({ kind: 'encode', tier: 'warm', encoding: DEFAULT_RETENTION.warm })
  })

  it('已经 warm 的行：不动（重复跑不会二次压缩）', () => {
    expect(planShotRetention({ ts: NOW - day(8), tier: 'warm', path: 'C:/shots/a.jpg' }, NOW)).toEqual({
      kind: 'keep'
    })
  })

  it('过了 30 天：重编码 + 打进 cold 容器', () => {
    expect(planShotRetention({ ts: NOW - day(40), tier: 'warm', path: 'C:/shots/a.jpg' }, NOW)).toEqual({
      kind: 'pack',
      tier: 'cold',
      encoding: DEFAULT_RETENTION.cold
    })
  })

  it('过了半年：重编码 + 打进 archive 容器', () => {
    expect(planShotRetention({ ts: NOW - day(200), tier: 'cold', path: null }, NOW)).toEqual({
      kind: 'pack',
      tier: 'archive',
      encoding: DEFAULT_RETENTION.archive
    })
  })

  it('不降级：时钟回拨算出更年轻的层时保持原样（证据已经压过，拿不回来）', () => {
    expect(planShotRetention({ ts: NOW - day(40), tier: 'archive', path: null }, NOW)).toEqual({
      kind: 'keep'
    })
  })

  it('缺文件也缺容器（坏行）：照常给出动作，由执行器记 failed、行不动', () => {
    expect(planShotRetention({ ts: NOW - day(40), tier: 'warm', path: null }, NOW)).toEqual({
      kind: 'pack',
      tier: 'cold',
      encoding: DEFAULT_RETENTION.cold
    })
  })
})

describe('路径与容器名', () => {
  it('PNG 换 JPEG，其它原样', () => {
    expect(jpegPathOf('C:/shots/a.png')).toBe('C:/shots/a.jpg')
    expect(jpegPathOf('C:/shots/a.PNG')).toBe('C:/shots/a.jpg')
    expect(jpegPathOf('C:/shots/a.jpg')).toBe('C:/shots/a.jpg')
  })

  it('一天一层一个容器', () => {
    expect(containerName('2026-10-26', 'cold')).toBe('2026-10-26-cold.cgar')
    expect(containerName('2026-10-26', 'archive')).toBe('2026-10-26-archive.cgar')
  })
})
