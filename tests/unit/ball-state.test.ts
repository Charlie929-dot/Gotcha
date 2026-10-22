import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBallState, readBallState, writeBallState } from '../../src/main/ball-state'

let dir: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotcha-ball-state-'))
  statePath = join(dir, 'ball.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('parseBallState', () => {
  it('合法内容解析为规范结构', () => {
    expect(parseBallState('{"edge":"left","offset_ratio":0.25,"display_id":7}')).toEqual({
      edge: 'left',
      offset_ratio: 0.25,
      display_id: 7
    })
  })

  it('损坏 JSON 返回 null（回退默认位置，不抛错）', () => {
    expect(parseBallState('{not-json')).toBeNull()
  })

  it('缺字段 / 类型不对返回 null', () => {
    expect(parseBallState('{"edge":"left"}')).toBeNull()
    expect(parseBallState('{"edge":"left","offset_ratio":"0.5","display_id":1}')).toBeNull()
    expect(parseBallState('{"edge":"left","offset_ratio":0.5,"display_id":"1"}')).toBeNull()
  })

  it('未知边缘值返回 null', () => {
    expect(parseBallState('{"edge":"diagonal","offset_ratio":0.5,"display_id":1}')).toBeNull()
  })

  it('非有限比例返回 null；越界比例被夹紧', () => {
    expect(parseBallState('{"edge":"left","offset_ratio":null,"display_id":1}')).toBeNull()
    expect(parseBallState('{"edge":"left","offset_ratio":1.5,"display_id":1}')).toEqual({
      edge: 'left',
      offset_ratio: 1,
      display_id: 1
    })
  })
})

describe('readBallState', () => {
  it('文件不存在返回 null（空 userData 启动不建文件，A3 口径）', () => {
    expect(readBallState(statePath)).toBeNull()
    expect(existsSync(statePath)).toBe(false)
  })

  it('读回写入的内容', () => {
    writeBallState(statePath, { edge: 'bottom', offset_ratio: 0.6, display_id: 3 })
    expect(readBallState(statePath)).toEqual({ edge: 'bottom', offset_ratio: 0.6, display_id: 3 })
  })

  it('内容损坏返回 null', () => {
    writeFileSync(statePath, 'garbage')
    expect(readBallState(statePath)).toBeNull()
  })
})

describe('writeBallState', () => {
  it('原子写：落盘后不残留 .tmp 文件', () => {
    writeBallState(statePath, { edge: 'right', offset_ratio: 0.5, display_id: 1 })
    expect(existsSync(statePath)).toBe(true)
    expect(existsSync(`${statePath}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      edge: 'right',
      offset_ratio: 0.5,
      display_id: 1
    })
  })

  it('覆盖已有文件（重复拖动）', () => {
    writeBallState(statePath, { edge: 'right', offset_ratio: 0.5, display_id: 1 })
    writeBallState(statePath, { edge: 'top', offset_ratio: 0.9, display_id: 2 })
    expect(readBallState(statePath)).toEqual({ edge: 'top', offset_ratio: 0.9, display_id: 2 })
  })
})
