import { WORLD_PAGES, type WorldToolDeps } from '../chain/agent/world'
import type { NotebookStore } from './notebook'

/** 物品归属由当前枝条的实际文件体现；阅读指南或课堂不会写入进度、领取物品。 */
export function createWorldStore(notebook: Pick<NotebookStore, 'owned' | 'claim'>): WorldToolDeps {
  const items = (): string[] => notebook.owned() ? ['notebook'] : []
  return {
    snapshot: () => `门边放着世界指南，物品架与课堂的门开着。${notebook.owned() ? '小本本已经在你的物品里。' : '架上有一本空白小本本。'}`,
    visit: ({ action, id }) => {
      if (action === 'claim') {
        if (id !== 'notebook') return { ok: false, id: id ?? '', text: '物品架上没有这个编号的物品。', items: items() }
        const claimed = notebook.claim()
        return { ok: claimed.ok, id, text: claimed.message, items: items() }
      }
      if (action === 'look') {
        const places = { guide: '世界指南', classroom: '开放课堂', shelf: '物品架' } as const
        const pages = id === undefined ? WORLD_PAGES : WORLD_PAGES.filter((page) => page.place === id)
        if (pages.length === 0) return { ok: false, id: id ?? '', text: '这里没有这个地点。', items: items() }
        return {
          ok: true, id: id ?? 'world', items: items(),
          text: pages.map((page) => `${places[page.place]} · ${page.title}（${page.id}）`).join('\n')
        }
      }
      const page = WORLD_PAGES.find((entry) => entry.id === id)
      return page
        ? { ok: true, id: page.id, text: page.text, items: items() }
        : { ok: false, id: id ?? '', text: '这一本里没有找到那一页。', items: items() }
    }
  }
}
