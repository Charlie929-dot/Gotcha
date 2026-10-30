/**
 * 个人记忆 · 命令行（开发 / 验收用；不进打包产物）
 *
 *   npm run memory -- ingest [目录]
 *   npm run memory -- recall 关键词1 关键词2 [--day 2026-09-29] [--tag 工程] [--limit 8]
 *   npm run memory -- day 2026-09-29
 *   npm run memory -- items 关键词            # 浏览（按天倒序，20 一条页）
 *   npm run memory -- delete 123              # 删一条（进回收站，同步不会再带回来）
 *   npm run memory -- restore <uid>           # 撤销删除
 *   npm run memory -- profile
 *   npm run memory -- persona get
 *   npm run memory -- persona set name 小记
 *
 * 库路径：`GOTCHA_USER_DATA` 或 `%APPDATA%\Gotcha\memory.db`。
 * `ingest` 是**唯一**会建库的命令（显式动作）；其它命令库不存在就报错，不替你建。
 *
 * 为什么要经过 vite 打包（`scripts/memory.mjs`）：`src/` 是 bundler 解析的 TS，
 * 内部 import 不带扩展名，node 直接跑不了；这里只做「开发期 CLI」，不新增依赖。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { openDatabase } from '../src/db'
import { getSetting, setSetting } from '../src/db/settings'
import {
  buildMemoryProfile,
  countDeleted,
  deleteMemoryItem,
  forgetVault,
  listMemoryItems,
  listMemorySources,
  memoryStats,
  previewMemoryProfile,
  readMemoryDay,
  recallMemory,
  restoreMemoryItem,
  syncVault
} from '../src/memory/store'
import { readPersona, resolveVaultDir } from '../src/memory/persona'

function dbPath(): string {
  const userData = process.env.GOTCHA_USER_DATA?.trim()
  return join(userData !== undefined && userData !== '' ? userData : (process.env.APPDATA ?? ''), 'Gotcha', 'memory.db')
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function hhmm(ts: number): string {
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function usage(): never {
  console.log(
    [
      '用法：',
      '  npm run memory -- ingest [目录]',
      '  npm run memory -- recall <关键词...> [--day yyyy-mm-dd] [--tag 标签] [--limit N]',
      '  npm run memory -- day <yyyy-mm-dd>',
      '  npm run memory -- items [关键词]（也认 2026-09 / 2026-09-29）',
      '  npm run memory -- delete <条目 id>',
      '  npm run memory -- restore <uid>',
      '  npm run memory -- profile',
      '  npm run memory -- sources',
      '  npm run memory -- forget <目录>',
      '  npm run memory -- persona get | persona set <name|tone|redlines> <值>'
    ].join('\n')
  )
  process.exit(2)
}

const [command, ...rest] = process.argv.slice(2)
if (!command) usage()

const file = dbPath()
if (command !== 'ingest' && !existsSync(file)) {
  console.error(`库不存在：${file}（先跑一次 npm run memory -- ingest）`)
  process.exit(1)
}
if (command === 'ingest' && !existsSync(join(file, '..'))) {
  mkdirSync(join(file, '..'), { recursive: true })
}

const db = openDatabase(file)

try {
  if (command === 'ingest') {
    const dir = rest[0] ?? resolveVaultDir(db)
    if (dir === null || !existsSync(dir)) {
      console.error('找不到日记目录：传一个目录，或设置 memory.vault_dir / GOTCHA_MEMORY_VAULT')
      process.exit(1)
    }
    const result = syncVault(db, dir)
    // 记住这次用的目录：下次应用启动 / 再 ingest 都按它来（避免自动探测挑到另一个旧副本）
    setSetting(db, 'memory.vault_dir', dir)
    console.log(JSON.stringify({ dir, ...result }, null, 2))
  } else if (command === 'recall') {
    const keywords: string[] = []
    const options: { day?: string; tag?: string; limit?: number } = {}
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]
      if (token === '--day') options.day = rest[++index]
      else if (token === '--tag') options.tag = rest[++index]
      else if (token === '--limit') options.limit = Number(rest[++index])
      else keywords.push(token)
    }
    const result = recallMemory(db, { keywords, ...options, now: Date.now() })
    console.log(`# ${result.hits.length} 条（候选 ${result.candidates}，${result.mode}）`)
    for (const hit of result.hits) {
      const time = hit.ts !== null ? ` ${hhmm(hit.ts)}` : ''
      console.log(`\n[${hit.day_key}${time}] ${hit.section} · ${hit.kind} · #${hit.id}`)
      console.log(`  ${hit.text.slice(0, 200)}`)
      console.log(`  为什么：${hit.reasons.join('；')}`)
    }
  } else if (command === 'day') {
    const day = rest[0]
    if (!day) usage()
    const view = readMemoryDay(db, day)
    if (view === null) {
      console.log(`${day} 没有日记条目`)
    } else {
      console.log(view.text)
    }
  } else if (command === 'items') {
    const search = rest.join(' ').trim()
    const page = listMemoryItems(db, { search, limit: 20 })
    console.log(`# ${page.total} 条${page.hasMore ? `（只显示前 ${page.items.length} 条）` : ''}`)
    for (const item of page.items) {
      const time = item.ts !== null ? ` ${hhmm(item.ts)}` : ''
      console.log(`\n[${item.day_key}${time}] ${item.section} · ${item.kind} · #${item.id}`)
      console.log(`  ${item.text.slice(0, 200)}`)
    }
    console.log(`\n回收站：${countDeleted(db)} 条`)
  } else if (command === 'delete') {
    const id = Number(rest[0])
    if (!Number.isInteger(id) || id <= 0) usage()
    const result = deleteMemoryItem(db, id)
    if (result === null) {
      console.error(`没有这条记忆：#${rest[0]}（先 npm run memory -- items 看一眼 id）`)
      process.exit(1)
    }
    console.log(`已删除 #${id}（${result.item.day_key}）· 回收站 ${result.deleted} 条`)
    console.log(`撤销：npm run memory -- restore ${result.item.uid}`)
  } else if (command === 'restore') {
    const uid = rest[0]
    if (!uid) usage()
    const item = restoreMemoryItem(db, uid)
    if (item === null) {
      console.error('回收站里没有这条（可能已经恢复，或超出了保留上限）')
      process.exit(1)
    }
    console.log(`已恢复 ${item.day_key} 的一条（#${item.id}）`)
  } else if (command === 'profile') {
    const preview = previewMemoryProfile(db)
    console.log(JSON.stringify({ stats: preview.stats, observations: preview.observations }, null, 2))
    // 落库（观测可被后续「关于我」直接读）：只在这一条显式命令里写
    buildMemoryProfile(db)
  } else if (command === 'persona') {
    const action = rest[0]
    if (action === 'get' || action === undefined) {
      console.log(JSON.stringify(readPersona(db), null, 2))
    } else if (action === 'set') {
      const field = rest[1]
      const value = rest.slice(2).join(' ')
      if (field === 'name') setSetting(db, 'memory.persona_name', value)
      else if (field === 'tone') setSetting(db, 'memory.persona_tone', value)
      else if (field === 'redlines') setSetting(db, 'memory.persona_redlines', value)
      else usage()
      console.log(JSON.stringify(readPersona(db), null, 2))
    } else {
      usage()
    }
  } else if (command === 'sources') {
    for (const source of listMemorySources(db)) {
      console.log(`${source.items.toString().padStart(6)}  ${source.path}`)
    }
  } else if (command === 'forget') {
    const dir = rest[0]
    if (!dir) usage()
    console.log(`忘掉 ${forgetVault(db, dir)} 条`)
  } else if (command === 'stats') {
    console.log(JSON.stringify(memoryStats(db), null, 2))
  } else {
    usage()
  }
} finally {
  db.close()
}
