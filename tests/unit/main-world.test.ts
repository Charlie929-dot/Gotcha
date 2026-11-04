import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNotebookStore } from '../../src/main/notebook'
import { createWorldStore } from '../../src/main/world'
import { WORLD_PAGES } from '../../src/chain/agent/world'

describe('世界：浏览、课堂与领取', () => {
  let root: string
  const store = () => createNotebookStore({ root, now: () => 0 })
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gotcha-world-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('目录的每一页均能直接阅读，课堂没有先修或领取副作用', () => {
    const notebook = store()
    const world = createWorldStore(notebook)
    const catalog = world.visit({ action: 'look' })
    for (const page of WORLD_PAGES) {
      expect(catalog.text).toContain(page.id)
      expect(world.visit({ action: 'read', id: page.id })).toEqual({
        ok: true, id: page.id, text: page.text, items: []
      })
    }
    expect(notebook.owned()).toBe(false)
    expect(existsSync(notebook.path)).toBe(false)
    expect(world.visit({ action: 'look', id: 'classroom' }).text).not.toContain('两边的钟')
  })

  it('主动领取才产生物品；重建服务仍拥有；重复领取不覆盖已有文字', () => {
    const notebook = store()
    expect(notebook.update({ action: 'add', text: '还未领取' }).ok).toBe(false)
    const world = createWorldStore(notebook)
    expect(world.visit({ action: 'claim', id: 'notebook' })).toMatchObject({ ok: true, items: ['notebook'] })
    expect(notebook.read()).toEqual([])
    expect(notebook.view().groups).toEqual([])
    const added = notebook.update({ action: 'add', section: '我的奇怪梦境', text: '梦'.repeat(5000) })
    expect(added).toMatchObject({ ok: true, entry: { section: '我的奇怪梦境', text: '梦'.repeat(5000) } })
    const before = readFileSync(notebook.path, 'utf8')
    expect(createWorldStore(store()).visit({ action: 'claim', id: 'notebook' }).ok).toBe(true)
    expect(readFileSync(notebook.path, 'utf8')).toBe(before)
    expect(createWorldStore(store()).snapshot()).toContain('已经在你的物品里')
  })

  it('旧本子直接识别为已有物品；领取不改旧文件，旧栏目与编号仍能读取', () => {
    const notebook = store()
    const legacy = '# 小本本\n\n## 关于你\n- n7 · 2026-10-20 · 原来的字\n'
    writeFileSync(notebook.path, legacy)
    expect(createWorldStore(notebook).visit({ action: 'claim', id: 'notebook' }).items).toEqual(['notebook'])
    expect(readFileSync(notebook.path, 'utf8')).toBe(legacy)
    expect(notebook.read()).toEqual([{ id: 'n7', section: '关于你', text: '原来的字' }])
  })

  it('未知页面或物品如实失败，没有虚构领取；无法写入也没有物品', () => {
    const notebook = store()
    const world = createWorldStore(notebook)
    expect(world.visit({ action: 'claim', id: '../../anything' })).toMatchObject({ ok: false, items: [] })
    expect(world.visit({ action: 'read', id: 'missing' }).ok).toBe(false)
    expect(world.visit({ action: 'look', id: 'missing' }).ok).toBe(false)
    expect(existsSync(notebook.path)).toBe(false)
    const unavailable = createWorldStore(createNotebookStore({ root: join(root, 'absent'), now: () => 0 }))
    expect(unavailable.visit({ action: 'claim', id: 'notebook' })).toMatchObject({ ok: false, items: [] })
  })
})
