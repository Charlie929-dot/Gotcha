/**
 * 真机校验：向量是不是真的在 utilityProcess 里算出来的（P1-4）。
 *
 * 隔离 userData + 真实模型（**不**注入假向量）：
 * 1. 用真实库的 DDL 建一个空库（`schema_version` 对齐最新），种一条事件 + 一个时刻（没有主题）；
 * 2. 起应用（假采集 + 假 LLM，真向量），用测试钩子 `__gotchaTest.onlineTick()` 跑在线归属：
 *    它要给时刻建主题 → 必须算一次 512 维向量；
 * 3. 断言：主题 / 归属 / `node_embeddings` 都落库（2048 B = 512 × float32），
 *    且 main.log 里有 `embedding worker started`（证明走的是工作进程，不是主进程内会话）。
 *
 * 用法（仓库根目录，先 `npm run build`）：`npm run check:embedding-worker`
 * 退出码 0 = 通过；1 = 没验成（会打印日志尾部）。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const require = createRequire(new URL('../package.json', import.meta.url))
const Database = require('better-sqlite3')

const appData = process.env.APPDATA ?? process.env.HOME ?? '.'
const realDbPath = join(appData, 'Gotcha', 'memory.db')
const userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-worker-check-'))
const dbPath = join(userDataDir, 'memory.db')

/** 用真实库的结构建空库（FTS 影子表由虚拟表自己建，不能手工 exec） */
function createEmptyDb() {
  const source = new Database(realDbPath, { readonly: true })
  const objects = source
    .prepare(
      `SELECT name, type, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger')`
    )
    .all()
  const version = source.prepare('SELECT version FROM schema_version').get().version
  source.close()

  const ftsNames = objects
    .filter((item) => typeof item.sql === 'string' && item.sql.startsWith('CREATE VIRTUAL TABLE'))
    .map((item) => item.name)
  const isShadow = (name) =>
    ftsNames.some((fts) =>
      ['data', 'idx', 'content', 'docsize', 'config'].some((suffix) => name === `${fts}_${suffix}`)
    )

  const seed = new Database(dbPath)
  seed.pragma('journal_mode = WAL')
  for (const type of ['table', 'index', 'trigger']) {
    for (const row of objects.filter((item) => item.type === type && !isShadow(item.name))) {
      seed.exec(row.sql)
    }
  }
  seed.prepare('UPDATE schema_version SET version = ?').run(version)

  return seed
}

function seedOneMoment(seed) {
  const ts = Date.now() - 15 * 60_000
  const eventId = Number(
    seed
      .prepare(
        `INSERT INTO events (ts, app, window_title, ocr_text, sensitive)
         VALUES (?, 'Code', 'a.ts', '改按钮样式', 0)`
      )
      .run(ts).lastInsertRowid
  )
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  const dayKey = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  seed
    .prepare(
      `INSERT INTO moments (start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids, created_at)
       VALUES (?, ?, ?, 'Code', 'a.ts', '改按钮样式，修悬停态', ?, ?)`
    )
    .run(ts, ts + 30_000, dayKey, JSON.stringify([eventId]), ts)
  for (const [key, value] of [
    ['graph.outbound_consent', '1'],
    ['graph.online_themes', '1']
  ]) {
    seed
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }
}

const seed = createEmptyDb()
seedOneMoment(seed)
seed.close()

const env = {
  ...process.env,
  GOTCHA_USER_DATA: userDataDir,
  GOTCHA_FAKE_CAPTURE: '1',
  GOTCHA_FAKE_LLM: '1',
  GOTCHA_CAPTURE: '1',
  DEEPSEEK_API_KEY: ''
}
delete env.ELECTRON_RUN_AS_NODE
delete env.GOTCHA_FAKE_EMBEDDING

const app = await electron.launch({ args: ['.'], env })
const ticks = []
try {
  const ball = await app.firstWindow()
  await ball.waitForSelector('#ball')
  await ball.waitForTimeout(1200)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const tick = await app.evaluate(() => globalThis.__gotchaTest.onlineTick())
    if (tick) ticks.push(tick)
    if (tick && (tick.created > 0 || tick.embedded > 0)) break
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
} finally {
  await app.close()
}

const read = new Database(dbPath, { readonly: true })
const counts = {
  themes: read.prepare('SELECT COUNT(*) c FROM nodes WHERE level = 1').get().c,
  memberships: read.prepare('SELECT COUNT(*) c FROM theme_moments').get().c,
  nodeVectors: read.prepare('SELECT COUNT(*) c FROM node_embeddings').get().c,
  vectorBytes: read.prepare('SELECT MAX(LENGTH(vec)) b FROM node_embeddings').get().b
}
read.close()

let log = ''
try {
  log = readFileSync(join(userDataDir, 'logs', 'main.log'), 'utf8')
} catch {
  log = ''
}
const workerLines = log.split('\n').filter((line) => line.includes('embedding worker'))
rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

const meaningful = ticks.find((tick) => tick.created > 0 || tick.embedded > 0) ?? ticks.at(-1) ?? null
console.log('在线归属：', JSON.stringify(meaningful))
console.log('库：', JSON.stringify(counts))
console.log('worker 日志：', workerLines.length > 0 ? workerLines : '（没有 embedding worker 记录）')

const ok =
  workerLines.some((line) => line.includes('embedding worker started')) &&
  counts.nodeVectors > 0 &&
  counts.vectorBytes === 2048 &&
  counts.themes > 0
if (!ok) {
  console.log('❌ 没验成：worker 日志或 512 维向量缺失')
  process.exitCode = 1
} else {
  console.log('✅ 向量确实由 utilityProcess 里的会话算出（512 维 / 文件 2048 B）')
}
