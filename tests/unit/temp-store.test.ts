import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanStaleFrames, FRAME_FILE_PATTERN } from '../../src/capture/temp-store'

describe('cleanStaleFrames · 启动清理临时帧（F06）', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gotcha-tmp-'))
    dirs.push(dir)
    return dir
  }

  it('只删本应用的 frame-<ts>.png，目录里其它文件一律不动', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'frame-1698000000000.png'), 'x')
    writeFileSync(join(dir, 'frame-1698000000001.png'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'keep')
    writeFileSync(join(dir, 'frame-abc.png'), 'keep')

    expect(cleanStaleFrames(dir)).toEqual({ removed: 2, failed: 0 })
    expect(existsSync(join(dir, 'frame-1698000000000.png'))).toBe(false)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(existsSync(join(dir, 'frame-abc.png'))).toBe(true)
  })

  it('目录不存在时返回 0，不抛错（启动路径不被清理失败中断）', () => {
    const missing = join(tmpdir(), 'gotcha-definitely-missing', 'tmp')
    expect(cleanStaleFrames(missing)).toEqual({ removed: 0, failed: 0 })
  })

  it('文件名白名单不接受任意 png', () => {
    expect(FRAME_FILE_PATTERN.test('frame-1698000000000.png')).toBe(true)
    expect(FRAME_FILE_PATTERN.test('frame-1698000000000.PNG')).toBe(false)
    expect(FRAME_FILE_PATTERN.test('photo.png')).toBe(false)
    expect(FRAME_FILE_PATTERN.test('frame-1.jpg')).toBe(false)
  })
})
