/**
 * 性能探针（只读）：对真实库跑一遍主要查询，输出毫秒数与行数。
 *
 * 用法：node scripts/perf-probe.mjs [--db <path>] [--json]
 * 默认库：%APPDATA%\Gotcha\memory.db（只开 readonly，不写、不 checkpoint）。
 *
 * 这是“量化”用的临时工具：不改产品代码，只把热点查询的真实耗时打出来。
 */
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const args = process.argv.slice(2)
const dbPath =
  args.includes('--db') ? args[args.indexOf('--db') + 1] : join(process.env.APPDATA, 'Gotcha', 'memory.db')
const asJson = args.includes('--json')

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
db.pragma('busy_timeout = 5000')

const results = []
function timed(name, fn, note = '') {
  const t0 = performance.now()
  let value
  try {
    value = fn()
  } catch (error) {
    results.push({ name, ms: performance.now() - t0, error: String(error.message ?? error), note })
    return null
  }
  const ms = performance.now() - t0
  const rows = Array.isArray(value) ? value.length : typeof value === 'number' ? value : value == null ? 0 : 1
  results.push({ name, ms: Number(ms.toFixed(2)), rows, note })
  return value
}

function table(name) {
  return db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
}

/* ---------- 1. 规模 ---------- */
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((row) => row.name)
const counts = {}
for (const name of tables) {
  try {
    counts[name] = table(name)
  } catch {
    counts[name] = -1
  }
}

const pageSize = db.pragma('page_size', { simple: true })
const pageCount = db.pragma('page_count', { simple: true })
const freelist = db.pragma('freelist_count', { simple: true })
const journal = db.pragma('journal_mode', { simple: true })

/** 每张表（含索引）占多少页：dbstat 可用时给出，否则 null */
let dbstat = null
try {
  dbstat = db
    .prepare(
      `SELECT name, SUM(pgsize) AS bytes, SUM(ncell) AS cells
         FROM dbstat GROUP BY name ORDER BY bytes DESC`
    )
    .all()
} catch {
  dbstat = null
}

/* ---------- 2. 已知热点查询 ---------- */
const now = Date.now()
const dayStart = new Date()
dayStart.setHours(0, 0, 0, 0)
const todayStart = dayStart.getTime()
const todayEnd = todayStart + 24 * 3600 * 1000

timed('timeline:query 今天', () =>
  db
    .prepare(
      `SELECT id, ts, app, window_title, ocr_text, shot_path, intent_json, sensitive
         FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC`
    )
    .all(todayStart, todayEnd)
)

// 旧「问」检索：trigram MATCH（>=3 字）与 LIKE 兜底（<3 字）
const hasFts = tables.includes('events_fts')
if (hasFts) {
  timed('search:events MATCH "记忆球"', () =>
    db
      .prepare(
        `SELECT e.id, e.ts, e.app, e.window_title, e.ocr_text, bm25(events_fts) AS rank
           FROM events_fts JOIN events e ON e.id = events_fts.rowid
          WHERE events_fts MATCH ?
          ORDER BY rank ASC, e.ts DESC LIMIT 300`
      )
      .all('"记忆球"')
  )
  timed('search:events LIKE "%记 忆%"（2 字兜底）', () =>
    db
      .prepare(
        `SELECT e.id, e.ts, e.app, e.window_title, e.ocr_text, 0 AS rank
           FROM events_fts JOIN events e ON e.id = events_fts.rowid
          WHERE events_fts.ocr_text LIKE ? ESCAPE '\\'
          ORDER BY e.ts DESC LIMIT 300`
      )
      .all('%记 忆%')
  )
}

// 信息链关键词：SELECT ... FROM chain_content WHERE <normalizeOcrSql(text)> LIKE '%词%'
const despace = (expr) =>
  `replace(replace(replace(replace(replace(${expr}, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(12288), '')`

function keywordScan(term, limit = 400) {
  return db
    .prepare(
      `SELECT c.id, c.segment_id, c.captured_at, c.text
         FROM chain_content c JOIN chain_segment s ON s.id = c.segment_id
        WHERE s.closed = 1 AND ${despace('c.text')} LIKE ? ESCAPE '\\'
        ORDER BY c.captured_at DESC, c.id DESC LIMIT ?`
    )
    .all(`%${term}%`, limit)
}

timed('chain:关键词 "插件市场"（LIKE 全扫, limit 400）', () => keywordScan('插件市场'), '搜索高频词前的典型路径')
timed('chain:关键词 "的"（LIKE 全扫, limit 400）', () => keywordScan('的'), '高频词最坏情况')

