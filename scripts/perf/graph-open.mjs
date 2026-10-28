/**
 * 全局图「打开 → 沉降」的实测（性能方案 §5.15 的回归基线）。
 *
 * 隔离 userData + 真实库副本（`VACUUM INTO`，不碰真实库），打开图谱后读 HUD：
 * - `沉降 xxx ms` 是应用内自己量的（从 `load()` 开始到力导/静态布局收工），不含窗口创建；
 * - `stats()` 给出布局 tick 与渲染帧（静态展开模式下 tick 应该 < 30、bloom=true）。
 *
 * 用法：node scripts/perf/graph-open.mjs [--shot 输出.png]
 * 退出码 0 = 拿到了数据；1 = 没打开 / 没沉降。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const require = createRequire(new URL('../../package.json', import.meta.url))
const Database = require('better-sqlite3')

const shotIndex = process.argv.indexOf('--shot')
const shotPath = shotIndex >= 0 ? process.argv[shotIndex + 1] : null

const src = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Gotcha', 'memory.db')
const userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-graph-open-'))
const dbPath = join(userDataDir, 'memory.db')
const db = new Database(src, { readonly: true })
db.prepare('VACUUM INTO ?').run(dbPath)
db.close()

const env = {
  ...process.env,
  GOTCHA_USER_DATA: userDataDir,
  GOTCHA_FAKE_CAPTURE: '1',
  GOTCHA_FAKE_LLM: '1',
  DEEPSEEK_API_KEY: ''
}
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.'], env })
let hud = ''
let stats = null
try {
  const ball = await app.firstWindow()
  await ball.waitForSelector('#ball')
  await ball.waitForTimeout(600)
  const graphPromise = app.waitForEvent('window')
  const openedAt = Date.now()
  await app.evaluate(() => globalThis.__gotchaTest.openGraph())
  const graph = await graphPromise
  await graph.waitForLoadState('domcontentloaded')
  await graph.waitForSelector('foam-graph')

  // 等 HUD 报沉降（应用内口径）；再等 1.2 s 让渲染帧停稳
  const deadline = Date.now() + 40_000
  let settleAt = null
  while (Date.now() < deadline) {
    hud = (await graph.evaluate(() => document.querySelector('#hud')?.textContent ?? '')).trim()
    if (settleAt === null && /沉降 \d+ ms/.test(hud)) settleAt = Date.now() - openedAt
    if (settleAt !== null && Date.now() - openedAt > settleAt + 1200) break
    await graph.waitForTimeout(100)
  }
  await graph.waitForTimeout(800)
  stats = await graph.evaluate(() => document.querySelector('foam-graph').stats())
  if (shotPath) await graph.screenshot({ path: shotPath })
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

const settleMs = /沉降 (\d+) ms/.exec(hud)?.[1] ?? null
console.log(`HUD：${hud}`)
console.log(`布局：${JSON.stringify(stats)}`)
console.log(`应用内沉降：${settleMs === null ? '没有' : `${settleMs} ms`}`)
if (settleMs === null) {
  console.log('❌ 没验成：HUD 一直没报沉降')
  process.exitCode = 1
}
