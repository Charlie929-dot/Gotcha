/**
 * §5.11 探针：同一条检索在主线程 vs utilityProcess 里跑，比「事件循环被挡多久」。
 *
 * 用法（仓库根目录，先 `npm run build` 出 out/main/search-worker.js）：
 *   npx electron scripts/perf/search-probe
 *
 * 做法：把真实库 VACUUM 成副本、灌到 ~40 MB 正文（副本用完即删），然后量两件事：
 * 1. 主线程直接跑那条 LIKE 扫描（老口径：`searchChainSegmentsBatch` 的 SQL）；
 * 2. 同一条查询丢给 `out/main/search-worker.js`（新口径），顺便确认两次调用结果一致。
 * 结论看「10ms 心跳跳了几次」：主线程 0 次 = 整段时间球 / 热键全部无响应。
 */
const { app, utilityProcess } = require('electron')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { rmSync } = require('node:fs')
const Database = require('better-sqlite3')

const REPO = join(__dirname, '..', '..', '..')
const WORKER = join(REPO, 'out', 'main', 'search-worker.js')
const SRC = join(process.env.APPDATA || '.', 'Gotcha', 'memory.db')
const COPY = join(tmpdir(), `gotcha-search-probe-${process.pid}.db`)

const KEYWORDS = ['插件市场', '记忆球', 'B站', 'Obsidian', 'dsh', '插件', '窗口', '时间']
const FILLER =
  '这是一段用于规模测试的屏幕正文，里面有插件市场、记忆球、Obsidian 等词，也有链接 https://example.com/x 。'.repeat(600)
const LIKE_ESCAPE = "ESCAPE '\\'"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startHeartbeat() {
  let beats = 0
  const timer = setInterval(() => {
    beats += 1
  }, 10)
  return {
    stop() {
      clearInterval(timer)
      return beats
    }
  }
}

async function heartbeatDuring(fn, label) {
  const beat = startHeartbeat()
  const t0 = performance.now()
  const result = await fn()
  const ms = performance.now() - t0
  const beats = beat.stop()
  const expected = Math.max(1, Math.round(ms / 10))
  console.log(
    `${label}: ${ms.toFixed(0)} ms，10ms 心跳 ${beats} 次（理论上限 ~${expected}，越低说明主线程被挡得越久）`
  )
  return result
}

/** 老口径：主线程里同步跑那条扫描（与 `rankKeywords()` 的 SQL 同形） */
function directSearch(db) {
  const flags = KEYWORDS.map((_, index) => `(c.text_norm LIKE @w${index} ${LIKE_ESCAPE}) AS m${index}`).join(', ')
  const where = KEYWORDS.map((_, index) => `(c.text_norm LIKE @w${index} ${LIKE_ESCAPE})`).join(' OR ')
  const args = {}
  KEYWORDS.forEach((keyword, index) => {
    args[`w${index}`] = `%${keyword}%`
  })
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.segment_id AS segmentId, c.captured_at AS capturedAt, ${flags}
         FROM chain_content c JOIN chain_segment s ON s.id = c.segment_id
        WHERE (${where}) ORDER BY c.captured_at DESC, c.id DESC`
    )
    .all(args)
  return rows.length
}

/** 新口径：同一条查询交给 worker，等回包 */
function workerSearch(child, dbPath, query, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), 30_000)
    const onMessage = (message) => {
      if (!message || message.type !== 'result' || message.id !== id) return
      clearTimeout(timer)
      child.off('message', onMessage)
      if (!message.ok) reject(new Error(message.message || message.code))
      else resolve(message.result)
    }
    child.on('message', onMessage)
    child.postMessage({ type: 'search', id, dbPath, query })
  })
}

app.whenReady().then(async () => {
  console.log(`worker = ${WORKER}`)
  // GOTCHA_SEARCH_PROBE_REAL=1：不灌副本，直接拿真实库（和应用同时读写）做一次冒烟
  const real = process.env.GOTCHA_SEARCH_PROBE_REAL === '1'
  const dbPath = real ? SRC : COPY
  if (real) {
    console.log(`真实库模式：${SRC}`)
    const child = utilityProcess.fork(WORKER, [], { serviceName: 'gotcha-search-probe' })
    const query = { texts: KEYWORDS, limit: 8, includeOpen: true }
    try {
      await workerSearch(child, SRC, query, 1)
      const result = await heartbeatDuring(() => workerSearch(child, SRC, query, 2), '真实库 · worker')
      console.log(`真实库返回：${result.hitsPerText.map((hits) => hits.length).join(' / ')} 条（8 路）`)
    } finally {
      child.kill()
      await sleep(300)
      app.quit()
    }
    return
  }
  // 1) 副本（不碰真实库：VACUUM INTO 只读复制）
  const source = new Database(SRC, { readonly: true })
  source.prepare('VACUUM INTO ?').run(COPY)
  source.close()
  const db = new Database(COPY)
  const segment = db.prepare('SELECT id FROM chain_segment ORDER BY id LIMIT 1').get()
  const insert = db.prepare(
    `INSERT INTO chain_content (segment_id, captured_at, source, text, chars, hash) VALUES (?, ?, 'ocr', ?, ?, ?)`
  )
  db.transaction(() => {
    for (let index = 0; index < 770; index += 1) {
      insert.run(segment.id, Date.now() + index, FILLER, FILLER.length, `probe-${index}`)
    }
  })()
  const total = db.prepare('SELECT SUM(length(text)) AS n, COUNT(*) AS rows FROM chain_content').get()
  console.log(`副本：正文 ${(total.n / 1024 / 1024).toFixed(1)} MB / ${total.rows} 行`)

  // 2) 老口径（主线程）
  await heartbeatDuring(() => directSearch(db), '主线程直接跑 LIKE 扫描（老口径）')

  // 3) 新口径（worker）
  const child = utilityProcess.fork(WORKER, [], { serviceName: 'gotcha-search-probe' })
  const query = { texts: KEYWORDS, limit: 8, includeOpen: true }
  try {
    await workerSearch(child, dbPath, query, 1) // 预热（worker 冷启动 + 开库）
    const result = await heartbeatDuring(() => workerSearch(child, dbPath, query, 2), 'worker（新口径）')
    const counts = result.hitsPerText.map((hits) => hits.length)
    console.log(`worker 返回：${counts.join(' / ')} 条（8 路）`)

    // 4) 幂等：同一条查询再跑一次，结果必须完全一致（worker 无状态、每次新开查询）
    const again = await workerSearch(child, dbPath, query, 3)
    console.log(`两次调用结果一致：${JSON.stringify(again) === JSON.stringify(result) ? '是' : '不是！'}`)
  } finally {
    child.kill()
    db.close()
    // worker 还持着只读句柄时删文件会 EPERM（Windows）：等一下再删，删不掉留给系统
    await sleep(400)
    try {
      rmSync(COPY, { force: true })
    } catch {
      /* 忽略 */
    }
    app.quit()
  }
})