// 向量路：全量取 BLOB 再算余弦（与 rankByVector 同口径）
let vecRows = []
timed('chain:向量全量取 BLOB', () => {
  vecRows = db.prepare('SELECT v.segment_id, v.dim, v.vec FROM chain_vector v JOIN chain_segment s ON s.id = v.segment_id WHERE s.closed = 1').all()
  return vecRows.length
})
timed('chain:向量余弦 全量比较', () => {
  const q = new Float32Array(vecRows[0]?.dim ?? 512)
  for (let i = 0; i < q.length; i += 1) q[i] = Math.sin(i)
  let n = 0
  for (const row of vecRows) {
    if (row.vec.byteLength !== row.dim * 4) continue
    const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim)
    let dot = 0
    let qa = 0
    let va = 0
    for (let i = 0; i < row.dim; i += 1) {
      dot += q[i] * vec[i]
      qa += q[i] * q[i]
      va += vec[i] * vec[i]
    }
    if (dot / (Math.sqrt(qa) * Math.sqrt(va) || 1) > 0) n += 1
  }
  return n
})

// 全局图：一次拉全量（打开图谱窗口就会跑）
timed('graph:queryGlobalGraph（themes/moments/memberships/edges）', () => {
  const themes = db.prepare("SELECT id, type, title, summary, ts_start, ts_end, source_events FROM nodes WHERE level = 1 AND merged_into IS NULL ORDER BY id ASC").all()
  const memberships = db.prepare('SELECT theme_id, moment_id, weight, source FROM theme_moments').all()
  const moments = db.prepare('SELECT id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids FROM moments ORDER BY start_ts ASC, id ASC').all()
  const edges = db.prepare("SELECT id, src, dst, weight, kind, evidence FROM edges WHERE kind IN ('embedding') ORDER BY id ASC").all()
  const positions = db.prepare('SELECT node_id, x, y FROM node_positions ORDER BY node_id ASC').all()
  let ids = 0
  for (const m of moments) {
    try {
      ids += JSON.parse(m.event_ids ?? '[]').length
    } catch {
      /* 坏 JSON 跳过 */
    }
  }
  return { themes, memberships, moments, edges, positions, ids }
})

timed('graph:queryDayActivity（events 全表扫 ts + moments 聚合）', () => {
  const rows = db.prepare('SELECT ts FROM events').all()
  const byDay = new Map()
  for (const row of rows) {
    const d = new Date(row.ts)
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    byDay.set(key, (byDay.get(key) ?? 0) + 1)
  }
  return [...byDay.keys()]
})

// 时刻列表（图表 / 日历）
timed('moments:SELECT 全量（含 event_ids）', () =>
  db.prepare('SELECT id, start_ts, end_ts, day_key, app, window_title, ocr_summary, event_ids FROM moments').all()
)

// 段列表（信息链）
timed('chain:最近 200 段', () =>
  db.prepare('SELECT * FROM chain_segment ORDER BY start_ts DESC LIMIT 200').all()
)

// 段详情（问记忆引用点开）
timed('chain:单段详情（events+shots+content）', () => {
  const seg = db.prepare('SELECT * FROM chain_segment ORDER BY id DESC LIMIT 1').get()
  if (!seg) return []
  const events = db.prepare('SELECT * FROM chain_event WHERE segment_id = ? ORDER BY ts').all(seg.id)
  const shots = db.prepare('SELECT * FROM chain_shot WHERE segment_id = ? ORDER BY ts').all(seg.id)
  const contents = db.prepare('SELECT id, segment_id, captured_at, source, length(text) AS n FROM chain_content WHERE segment_id = ? ORDER BY captured_at').all(seg.id)
  return [seg, ...events, ...shots, ...contents]
})

// WAL / 文件
const fileBytes = statSync(dbPath).size
const walPath = `${dbPath}-wal`
let walBytes = 0
try {
  walBytes = statSync(walPath).size
} catch {
  walBytes = 0
}

/* ---------- 3. 输出 ---------- */
const report = {
  dbPath,
  fileMB: Number((fileBytes / 1024 / 1024).toFixed(1)),
  walMB: Number((walBytes / 1024 / 1024).toFixed(1)),
  journalMode: journal,
  pageSize,
  pageCount,
  freelistPages: freelist,
  freeMB: Number(((freelist * pageSize) / 1024 / 1024).toFixed(1)),
  counts,
  topBytes: dbstat ? dbstat.slice(0, 15).map((r) => ({ name: r.name, MB: Number((r.bytes / 1024 / 1024).toFixed(1)), cells: r.cells })) : null,
  timings: results
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`库：${report.dbPath}`)
  console.log(`文件 ${report.fileMB} MB  WAL ${report.walMB} MB  journal=${report.journalMode}  page=${report.pageSize}B  空闲页 ${report.freelistPages}（${report.freeMB} MB）`)
  console.log('\n表行数：')
  for (const [name, n] of Object.entries(counts)) console.log(`  ${name.padEnd(28)} ${n}`)
  if (report.topBytes) {
    console.log('\n体积 Top（dbstat，含索引/溢出页）：')
    for (const row of report.topBytes) console.log(`  ${row.name.padEnd(28)} ${String(row.MB).padStart(8)} MB  cells=${row.cells}`)
  }
  console.log('\n查询耗时：')
  for (const r of results) {
    const status = r.error ? `ERR ${r.error}` : `${String(r.rows).padStart(6)} 行`
    console.log(`  ${String(r.ms).padStart(9)} ms  ${status}  ${r.name}${r.note ? `  (${r.note})` : ''}`)
  }
}
db.close()
