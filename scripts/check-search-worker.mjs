/**
 * 真机校验：`search_info` 的 LIKE 全扫是不是真的在 `utilityProcess` 里跑的（§5.13）。
 *
 * 隔离 userData + 真实库结构（**不碰真实库**）：
 * 1. 用真实库的 DDL 建空库，种两条段 + 两条正文（触发 `text_norm` 的维护触发器）；
 * 2. 起应用（假采集 + 假 LLM，不注入假向量）；LLM 不是重点——探针直接调生产那条
 *    `runSearchBatch()`：正常走检索工作进程，worker 坏了才退回主线程；
 * 3. 断言：命中数对得上、`main.log` 里有 `search worker started`、没有
 *    `search worker failed, fallback to main thread`；连查两次只 fork 一次（懒启动 + 复用）。
 *
 * 用法（仓库根目录，先 `npm run build`）：`npm run check:search-worker`
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
const userDataDir = mkdtempSync(join(tmpdir(), 'gotcha-search-check-'))
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

const pad = (value) => String(value).padStart(2, '0')
function dayKeyOf(ts) {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 两条段 + 两条正文：搜「按钮」应命中 2 段、搜「悬停」应命中 1 段 */
function seedSegments(seed) {
  const now = Date.now()
  const rows = [
    { text: '修按钮悬停态：hover 时背景变深，点一下没有反应', minutesAgo: 20 },
    { text: '按钮点击后弹窗确认，取消时回滚草稿', minutesAgo: 5 }
  ]
  const insertSegment = seed.prepare(
    `INSERT INTO chain_segment
       (start_ts, end_ts, active_ms, idle_ms, day_key, app, exe, pid, hwnd, title_first, title_last, created_at, closed)
     VALUES (?, ?, ?, 0, ?, 'Code', 'code.exe', 1, 1, 'a.ts', 'a.ts', ?, 1)`
  )
  const insertContent = seed.prepare(
    `INSERT INTO chain_content (segment_id, captured_at, source, text, chars, hash)
     VALUES (?, ?, 'uia', ?, ?, ?)`
  )
  for (const row of rows) {
    const at = now - row.minutesAgo * 60_000
    const segmentId = Number(insertSegment.run(at, at + 30_000, 30_000, dayKeyOf(at), at).lastInsertRowid)
    insertContent.run(segmentId, at, row.text, row.text.length, `seed-${segmentId}`)
  }
}

const seed = createEmptyDb()
seedSegments(seed)
// 检索走只读连接；这里关掉种子连接，免得 shm/wal 句柄影响收尾
seed.pragma('wal_checkpoint(TRUNCATE)')
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
let first = null
let second = null
try {
  const ball = await app.firstWindow()
  await ball.waitForSelector('#ball')
  await ball.waitForTimeout(800)
  first = await app.evaluate(() => globalThis.__gotchaTest.searchProbe(['按钮', '悬停'], 5))
  second = await app.evaluate(() => globalThis.__gotchaTest.searchProbe(['按钮'], 5))
} finally {
  await app.close()
}

let log = ''
try {
  log = readFileSync(join(userDataDir, 'logs', 'main.log'), 'utf8')
} catch {
  log = ''
}
const lines = log.split('\n')
const started = lines.filter((line) => line.includes('search worker started'))
const fellBack = lines.filter((line) => line.includes('search worker failed, fallback to main thread'))
const workerExited = lines.filter((line) => line.includes('search worker exited'))

// §5.9-6 的常驻指标：两次探针都应该落进 `stats.search.day.<date>`
let metrics = null
try {
  const read = new Database(dbPath, { readonly: true })
  const row = read
    .prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'stats.search.day.%' ORDER BY key DESC LIMIT 1"
    )
    .get()
  read.close()
  metrics = row ? { key: row.key, ...JSON.parse(row.value) } : null
} catch (error) {
  metrics = { error: String(error) }
}
rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

console.log('第一次探针：', JSON.stringify(first))
console.log('第二次探针：', JSON.stringify(second))
console.log(
  'worker 日志：',
  started.length > 0 ? started : '（没有 search worker started）',
  fellBack.length > 0 ? fellBack : ''
)
console.log('常驻指标：', metrics ? JSON.stringify(metrics) : '（没有 stats.search.day.*）')

const ok =
  first?.ok === true &&
  second?.ok === true &&
  // 「按钮」两段都命中、「悬停」只命中最近那条
  first.hits[0] === 2 &&
  first.hits[1] === 1 &&
  second.hits[0] === 2 &&
  started.length === 1 &&
  fellBack.length === 0 &&
  workerExited.length === 0 &&
  // 指标：两次探针、命中 2+1+2=5 条、没有错误 / 降级
  metrics?.runs === 2 &&
  metrics?.hits === 5 &&
  metrics?.errors === 0 &&
  metrics?.fallbacks === 0

if (!ok) {
  console.log('❌ 没验成：日志尾部 ——')
  console.log(lines.slice(-25).join('\n'))
  process.exitCode = 1
} else {
  console.log(
    `✅ 检索确实在 utilityProcess 里跑（懒启动 1 次、复用 1 次、命中数正确、无降级）耗时 ${first.elapsedMs} / ${second.elapsedMs} ms；指标已落盘`
  )
}
