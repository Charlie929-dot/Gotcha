/**
 * 检索工作进程入口（Electron `utilityProcess`；性能方案 §5.11）。
 *
 * 只做三件事：收消息 → 交给 `createSearchWorkerHandler` → 回消息。
 * 这里持有一条**只读** SQLite 连接：`searchChainSegmentsBatch()` 的 LIKE 全扫
 * 在 39.7 MB 正文上要 1.1 s，跑在主进程里会把球、热键、窗口 IPC 一起卡住；
 * 换到这个进程里，主线程只等一条 IPC 回包。
 *
 * 注意：
 * - 不能 import `electron` 的业务 API（utility process 只有 `process.parentPort`）；
 * - 只读打开：不写库、不做迁移（迁移永远在主进程里跑）；
 * - 业务错误都包成 `{ok:false, code}` 回去，不 throw 到进程级。
 */

import Database from 'better-sqlite3'
import type { ChainDb } from '../chain/store'
import { createSearchWorkerHandler, type SearchResponseMessage } from '../chain/query-remote'

const port = process.parentPort

/** 按库路径懒开只读连接（主进程切库 / 迁移后不需要握手，路径变了自然会开新的） */
const connections = new Map<string, ChainDb>()

function openReadonly(dbPath: string): ChainDb {
  const existing = connections.get(dbPath)
  if (existing) return existing
  const db = new Database(dbPath, { readonly: true, fileMustExist: true }) as unknown as ChainDb
  // 主进程在写 WAL：读连接遇到 checkpoint 时等一下，不要直接 SQLITE_BUSY
  db.pragma('busy_timeout = 2000')
  connections.set(dbPath, db)
  return db
}

const handler = createSearchWorkerHandler({ open: openReadonly })

port.on('message', (event) => {
  void handler
    .handle(event.data)
    .then((response: SearchResponseMessage | null) => {
      if (response) port.postMessage(response)
    })
    .catch(() => {
      // handle 内部已把业务错误包成 ok:false；这里只剩「连回包都失败」，丢掉即可
    })
})
