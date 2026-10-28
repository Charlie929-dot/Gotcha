/**
 * P0-2 镜像覆盖测量（只读，真实库）
 *
 * 目的：P0-2 第二步（打开 `capture.metadata_only=1`）的门槛是「信息链正文能覆盖旧管线
 * 产出的正文」。这个脚本把覆盖拆成三块，避免用「覆盖率」一个数字掩盖原因：
 *   1. mirrored      —— `chain_content` 落库后确实镜像出一条 `events`（ts = captured_at）
 *   2. drop-password —— 命中 sanitize 的密码类规则（`密码|password|passphrase|PIN…`）整条不写，
 *                       与旧管线「整帧丢弃」同口径；这部分本来就不该有
 *   3. drop-other    —— 既没镜像也没命中规则：镜像器没跑 / 段缺失 / 写库失败，需要查日志
 *
 * 另外按天给出「正文体量」对照：镜像正文（chain 侧，单条很长）vs 旧管线独有的正文
 * （切到 metadata_only 后这些帧只剩 app/title）。两项都只是本地统计，不读正文内容。
 *
 * 用法：
 *   node scripts/perf/mirror-coverage.mjs [--db <path>] [--days 3] [--json]
 * 默认库：%APPDATA%\Gotcha\memory.db（readonly，不写、不 checkpoint）。
 */
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const args = process.argv.slice(2)
const dbPath =
  args.includes('--db') ? args[args.indexOf('--db') + 1] : join(process.env.APPDATA ?? '', 'Gotcha', 'memory.db')
const asJson = args.includes('--json')
const days = args.includes('--days') ? Math.max(1, Number(args[args.indexOf('--days') + 1]) || 3) : 3

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
db.pragma('busy_timeout = 5000')

const DAY = 24 * 3600_000
const startOfToday = new Date()
startOfToday.setHours(0, 0, 0, 0)

/** 密码类 drop 规则的口径（与 src/understand/sanitize.ts 的 password-context 对齐） */
const PASSWORD_SQL = "(c.text LIKE '%密码%' OR lower(c.text) LIKE '%password%' OR lower(c.text) LIKE '%passphrase%')"
/** `\\bpin\\b` 是词边界匹配：技术文本里的 “to pin” 也会整帧丢弃（已知误伤，见文档） */
const PIN_SQL = "(lower(c.text) GLOB '*[^a-z]pin[^a-z]*')"
const MIRRORED_SQL = 'EXISTS (SELECT 1 FROM events e WHERE e.ts = c.captured_at)'

// 镜像器上线的时刻：第一条真的镜像出 events 的 chain_content。
// 在此之前的内容行「没镜像」是构建/重启窗口，不算缺陷，单独计数。
const mirrorSinceRow = db.prepare(`SELECT MIN(c.captured_at) AS t FROM chain_content c WHERE ${MIRRORED_SQL}`).get()
const mirrorSince = mirrorSinceRow?.t ?? null

const perDay = []
for (let i = days - 1; i >= 0; i--) {
  const start = startOfToday.getTime() - i * DAY
  const end = start + DAY
  const rows = db
    .prepare(
      `SELECT c.id, c.captured_at, c.chars, ${MIRRORED_SQL} AS mirrored,
              ${PASSWORD_SQL} AS pw, ${PIN_SQL} AS pin
         FROM chain_content c
        WHERE c.captured_at >= ? AND c.captured_at < ?`
    )
    .all(start, end)
  const bucket = { mirrored: 0, password: 0, pinOnly: 0, beforeMirror: 0, other: 0 }
  const chars = { mirrored: 0, password: 0, pinOnly: 0, beforeMirror: 0, other: 0 }
  for (const row of rows) {
    const key = row.mirrored
      ? 'mirrored'
      : row.pw
        ? 'password'
        : row.pin
          ? 'pinOnly'
          : mirrorSince !== null && row.captured_at < mirrorSince
            ? 'beforeMirror'
            : 'other'
    bucket[key] += 1
    chars[key] += row.chars ?? 0
  }
  const textEvents = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ocr_text)), 0) AS chars FROM events
        WHERE ts >= ? AND ts < ? AND LENGTH(TRIM(COALESCE(ocr_text, ''))) > 0`
    )
    .get(start, end)
  const mirroredEvents = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
        WHERE e.ts >= ? AND e.ts < ?
          AND LENGTH(TRIM(COALESCE(e.ocr_text, ''))) > 0
          AND EXISTS (SELECT 1 FROM chain_content c WHERE c.captured_at = e.ts)`
    )
    .get(start, end)
  const afterMirror = rows.length - bucket.beforeMirror
  const dayKey = new Date(start).toLocaleDateString('sv-SE')
  // 采集埋点（stats.day.<本地日>）：切到 metadata_only 后 ocr_runs / write_bytes 应掉一个量级，
  // metadata_events 应等于「旧管线当天写的元数据事件数」。
  const statsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(`stats.day.${dayKey}`)
  let stats = null
  try {
    const parsed = statsRow ? JSON.parse(statsRow.value) : null
    if (parsed && typeof parsed === 'object') {
      stats = {
        framesTotal: parsed.frames_total ?? 0,
        framesSame: parsed.frames_same ?? 0,
        ocrRuns: parsed.ocr_runs ?? 0,
        writeBytes: parsed.write_bytes ?? 0,
        metadataEvents: parsed.metadata_events ?? 0
      }
    }
  } catch {
    stats = null
  }
  perDay.push({
    day: dayKey,
    contents: rows.length,
    ...bucket,
    mirrorRate: afterMirror > 0 ? Number(((bucket.mirrored / afterMirror) * 100).toFixed(1)) : null,
    chars,
    // 切到 metadata_only 后：镜像正文顶上，旧管线独有的正文（含 drop 掉的）只剩 app/title
    textEvents: textEvents.n,
    textEventChars: textEvents.chars,
    mirroredEvents: mirroredEvents.n,
    stats
  })
}

