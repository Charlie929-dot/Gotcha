/**
 * 图谱数据与渲染基线（真实库）。
 *
 * 关心：一次打开拉多少字节、适配器多久、d3-force 单 tick 多久（它决定画布帧率上限）。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { queryGlobalGraph, queryMomentSummary } from '../../src/understand/graph-query'
import { toFoamGraph, toGlobalGraphInput } from '../../src/renderer/graph/foam-adapter'

const require = createRequire(new URL('../../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any

const dbPath = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha', 'memory.db')
const hasDb = existsSync(dbPath)

interface SimNode {
  id: string
  x?: number
  y?: number
  vx?: number
  vy?: number
}
interface SimLink {
  source: string | SimNode
  target: string | SimNode
}

describe.skipIf(!hasDb)('图谱基线与力导成本', () => {
  it('量化', () => {
    const db = new Database(dbPath, { readonly: true })
    try {
      let t0 = performance.now()
      const data = queryGlobalGraph(db)
      console.log(`queryGlobalGraph = ${(performance.now() - t0).toFixed(1)} ms`)
      console.log(
        `themes=${data.themes.length} moments=${data.moments.length} memberships=${data.memberships.length} edges=${data.edges.length} positions=${data.positions.length}`
      )

      const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
      console.log(`IPC 载荷 JSON = ${(bytes / 1024 / 1024).toFixed(2)} MB（默认：摘要截断 60 字 / 不带成员事件 id）`)

      // 老口径对照：全文摘要 + 成员事件 id（P1-2 改造前）
      t0 = performance.now()
      const legacy = queryGlobalGraph(db, { ocrSummaryChars: 0, includeMomentEventIds: true })
      console.log(`queryGlobalGraph（老口径）= ${(performance.now() - t0).toFixed(1)} ms`)
      console.log(
        `老口径 IPC 载荷 JSON = ${(Buffer.byteLength(JSON.stringify(legacy), 'utf8') / 1024 / 1024).toFixed(2)} MB`
      )

      // 侧栏现取全文的成本（点击一个时刻）
      const momentId = data.moments[0]?.id ?? 0
      t0 = performance.now()
      const summary = queryMomentSummary(db, momentId)
      console.log(
        `queryMomentSummary = ${(performance.now() - t0).toFixed(2)} ms（${summary.ocrSummary?.length ?? 0} 字）`
      )

      t0 = performance.now()
      const view = toFoamGraph(toGlobalGraphInput(data))
      console.log(`toGlobalGraphInput + toFoamGraph = ${(performance.now() - t0).toFixed(1)} ms`)

      const nodes: SimNode[] = Object.keys(view.data.nodeInfo).map((id) => ({ id }))
      const links: SimLink[] = view.data.links.map((link) => ({
        source: link.source,
        target: link.target
      }))
      console.log(`画布节点 = ${nodes.length}，连边 = ${links.length}`)

      // 近似画布配置：charge/repel 38、collide、link 60（global.ts 的 forces）
      const sim = forceSimulation(nodes as never)
        .force(
          'link',
          forceLink(links as never)
            .id((node: unknown) => (node as SimNode).id)
            .distance(60)
            .strength(0.3)
        )
        .force('charge', forceManyBody().strength(-38))
        .force('collide', forceCollide(4))
        .force('x', forceX(0).strength(0.02))
        .force('y', forceY(0).strength(0.02))
        .stop()

      t0 = performance.now()
      for (let i = 0; i < 50; i += 1) sim.tick()
      const perTick = (performance.now() - t0) / 50
      console.log(`d3-force 每 tick = ${perTick.toFixed(2)} ms（${nodes.length} 节点 / ${links.length} 边）`)
      sim.stop()

      expect(data.themes.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
