/**
 * 采集链路量化：从真实 main.log 抽 ocr_ms / 抓帧耗时 / 事件频率，从库里抽每日产生量。
 * 只读。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const require = createRequire(new URL('../../package.json', import.meta.url))
const Database = require('better-sqlite3')

const logPath = join(process.env.APPDATA, 'Gotcha', 'logs', 'main.log')
const lines = readFileSync(logPath, 'utf8').split(/\r?\n/)

const ocr = []
const slowShot = []
const contentUia = []
const contentOcr = []
const deriveTicks = []
const insertTs = []
const captureErrors = []

for (const line of lines) {
  let m
  if ((m = /"ocr_ms":(\d+)/.exec(line))) ocr.push(Number(m[1]))
  if ((m = /chain shot slow.*"ms":(\d+)/.exec(line))) slowShot.push(Number(m[1]))
  if (line.includes('content: uia thin')) contentUia.push(1)
  if ((m = /content: ocr \{"exe":"[^"]*","chars":(\d+)/.exec(line))) contentOcr.push(Number(m[1]))
  if ((m = /chain derive sweep (\{.*\})/.exec(line))) {
    try {
      deriveTicks.push(JSON.parse(m[1]))
    } catch {
      /* 忽略半行 */
    }
  }
  if ((m = /^\[([\d\-:. ]+)\] \[info\]  \[capture\] event inserted/.exec(line))) insertTs.push(m[1])
  if (/capture_errors|chain shot failed|ocr failed/.test(line)) captureErrors.push(line)
}

function stats(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: values.length,
    min: sorted[0],
    p50: pick(0.5),
    p90: pick(0.9),
    p99: pick(0.99),
    max: sorted[sorted.length - 1],
    sum: sorted.reduce((a, b) => a + b, 0)
  }
}

console.log('日志行数', lines.length)
console.log('OCR 单帧（ms）', JSON.stringify(stats(ocr)))
console.log('慢抓帧 chain shot slow（ms）', JSON.stringify(stats(slowShot)))
console.log('UIA 文本不足改走 OCR 次数', contentUia.length, '| OCR 兜底字数', JSON.stringify(stats(contentOcr)))
console.log('派生 sweep 次数', deriveTicks.length)
if (deriveTicks.length > 0) {
  const sum = (k) => deriveTicks.reduce((n, t) => n + (t[k] ?? 0), 0)
  console.log(
    `派生累计：pending=${sum('pending')} vectors=${sum('vectors')} extracted=${sum('extracted')} merged=${sum('merged')} blocked=${sum('blocked')} failed=${sum('failed')}`
  )
}
console.log('采集错误/失败行', captureErrors.length)

// 事件间隔（同一段连续插入）
if (insertTs.length > 1) {
  const gaps = []
  for (let i = 1; i < insertTs.length; i += 1) {
    const a = Date.parse(insertTs[i - 1].replace(' ', 'T'))
    const b = Date.parse(insertTs[i].replace(' ', 'T'))
    const gap = (b - a) / 1000
    if (gap >= 0 && gap < 600) gaps.push(gap)
  }
  console.log('事件插入间隔（秒）', JSON.stringify(stats(gaps)))
  const hours = (Date.parse(insertTs.at(-1).replace(' ', 'T')) - Date.parse(insertTs[0].replace(' ', 'T'))) / 3.6e6
  console.log(`窗口 ${hours.toFixed(1)} h，共 ${insertTs.length} 条 → ${(insertTs.length / hours).toFixed(1)} 条/h`)
}

// 库内每日产出
const db = new Database(join(process.env.APPDATA, 'Gotcha', 'memory.db'), { readonly: true })
console.log('\n每日（events / 段 / 截图 / 正文）')
const rows = db
  .prepare(
    `SELECT date(ts/1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS events,
            SUM(length(ocr_text)) AS chars
       FROM events GROUP BY d ORDER BY d DESC LIMIT 7`
  )
  .all()
console.log(JSON.stringify(rows, null, 0))
const segRows = db
  .prepare(
    `SELECT day_key AS d, COUNT(*) AS segments, SUM(active_ms)/1000 AS activeS
       FROM chain_segment GROUP BY d ORDER BY d DESC LIMIT 7`
  )
  .all()
console.log(JSON.stringify(segRows))
const shotRows = db
  .prepare(
    `SELECT date(ts/1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS shots, SUM(bytes)/1024/1024 AS mb
       FROM chain_shot GROUP BY d ORDER BY d DESC LIMIT 7`
  )
  .all()
console.log(JSON.stringify(shotRows))
const contentRows = db
  .prepare(
    `SELECT date(captured_at/1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS n, SUM(chars) AS chars
       FROM chain_content GROUP BY d ORDER BY d DESC LIMIT 7`
  )
  .all()
console.log(JSON.stringify(contentRows))
db.close()