const result = { dbPath, dbBytes: statSync(dbPath).size, mirrorSince, days: perDay }
db.close()

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`db: ${dbPath} (${(result.dbBytes / 1024 / 1024).toFixed(1)} MB)`)
  console.log(`镜像器上线：${mirrorSince ? new Date(mirrorSince).toLocaleString('sv-SE') : '（还没有任何镜像行）'}`)
  console.log('')
  console.log('日期        内容行  已镜像  密码drop  pin误伤  上线前  其他   覆盖率   镜像正文(字)  旧管线正文(字)')
  for (const d of perDay) {
    const pad = (v, w) => String(v).padStart(w)
    console.log(
      `${d.day}  ${pad(d.contents, 6)}  ${pad(d.mirrored, 6)}  ${pad(d.password, 7)}  ${pad(d.pinOnly, 7)}  ${pad(d.beforeMirror, 6)}  ${pad(d.other, 5)}  ${pad(d.mirrorRate ?? '-', 6)}%  ${pad(d.chars.mirrored, 12)}  ${pad(d.textEventChars, 14)}`
    )
  }
  console.log('')
  console.log('采集埋点（stats.day.*）：')
  console.log('日期        帧数    同帧    OCR次   写盘(GB)  metadata事件')
  for (const d of perDay) {
    const pad = (v, w) => String(v).padStart(w)
    if (!d.stats) {
      console.log(`${d.day}  （当天没有 stats 键）`)
      continue
    }
    console.log(
      `${d.day}  ${pad(d.stats.framesTotal, 6)}  ${pad(d.stats.framesSame, 6)}  ${pad(d.stats.ocrRuns, 6)}  ${pad((d.stats.writeBytes / 1024 / 1024 / 1024).toFixed(2), 7)}  ${pad(d.stats.metadataEvents, 12)}`
    )
  }
  console.log('')
  console.log('读法：')
  console.log('- 「其他」应为 0；不为 0 说明镜像器没跑（重启窗口）或写 events 失败，去 main.log 搜 "mirror"。')
  console.log('- 「上线前」是镜像器部署前的内容行，不算缺陷（覆盖率只看上线之后）。')
  console.log('- 「密码drop」是设计内丢弃（旧管线同样整帧丢），不是缺陷。')
  console.log('- 「pin误伤」是 `\\bpin\\b` 词边界规则把技术文本里的 “to pin” 整帧丢掉；2026-10-28 已收紧成「pin + 码/code/冒号/40 字符内 4–8 位数字」，这个桶会逐日变小。')
  console.log('- 旧管线正文(字) 远大于镜像正文(字) 是因为它按帧 OCR（短、密），镜像按段读（长、稀）。')
  console.log('  切 metadata_only 后时刻仍按 app/标题/90s 分组，条目数不变；摘要只由镜像正文组成。')
  console.log('- 打开 metadata_only 后：ocr_runs 应掉 >80%、write_bytes 掉到 0、metadata_events 由 0 变成每天几百。')
}
