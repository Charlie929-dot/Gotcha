/**
 * settings 表的小工具（不建库、不碰采集数据）。
 *
 *   npm run setting -- get capture.metadata_only
 *   npm run setting -- set capture.metadata_only 1
 *   npm run setting -- list capture.
 *
 * 库路径默认 `%APPDATA%\Gotcha\memory.db`；E2E / 隔离实例可用 `GOTCHA_USER_DATA` 指到临时目录。
 * A3 口径：库不存在就报错退出，绝不为了改一个设置去建库。
 *
 * `capture.metadata_only` / `capture.events_mirror` 由采集会话启动时读取：
 * 改完要**暂停再开始采集**（Alt+P 两次）才生效，不需要重启应用。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(new URL('../package.json', import.meta.url))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3')

const userData = process.env.GOTCHA_USER_DATA || join(process.env.APPDATA ?? '', 'Gotcha')
const dbPath = join(userData, 'memory.db')
const [command, key, value] = process.argv.slice(2)

function usage() {
  console.error('用法：npm run setting -- get <key> | set <key> <value> | list [前缀]')
  process.exit(2)
}

if (!command || !key) usage()
if (!existsSync(dbPath)) {
  console.error(`库不存在：${dbPath}（先运行一次应用；这里不替你建库）`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: command === 'get' || command === 'list' })
db.pragma('busy_timeout = 3000')
try {
  if (command === 'get') {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (!row) {
      console.log(`${key} = （未设置，用代码里的默认值）`)
    } else {
      console.log(`${key} = ${row.value}`)
    }
  } else if (command === 'set') {
    if (value === undefined) usage()
    const before = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value)
    console.log(`${key}: ${before ? `"${before.value}" → ` : '（默认）→ '}"${value}"`)
    if (key.startsWith('capture.')) {
      console.log('采集会话启动时才读这个键：暂停再开始采集（Alt+P 两次）后生效。')
    }
  } else if (command === 'list') {
    const rows = db
      .prepare('SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key')
      .all(`${key}%`)
    for (const row of rows) console.log(`${row.key} = ${row.value}`)
    if (rows.length === 0) console.log('（没有匹配的设置）')
  } else {
    usage()
  }
} finally {
  db.close()
}
