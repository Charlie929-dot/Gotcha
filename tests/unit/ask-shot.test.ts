import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASK_SHOT_RETENTION_MS,
  askShotsDir,
  isAskShotPath,
  pruneAskShots,
  saveAskShot
} from '../../src/main/ask-shot'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-ask-shot-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('ask-shot：选区截图的路径与留存', () => {
  it('saveAskShot 写到 ask-shots/shot-<ts>.png', () => {
    withTempDir((dir) => {
      const path = saveAskShot(dir, Buffer.from([1, 2, 3]), 1700000000000)
      expect(path).toBe(join(askShotsDir(dir), 'shot-1700000000000.png'))
    })
  })

  it('isAskShotPath：只认 ask-shots 下的 shot-<ts>.png', () => {
    withTempDir((dir) => {
      const good = join(askShotsDir(dir), 'shot-1700000000000.png')
      expect(isAskShotPath(dir, good)).toBe(true)
      // 目录外（哪怕文件名对）不认
      expect(isAskShotPath(dir, join(dir, 'shot-1700000000000.png'))).toBe(false)
      // 目录对、文件名不对不认
      expect(isAskShotPath(dir, join(askShotsDir(dir), 'frame-1.png'))).toBe(false)
      // 穿越
      expect(isAskShotPath(dir, join(askShotsDir(dir), '..', 'shot-1.png'))).toBe(false)
      expect(isAskShotPath(dir, '')).toBe(false)
    })
  })

  it('pruneAskShots：只删过期的 shot-*.png，别的一律不碰', () => {
    withTempDir((dir) => {
      const shots = askShotsDir(dir)
      mkdirSync(shots, { recursive: true })
      const now = 1_700_000_000_000
      const old = join(shots, 'shot-1600000000000.png')
      const fresh = join(shots, `shot-${now - 1000}.png`)
      const other = join(shots, 'keep-me.txt')
      writeFileSync(old, Buffer.from([1]))
      writeFileSync(fresh, Buffer.from([2]))
      writeFileSync(other, 'x')

      expect(pruneAskShots(dir, { now })).toBe(1)
      expect(pruneAskShots(dir, { now })).toBe(0)
      // 目录不存在 = 0（启动时经常还没截过图）
      expect(pruneAskShots(join(dir, 'nope'), { now })).toBe(0)
    })
  })

  it('留存期是 30 天', () => {
    expect(ASK_SHOT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
