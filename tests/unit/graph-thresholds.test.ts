import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db'
import { setSetting } from '../../src/db/settings'
import {
  GRAPH_THRESHOLD_DEFAULTS,
  GRAPH_THRESHOLD_KEYS,
  parseThresholdPatch,
  readGraphThresholds
} from '../../src/understand/graph-thresholds'

describe('readGraphThresholds', () => {
  it('无库返回默认值（不建库）', () => {
    expect(readGraphThresholds(null)).toEqual(GRAPH_THRESHOLD_DEFAULTS)
  })

  it('从 settings 读回覆盖值；布尔/整数字段正确转型', () => {
    const db = openDatabase(':memory:')
    try {
      setSetting(db, GRAPH_THRESHOLD_KEYS.themeMergeSim, '0.97')
      setSetting(db, GRAPH_THRESHOLD_KEYS.themeSecondaryMax, '3')
      setSetting(db, GRAPH_THRESHOLD_KEYS.edgeTopK, '6')
      setSetting(db, GRAPH_THRESHOLD_KEYS.edgeMutual, '0')
      const value = readGraphThresholds(db)
      expect(value.themeMergeSim).toBe(0.97)
      expect(value.themeSecondaryMax).toBe(3)
      expect(value.edgeTopK).toBe(6)
      expect(value.edgeMutual).toBe(false)
      // 未覆盖的保持默认
      expect(value.edgeMinSim).toBe(GRAPH_THRESHOLD_DEFAULTS.edgeMinSim)
    } finally {
      db.close()
    }
  })

  it('脏值/越界只影响该键（回退默认），不抛错', () => {
    const db = openDatabase(':memory:')
    try {
      setSetting(db, GRAPH_THRESHOLD_KEYS.themeMergeSim, 'abc')
      setSetting(db, GRAPH_THRESHOLD_KEYS.themeDuplicateSim, '1.5')
      setSetting(db, GRAPH_THRESHOLD_KEYS.themeSecondaryMax, '2.5')
      setSetting(db, GRAPH_THRESHOLD_KEYS.edgeMinSim, '')
      const value = readGraphThresholds(db)
      expect(value.themeMergeSim).toBe(GRAPH_THRESHOLD_DEFAULTS.themeMergeSim)
      expect(value.themeDuplicateSim).toBe(GRAPH_THRESHOLD_DEFAULTS.themeDuplicateSim)
      expect(value.themeSecondaryMax).toBe(GRAPH_THRESHOLD_DEFAULTS.themeSecondaryMax)
      expect(value.edgeMinSim).toBe(GRAPH_THRESHOLD_DEFAULTS.edgeMinSim)
    } finally {
      db.close()
    }
  })
})

describe('parseThresholdPatch', () => {
  it('接受合法子集（含 edgeMutual 布尔/0/1）', () => {
    expect(parseThresholdPatch({ themeMergeSim: 0.97, edgeMutual: false })).toEqual({
      ok: true,
      patch: { themeMergeSim: 0.97, edgeMutual: false }
    })
    expect(parseThresholdPatch({ edgeMutual: 0 })).toEqual({ ok: true, patch: { edgeMutual: false } })
    expect(parseThresholdPatch({ edgeTopK: 6 })).toEqual({ ok: true, patch: { edgeTopK: 6 } })
  })

  it('未知键 / 越界 / 类型不符整单拒绝', () => {
    expect(parseThresholdPatch(null)).toMatchObject({ ok: false })
    expect(parseThresholdPatch({ nope: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('未知') })
    expect(parseThresholdPatch({ themeMergeSim: 2 })).toMatchObject({ ok: false })
    expect(parseThresholdPatch({ themeSecondaryMax: 1.5 })).toMatchObject({ ok: false })
    expect(parseThresholdPatch({ edgeMutual: 'yes' })).toMatchObject({ ok: false })
    expect(parseThresholdPatch({ edgeTopK: Number.NaN })).toMatchObject({ ok: false })
  })
})
