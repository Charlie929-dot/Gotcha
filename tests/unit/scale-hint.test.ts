/**
 * 「时刻过多」提示（P3-b）
 *
 * 口径：可见时刻数**超过**阈值才提示；阈值来自设置（默认 2k，抽屉可调）；
 * 「只看主题」时时刻层隐藏，不再提示。文案不推荐「收窄日期」——时间筛选只调暗、不删节点。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SCALE_HINT_MOMENTS, scaleHintText } from '../../src/renderer/graph/scale-hint'
import { DEFAULT_SCALE_HINT_MOMENTS as MAIN_DEFAULT } from '../../src/main/graph-settings'

describe('scaleHintText', () => {
  it('超过阈值才提示；等于 / 低于阈值都不提示', () => {
    expect(scaleHintText(2_001, 2_000, false)).toContain('2001 个时刻')
    expect(scaleHintText(2_000, 2_000, false)).toBeNull()
    expect(scaleHintText(1_047, 2_000, false)).toBeNull()
  })

  it('文案带出时刻数与阈值，且不推荐「收窄日期」（只调暗不删节点）', () => {
    const text = scaleHintText(3_500, 3_000, false)
    expect(text).toContain('3500 个时刻')
    expect(text).toContain('3000')
    expect(text).toContain('只看主题')
    expect(text).not.toContain('收窄时间范围')
  })

  it('「只看主题」时不提示（时刻层已隐藏）', () => {
    expect(scaleHintText(5_000, 2_000, true)).toBeNull()
  })

  it('非法输入不提示：负数 / 非数时刻、0 阈值', () => {
    expect(scaleHintText(-1, 2_000, false)).toBeNull()
    expect(scaleHintText(Number.NaN, 2_000, false)).toBeNull()
    expect(scaleHintText(5_000, 0, false)).toBeNull()
    expect(scaleHintText(5_000, Number.NaN, false)).toBeNull()
  })

  it('渲染层默认阈值 = 主进程设置默认值（2k，§12 口径）', () => {
    expect(DEFAULT_SCALE_HINT_MOMENTS).toBe(MAIN_DEFAULT)
    expect(DEFAULT_SCALE_HINT_MOMENTS).toBe(2_000)
  })
})
