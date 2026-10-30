/**
 * 家谱（memory-life M1）：缺省创建 / 原子写 + .bak / 损坏备份重建 / 结构校验。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  emptyLineage,
  ensureLineage,
  lineageSnapshot,
  LINEAGE_LIFE_TOKENS,
  parseLineage,
  readLineage,
  writeLineage
} from '../../src/main/lineage'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-lineage-'))
  dirs.push(dir)
  return join(dir, 'memory-lineage.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('家谱', () => {
  it('文件不存在时建第一代 default，并写下文件', async () => {
    const file = tempFile()
    const result = await ensureLineage(file, { now: 1000 })
    expect(result.created).toBe(true)
    expect(result.recovered).toBe(false)
    expect(result.lineage.active).toBe('default')
    expect(result.lineage.life_tokens).toBe(LINEAGE_LIFE_TOKENS)
    expect(result.lineage.generations).toEqual([
      expect.objectContaining({ id: 'gen-1', branch: 'default', nickname: 'default', mother: null, born_at: 1000 })
    ])
    expect(result.lineage.branches).toEqual([
      expect.objectContaining({ branch: 'default', generation: 'gen-1', parent: null, status: 'alive' })
    ])
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('写入再读回一致；第二次写留一份 .bak', async () => {
    const file = tempFile()
    const first = emptyLineage(1000)
    expect(await writeLineage(file, first)).toBe(true)
    const second = {
      ...first,
      active: 'spring',
      branches: [
        ...first.branches,
        { branch: 'spring', generation: 'gen-1', parent: 'default', created_at: 2000, status: 'alive' as const }
      ]
    }
    expect(await writeLineage(file, second)).toBe(true)
    expect(existsSync(`${file}.bak`)).toBe(true)
    // .bak 是上一次的内容
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).active).toBe('default')

    const read = await readLineage(file)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('spring')
    expect(read.lineage.branches.map((branch) => branch.branch)).toEqual(['default', 'spring'])
  })

  it('坏 JSON：备份成 .corrupt-<时间> 后重建，不静默丢原文件', async () => {
    const file = tempFile()
    writeFileSync(file, '{oops', 'utf8')
    const result = await ensureLineage(file, { now: 4242 })
    expect(result.recovered).toBe(true)
    expect(result.created).toBe(false)
    expect(result.backupPath).toBe(`${file}.corrupt-4242`)
    expect(existsSync(`${file}.corrupt-4242`)).toBe(true)
    expect(readFileSync(`${file}.corrupt-4242`, 'utf8')).toBe('{oops')

    const read = await readLineage(file)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.lineage.active).toBe('default')
  })

  it('结构不认识（缺字段 / active 不在分支表里）也算坏，按重建处理', async () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8')
    expect((await readLineage(file)).status).toBe('invalid')
    expect((await ensureLineage(file, { now: 1 })).recovered).toBe(true)

    const lineage = emptyLineage(1)
    writeFileSync(file, JSON.stringify({ ...lineage, active: 'nope' }), 'utf8')
    expect((await readLineage(file)).status).toBe('invalid')
  })

  it('仓内快照是稳定格式（缩进 2、末尾换行），能被 parseLineage 认回', () => {
    const lineage = emptyLineage(7)
    const text = lineageSnapshot(lineage)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "version": 1,')
    expect(parseLineage(JSON.parse(text))).toEqual(lineage)
  })
})
