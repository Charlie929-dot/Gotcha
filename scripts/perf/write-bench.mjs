/**
 * 写路径量化：把真实库复制一份到临时目录，比较「带 FTS 触发器 / 不带」的单条写入成本。
 * 只动副本，原件只读。
 */
import { createRequire } from 'node:module'
import { copyFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const require = createRequire(new URL('../../package.json', import.meta.url))
const Database = require('better-sqlite3')

const src = join(process.env.APPDATA, 'Gotcha', 'memory.db')
const dst = join(tmpdir(), `gotcha-perf-copy-${Date.now()}.db`)
copyFileSync(src, dst)
console.log('copy', (statSync(dst).size / 1024 / 1024).toFixed(1), 'MB')

const db = new Database(dst)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
const insert = db.prepare(
  'INSERT INTO events (ts, app, window_title, ocr_text, shot_path, intent_json, sensitive) VALUES (?,?,?,?,?,?,?)'
)
const text =
  '记忆球 性能 测试 文本 '.repeat(40) + ' https://example.com/a?b=c ' + 'x'.repeat(200)
console.log('text chars', text.length)

function bench(label, rows, batch = false) {
  const t0 = performance.now()
  const run = db.transaction(() => {
    for (let i = 0; i < rows; i += 1) insert.run(Date.now(), 'Bench', '窗口标题', text, null, null, 0)
  })
  if (batch) run()
  else for (let i = 0; i < rows; i += 1) insert.run(Date.now(), 'Bench', '窗口标题', text, null, null, 0)
  const ms = performance.now() - t0
  console.log(`${label}: ${rows} 条 ${ms.toFixed(0)} ms → ${(ms / rows).toFixed(2)} ms/条`)
}

// 1) 现状：每条独立事务（采集管线就是逐条 insert）
bench('逐条事务 + FTS', 100)
// 2) 批量事务 + FTS（同样的 FTS 维护，只省 fsync）
bench('单事务批量 + FTS', 300, true)

db.exec('DROP TRIGGER events_fts_ai')
bench('逐条事务 无 FTS', 100)
db.close()

// 3) 触发器本身：单条 FTS 写入成本
const db2 = new Database(dst)
const fts = db2.prepare('INSERT INTO events_fts(rowid, ocr_text) VALUES (?, ?)')
let t0 = performance.now()
for (let i = 0; i < 100; i += 1) {
  fts.run(9_000_000 + i, text.replace(/\s+/g, ''))
}
console.log(`单独 FTS 索引 100 条: ${(performance.now() - t0).toFixed(0)} ms → ${((performance.now() - t0) / 100).toFixed(2)} ms/条`)
db2.close()
rmSync(dst, { force: true })
rmSync(dst + '-wal', { force: true })
rmSync(dst + '-shm', { force: true })
