/**
 * 关键词检索的规模曲线：在真实库副本里灌入正文，观察 LIKE 全扫的耗时增长。
 * 只动副本。
 */
import { createRequire } from 'node:module'
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const require = createRequire(new URL('../../package.json', import.meta.url))
const Database = require('better-sqlite3')

const src = join(process.env.APPDATA, 'Gotcha', 'memory.db')
const dst = join(tmpdir(), `gotcha-scale-${Date.now()}.db`)
copyFileSync(src, dst)
const db = new Database(dst)

const despace = (expr) =>
  `replace(replace(replace(replace(replace(${expr}, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(12288), '')`

const stmt = db.prepare(
  `SELECT c.id FROM chain_content c JOIN chain_segment s ON s.id = c.segment_id
    WHERE s.closed = 1 AND ${despace('c.text')} LIKE ? ESCAPE '\\'
    ORDER BY c.captured_at DESC, c.id DESC LIMIT 400`
)

function measure(label) {
  const total = db.prepare('SELECT SUM(length(text)) AS n, COUNT(*) AS rows FROM chain_content').get()
  const times = []
  for (const term of ['插件市场', '的', '记忆球']) {
    const t0 = performance.now()
    stmt.all(`%${term}%`)
    times.push(`${term}=${(performance.now() - t0).toFixed(0)}ms`)
  }
  console.log(
    `正文 ${(total.n / 1024 / 1024).toFixed(1)} MB / ${total.rows} 行 → ${times.join('  ')}`
  )
}

measure('baseline')

const seg = db.prepare('SELECT id, start_ts, end_ts FROM chain_segment LIMIT 1').get()
const insert = db.prepare(
  `INSERT INTO chain_content (segment_id, captured_at, source, text, chars, hash)
   VALUES (?, ?, 'ocr', ?, ?, ?)`
)
const filler =
  '这是一段用于规模测试的屏幕正文，里面有插件市场、记忆球、Obsidian 等词，也有链接 https://example.com/x 。'.repeat(
    600
  )
const addRows = (n) => {
  const run = db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      insert.run(seg.id, Date.now() + i, filler, filler.length, `scale-${i}`)
    }
  })
  run()
}

addRows(100) // ≈ 5.4 MB
measure('+5 MB')
addRows(170) // ≈ 累计 13 MB
measure('+13 MB')
addRows(500) // ≈ 累计 40 MB
measure('+40 MB')

db.close()
rmSync(dst, { force: true })
rmSync(dst + '-wal', { force: true })
rmSync(dst + '-shm', { force: true })
